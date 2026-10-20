/**
 * WP-A del plan de selector de activo (docs/PLAN_SELECTOR_ACTIVO_2026-09-14.md).
 *
 * El escrow desplegado solo bloquea XLM. La aritmetica ya sabe convertir USDC y
 * MXNE (`isSupportedAsset`), asi que sin una politica aparte una operacion en
 * USDC se crearia con montos correctos y luego se intentaria bloquear en el
 * contrato del XLM nativo. Estos tests fijan esa politica:
 *
 *   - al CREAR: ausente -> XLM; forma invalida -> 400; activo sin escrow -> 422;
 *   - el tipo ORIGINAL se valida antes de que ajv (`coerceTypes`) convierta 123
 *     en "123" o null en "";
 *   - el guard del servicio es la primera instruccion (llamada directa);
 *   - al BLOQUEAR, en `prepareLockTrade` y en `lockTrade`: 409
 *     ASSET_ESCROW_MISMATCH, sin default para registros incompletos y sin llegar
 *     a Stellar, tanto en mock como con MOCK_STELLAR=false;
 *   - la respuesta expone monto, comision y total retenido en stroops, y
 *     total = monto + comision exacto.
 *
 * Corre en memoria (`npm run test:trade-asset`) y tambien contra PostgreSQL si
 * hay DATABASE_URL; ahi el caso `asset_code = null` lo impide la columna NOT NULL.
 *
 * LIMITE: el store en memoria omite la transaccion CASH-10
 * (trade.service.ts, rama `if (client)`). Que un 422 no deje volumen reservado
 * NO se prueba aqui: ver tradeAssetPg.test.ts.
 *
 * Crear operaciones consulta la tasa XLM/MXN viva, igual que tradeFlow.test.ts.
 */

import Fastify from 'fastify';
import fastifyJwt from '@fastify/jwt';
import { strictEqual, ok } from 'assert';
import db, { pool } from '../db/schema.js';
import { config } from '../config.js';
import { tradeRoutes } from '../routes/trades.js';
import { createTrade, escrowAmountsForTrade } from '../services/trade.service.js';
import { AssetNotEnabledError } from '../services/assetRate.service.js';
import { AppError } from '../utils/errors.js';

async function buildTestApp() {
  const app = Fastify({ logger: false });
  app.register(fastifyJwt, { secret: config.jwtSecret });
  app.setErrorHandler((error: any, _request: any, reply: any) => {
    if (error instanceof AppError) {
      reply.status(error.httpStatus).send({ code: error.code, message: error.userMessage });
      return;
    }
    if (error.validation) {
      reply.status(400).send({ code: 'VALIDATION_ERROR', message: error.message });
      return;
    }
    reply.status(error.statusCode ?? 500).send({ code: 'ERROR', message: error.message });
  });
  app.register(tradeRoutes);
  await app.ready();
  return app;
}

// Unico por corrida: contra PostgreSQL `stellar_address` es UNIQUE y
// `username` es VARCHAR(30), asi que la etiqueta no entra en ninguno de los dos.
const RUN = Math.random().toString(36).slice(2, 8).padEnd(6, '0');
let seq = 0;
async function createUser(label: string): Promise<string> {
  seq++;
  const suffix = `${RUN}${String(seq).padStart(3, '0')}`;
  const row = await db.getOne<{ id: string }>(
    `INSERT INTO users (stellar_address, username, phone_hash, merchant_available, availability, is_suspended, provider_status)
     VALUES ($1, $2, $3, $4, $5, $6, 'active')
     RETURNING id`,
    // 1 + 46 + 9 = 56, el largo exacto de una direccion Stellar.
    [`G${'D'.repeat(46)}${suffix}`, `wpa_${suffix}`, `hash_wpa_${label}_${suffix}`, true, 'online', false],
  );
  if (!row?.id) throw new Error(`Failed to seed user ${label}`);
  return row.id;
}

async function countTrades(): Promise<number> {
  return (await db.getMany('SELECT id FROM trades')).length;
}

function post(app: any, token: string, url: string, body: unknown) {
  return app.inject({ method: 'POST', url, headers: { authorization: `Bearer ${token}` }, payload: body as any });
}

type Flow = 'deposit' | 'cashout';

async function pair(label: string, flow: Flow) {
  const callerId = await createUser(`${label}_caller`);
  const counterpartyId = await createUser(`${label}_cp`);
  return { callerId, counterpartyId, flow };
}

// ---------------------------------------------------------------------------
// Creacion por HTTP
// ---------------------------------------------------------------------------

async function testCreateAccepted(app: any, flow: Flow) {
  for (const [label, asset_code] of [['absent', undefined], ['upper', 'XLM'], ['lower', ' xlm ']] as const) {
    const { callerId, counterpartyId } = await pair(`ok_${flow}_${label}`, flow);
    const token = app.jwt.sign({ id: callerId, stellar_address: 'GCALLER' });
    const body: Record<string, unknown> = { counterparty_id: counterpartyId, amount_mxn: 500, flow };
    if (asset_code !== undefined) body.asset_code = asset_code;

    const res = await post(app, token, '/trades', body);
    strictEqual(res.statusCode, 201, `${flow}/${label}: expected 201, got ${res.statusCode}: ${res.body}`);
    const trade = res.json().trade;
    strictEqual(trade.asset_code, 'XLM', `${flow}/${label}: persisted asset must be normalized XLM`);

    // D9: tres cifras en cadenas enteras, y total = monto + comision exacto.
    for (const k of ['amount_stroops', 'platform_fee_stroops', 'total_locked_stroops']) {
      ok(typeof trade[k] === 'string' && /^\d+$/.test(trade[k]), `${flow}/${label}: ${k} must be an integer string, got ${trade[k]}`);
    }
    strictEqual(
      BigInt(trade.total_locked_stroops),
      BigInt(trade.amount_stroops) + BigInt(trade.platform_fee_stroops),
      `${flow}/${label}: total must equal amount + fee`,
    );
    ok(BigInt(trade.platform_fee_stroops) > 0n, `${flow}/${label}: a 500 MXN trade carries a platform fee`);
  }
  console.log(`  ✓ ${flow}: absent / "XLM" / " xlm " create XLM trades with amount+fee=total`);
}

async function testCreateRejected(app: any, flow: Flow) {
  const cases: Array<[string, unknown, number, string]> = [
    ['USDC', 'USDC', 422, 'ASSET_NOT_ENABLED'],
    ['MXNE', 'mxne', 422, 'ASSET_NOT_ENABLED'],
    ['unknown', 'FOO', 422, 'ASSET_NOT_ENABLED'],
    // Tipos: sin el preValidation, ajv convertiria 123 -> "123" y null -> ""
    // y la respuesta dependeria de la coercion, no del contrato.
    ['number', 123, 400, 'INVALID_ASSET_CODE'],
    ['null', null, 400, 'INVALID_ASSET_CODE'],
    ['boolean', true, 400, 'INVALID_ASSET_CODE'],
    ['object', { code: 'XLM' }, 400, 'INVALID_ASSET_CODE'],
    ['array', ['XLM'], 400, 'INVALID_ASSET_CODE'],
    ['empty', '', 400, 'INVALID_ASSET_CODE'],
    ['blank', '   ', 400, 'INVALID_ASSET_CODE'],
    ['too long', 'X'.repeat(13), 400, 'INVALID_ASSET_CODE'],
    // H6: la longitud es la de la entrada cruda, no la recortada.
    ['padded past the limit', `${' '.repeat(10)}XLM`, 400, 'INVALID_ASSET_CODE'],
  ];

  for (const [label, asset_code, status, code] of cases) {
    const { callerId, counterpartyId } = await pair(`bad_${flow}_${label.replace(' ', '_')}`, flow);
    const token = app.jwt.sign({ id: callerId, stellar_address: 'GCALLER' });
    const before = await countTrades();

    const res = await post(app, token, '/trades', { counterparty_id: counterpartyId, amount_mxn: 500, flow, asset_code });
    strictEqual(res.statusCode, status, `${flow}/${label}: expected ${status}, got ${res.statusCode}: ${res.body}`);
    strictEqual(res.json().code, code, `${flow}/${label}: expected code ${code}, got ${res.body}`);
    strictEqual(await countTrades(), before, `${flow}/${label}: no trade row may be inserted`);
  }
  console.log(`  ✓ ${flow}: disabled assets -> 422, wrong type/empty/long -> 400, nothing inserted`);
}

// ---------------------------------------------------------------------------
// Llamada directa al servicio
// ---------------------------------------------------------------------------

/**
 * El guard es la PRIMERA instruccion. Se pasa ademas un flujo invalido, un monto
 * fuera de rango, participantes inexistentes y un `request` que revienta al
 * primer acceso: si cualquier otra comprobacion o efecto corriera antes, el
 * error seria otro.
 */
async function testDirectServiceGuardRunsFirst() {
  const exploding = new Proxy({}, {
    get() { throw new Error('request was touched before the asset guard'); },
  }) as any;
  const before = await countTrades();

  for (const [assetCode, expected] of [
    ['USDC', 'AssetNotEnabledError'],
    [123, 'INVALID_ASSET_CODE'],
    // H6: una llamada directa tampoco acepta un codigo que excede el limite con espacios.
    [`${' '.repeat(10)}XLM`, 'INVALID_ASSET_CODE'],
  ] as const) {
    try {
      await createTrade({
        request: exploding,
        sellerId: 'nope-seller',
        buyerId: 'nope-seller',
        flow: 'bogus' as any,
        amountMxn: 1,
        assetCode,
      });
      throw new Error(`direct createTrade with ${String(assetCode)} did not throw`);
    } catch (err: any) {
      if (expected === 'AssetNotEnabledError') {
        ok(err instanceof AssetNotEnabledError, `USDC: expected AssetNotEnabledError, got ${err?.message}`);
        strictEqual(err.httpStatus, 422);
      } else {
        ok(err instanceof AppError && err.code === expected, `${JSON.stringify(assetCode)}: expected ${expected}, got ${err?.message}`);
        strictEqual(err.httpStatus, 400);
      }
    }
  }
  strictEqual(await countTrades(), before, 'direct calls must not insert');
  console.log('  ✓ direct createTrade: asset guard runs before any other check or effect');
}

// ---------------------------------------------------------------------------
// Bloqueo
// ---------------------------------------------------------------------------

async function insertPendingTrade(sellerId: string, buyerId: string, assetCode: string | null): Promise<string> {
  seq++;
  const row = await db.getOne<{ id: string }>(
    `INSERT INTO trades
       (seller_id, buyer_id, flow, provider_id, amount_mxn, amount_stroops, platform_fee_mxn,
        asset_code, rate_mxn, secret_hash, status, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     RETURNING id`,
    [
      sellerId, buyerId, 'cashout', buyerId, 500, '1532267000', 4,
      assetCode, '3.2632550', `h_wpa_${seq}_${Date.now()}`, 'pending',
      new Date(Date.now() + 2 * 60 * 60 * 1000),
    ],
  );
  if (!row?.id) throw new Error('Failed to insert trade');
  return row.id;
}

async function assertStillPending(tradeId: string, label: string) {
  const row = await db.getOne<{ status: string; lock_tx_hash: string | null }>(
    'SELECT status, lock_tx_hash FROM trades WHERE id = $1',
    [tradeId],
  );
  strictEqual(row?.status, 'pending', `${label}: trade must stay pending`);
  ok(!row?.lock_tx_hash, `${label}: no lock tx hash may be recorded`);
}

async function testLocksRejectIncoherentAsset(app: any) {
  const originalMock = config.mockStellar;
  try {
    for (const mock of [true, false]) {
      (config as any).mockStellar = mock;
      // 'xlm' en minusculas tambien es incoherente: la creacion siempre
      // persiste el codigo normalizado. null y '' no se completan con XLM.
      // En PostgreSQL `asset_code` es NOT NULL y la fila con null ni se puede
      // insertar: ahi el caso lo cubre la base, y aqui solo se prueba en memoria.
      const assetCodes: Array<string | null> = pool ? ['USDC', 'MXNE', 'xlm', ''] : ['USDC', 'MXNE', 'xlm', '', null];
      for (const assetCode of assetCodes) {
        const label = `mock=${mock} asset=${JSON.stringify(assetCode)}`;
        const sellerId = await createUser('lock_seller');
        const buyerId = await createUser('lock_buyer');
        const tradeId = await insertPendingTrade(sellerId, buyerId, assetCode);
        const token = app.jwt.sign({ id: sellerId, stellar_address: 'GSELLER' });

        // Sin el guard, con mock=false prepare fallaria mas tarde por otra
        // causa (direcciones de prueba sin checksum -> 422) y lock sin XDR
        // daria 400 SIGNED_XDR_REQUIRED; con mock=true prepare devolveria
        // { mock: true } y lock marcaria la operacion como bloqueada. El 409
        // exacto demuestra que no se llego a ninguno de esos caminos.
        const prep = await post(app, token, `/trades/${tradeId}/lock/prepare`, {});
        strictEqual(prep.statusCode, 409, `prepare ${label}: expected 409, got ${prep.statusCode}: ${prep.body}`);
        strictEqual(prep.json().code, 'ASSET_ESCROW_MISMATCH', `prepare ${label}: ${prep.body}`);

        const lock = await post(app, token, `/trades/${tradeId}/lock`, {});
        strictEqual(lock.statusCode, 409, `lock ${label}: expected 409, got ${lock.statusCode}: ${lock.body}`);
        strictEqual(lock.json().code, 'ASSET_ESCROW_MISMATCH', `lock ${label}: ${lock.body}`);

        await assertStillPending(tradeId, label);
      }
    }
  } finally {
    (config as any).mockStellar = originalMock;
  }
  console.log(`  ✓ prepareLockTrade and lockTrade -> 409 ASSET_ESCROW_MISMATCH (USDC, MXNE, "xlm", ""${pool ? '' : ', null'}; mock and real)`);
}

/** Control: el guard no bloquea lo que si es valido. */
async function testLockAcceptsXlm(app: any) {
  const originalMock = config.mockStellar;
  (config as any).mockStellar = true;
  try {
    const sellerId = await createUser('lockok_seller');
    const buyerId = await createUser('lockok_buyer');
    const tradeId = await insertPendingTrade(sellerId, buyerId, 'XLM');
    const token = app.jwt.sign({ id: sellerId, stellar_address: 'GSELLER' });
    const prep = await post(app, token, `/trades/${tradeId}/lock/prepare`, {});
    strictEqual(prep.statusCode, 200, `prepare XLM: expected 200, got ${prep.statusCode}: ${prep.body}`);
    strictEqual(prep.json().mock, true);
  } finally {
    (config as any).mockStellar = originalMock;
  }
  console.log('  ✓ control: an XLM trade still reaches the lock path');
}

// ---------------------------------------------------------------------------
// Cifras
// ---------------------------------------------------------------------------

function testEscrowAmountsIncompleteRecords() {
  const nulls = { amount_stroops: null, platform_fee_stroops: null, total_locked_stroops: null };
  const base = { asset_code: 'XLM', amount_stroops: '1532267000', platform_fee_mxn: 4, rate_mxn: '3.2632550' };

  for (const [label, patch] of [
    ['asset null', { asset_code: null }],
    ['asset empty', { asset_code: '' }],
    ['no stroops', { amount_stroops: null }],
    ['no rate', { rate_mxn: undefined }],
  ] as const) {
    const got = escrowAmountsForTrade({ ...base, ...patch });
    strictEqual(JSON.stringify(got), JSON.stringify(nulls), `${label}: must not guess, got ${JSON.stringify(got)}`);
  }

  const full = escrowAmountsForTrade(base);
  // 4 MXN a 3.2632550: (4 * 10^14 + 32632550 / 2) / 32632550 = 12257700
  strictEqual(full.platform_fee_stroops, '12257700');
  strictEqual(full.total_locked_stroops, (1532267000n + 12257700n).toString());
  console.log('  ✓ escrowAmountsForTrade: exact BigInt total; nulls for incomplete records');
}

async function run() {
  console.log('\nWP-A · trade asset policy\n');
  const app = await buildTestApp();
  try {
    testEscrowAmountsIncompleteRecords();
    await testDirectServiceGuardRunsFirst();
    for (const flow of ['deposit', 'cashout'] as const) {
      await testCreateAccepted(app, flow);
      await testCreateRejected(app, flow);
    }
    await testLocksRejectIncoherentAsset(app);
    await testLockAcceptsXlm(app);
    console.log('\nAll WP-A trade asset tests passed.\n');
  } finally {
    await app.close();
    await pool?.end();
  }
}

run().catch((err) => {
  console.error('\n✗', err?.message ?? err);
  process.exit(1);
});
