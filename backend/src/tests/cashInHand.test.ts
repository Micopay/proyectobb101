/**
 * H5 · "efectivo en mano" (docs/PLAN_COMISIONES_EFECTIVO_2026-09-24.md).
 *
 * El monto que escribe la persona es el efectivo que cambia de mano. El
 * contrato solo conoce `amount` (lo que recibe el comprador del escrow) y
 * `platform_fee`, asi que la comision del agente viaja dentro de `amount`:
 *
 *   retiro:   amount = monto + agente               (el cliente bloquea monto + agente + plataforma)
 *   deposito: amount = monto - agente - plataforma  (el agente bloquea monto - agente)
 *
 * Fija las cifras por flujo, las propiedades sobre una tabla de montos y
 * tarifas, y que `createTrade` guarde `amount_stroops` = conversion de
 * `escrow_amount_mxn` con `fee_model = cash_in_hand`.
 *
 * Corre en memoria o contra PostgreSQL (DATABASE_URL). Crear operaciones
 * consulta la tasa XLM/MXN viva, igual que tradeFlow.test.ts.
 */
import Fastify from 'fastify';
import fastifyJwt from '@fastify/jwt';
import { strictEqual, ok } from 'assert';
import db, { pool } from '../db/schema.js';
import { config } from '../config.js';
import { tradeRoutes } from '../routes/trades.js';
import { cashBreakdownForTrade } from '../services/trade.service.js';
import { computeTradeFees } from '../services/tradeFees.js';
import { stroopsAtFrozenRate } from '../services/assetRate.service.js';
import { AppError } from '../utils/errors.js';

function testExampleFromThePlan() {
  // $500, agente 1.5% ($8), plataforma 0.8% ($4).
  const c = computeTradeFees(500, 1.5, 'cashout');
  strictEqual(c.providerFeeMxn, 8);
  strictEqual(c.platformFeeMxn, 4);
  strictEqual(c.clientReceivesMxn, 500, 'retiro: el cliente recibe los $500 en billetes');
  strictEqual(c.clientPaysMxn, 512, 'retiro: las comisiones van encima');
  strictEqual(c.escrowAmountMxn, 508, 'retiro: el agente recibe lo que entrega mas su comision');
  strictEqual(c.sellerLocksMxn, 512);
  strictEqual(c.payoutMxn, 500);

  const d = computeTradeFees(500, 1.5, 'deposit');
  strictEqual(d.clientPaysMxn, 500, 'deposito: el cliente entrega los $500 en billetes');
  strictEqual(d.clientReceivesMxn, 488, 'deposito: las comisiones se descuentan');
  strictEqual(d.escrowAmountMxn, 488);
  strictEqual(d.sellerLocksMxn, 492, 'deposito: el agente bloquea 492 y recibe 500 en billetes');
  strictEqual(d.payoutMxn, 488);
  console.log('  ✓ el ejemplo del plan: retiro 500/512/508 y deposito 500/488/492');
}

function testPropertiesOverAGrid() {
  let n = 0;
  for (const amount of [100, 137, 500, 999, 2500, 10000, 50000]) {
    for (const rate of [0, 0.3, 1, 1.5, 3]) {
      for (const flow of ['cashout', 'deposit'] as const) {
        n++;
        const f = computeTradeFees(amount, rate, flow);
        const tag = `${flow} ${amount} @${rate}%`;
        strictEqual(f.sellerLocksMxn, f.escrowAmountMxn + f.platformFeeMxn, `${tag}: bloqueado = comprador + plataforma`);
        if (flow === 'cashout') {
          // El agente entrega `amount` en billetes y recibe `escrowAmountMxn`.
          strictEqual(f.escrowAmountMxn - amount, f.providerFeeMxn, `${tag}: neto del agente = su comision`);
          strictEqual(f.clientReceivesMxn, amount, `${tag}: efectivo = monto`);
          strictEqual(f.clientPaysMxn, f.sellerLocksMxn, `${tag}: el cliente paga lo que bloquea`);
        } else {
          // El agente recibe `amount` en billetes y bloquea `sellerLocksMxn`.
          strictEqual(amount - f.sellerLocksMxn, f.providerFeeMxn, `${tag}: neto del agente = su comision`);
          strictEqual(f.clientPaysMxn, amount, `${tag}: efectivo = monto`);
          strictEqual(f.clientReceivesMxn, f.escrowAmountMxn, `${tag}: recibe lo que libera el escrow`);
        }
        ok(f.escrowAmountMxn >= 1, `${tag}: el contrato no acepta amount <= 0`);
      }
    }
  }
  console.log(`  ✓ propiedades sobre ${n} combinaciones de monto, tarifa y flujo`);
}

function testDefaultFlowIsDeposit() {
  strictEqual(computeTradeFees(500, 1.5).clientReceivesMxn, computeTradeFees(500, 1.5, 'deposit').clientReceivesMxn);
  console.log('  ✓ sin flujo se asume deposito');
}

function testBreakdownOnlyForCashInHand() {
  const base = { amount_mxn: 500, provider_fee_mxn: 5, platform_fee_mxn: 4 };
  const legacy = cashBreakdownForTrade({ ...base, flow: 'cashout', fee_model: 'amount_is_escrow', escrow_amount_mxn: null });
  strictEqual(legacy.client_pays_mxn, null, 'una operacion anterior no se lee con el modelo nuevo');
  const c = cashBreakdownForTrade({ ...base, flow: 'cashout', fee_model: 'cash_in_hand', escrow_amount_mxn: 505 });
  strictEqual(c.client_pays_mxn, 509);
  strictEqual(c.client_receives_mxn, 500);
  const d = cashBreakdownForTrade({ ...base, flow: 'deposit', fee_model: 'cash_in_hand', escrow_amount_mxn: 491 });
  strictEqual(d.client_pays_mxn, 500);
  strictEqual(d.client_receives_mxn, 491);
  console.log('  ✓ el desglose del cliente sale del servidor, solo para cash_in_hand');
}

async function buildTestApp() {
  const app = Fastify({ logger: false });
  app.register(fastifyJwt, { secret: config.jwtSecret });
  app.setErrorHandler((error: any, _request: any, reply: any) => {
    if (error instanceof AppError) {
      reply.status(error.httpStatus).send({ code: error.code, message: error.userMessage });
      return;
    }
    reply.status(error.statusCode ?? 500).send({ code: 'ERROR', message: error.message });
  });
  app.register(tradeRoutes);
  await app.ready();
  return app;
}

const RUN = Math.random().toString(36).slice(2, 8);
let seq = 0;
async function createUser(label: string, ratePercent?: number): Promise<string> {
  seq++;
  const suffix = `${RUN}${String(seq).padStart(2, '0')}`;
  const row = await db.getOne<{ id: string }>(
    `INSERT INTO users (stellar_address, username, phone_hash, merchant_available, availability, is_suspended, provider_status)
     VALUES ($1, $2, $3, $4, $5, $6, 'active')
     RETURNING id`,
    [`G${'H'.repeat(47)}${suffix}`, `h5_${label}_${suffix}`, `hash_h5_${label}_${suffix}`, true, 'online', false],
  );
  if (ratePercent !== undefined) {
    await db.execute(
      `INSERT INTO merchant_configs (user_id, rate_percent, min_trade_mxn, max_trade_mxn, daily_cap_mxn, updated_at)
       VALUES ($1, $2, 100, 50000, 250000, NOW())`,
      [row!.id, ratePercent],
    );
  }
  return row!.id;
}

async function testCreatePersistsEscrowAmount(app: any, flow: 'cashout' | 'deposit') {
  const callerId = await createUser(`${flow}_caller`);
  const providerId = await createUser(`${flow}_provider`, 1.5);
  const token = app.jwt.sign({ id: callerId, stellar_address: 'GCALLER' });
  const res = await app.inject({
    method: 'POST',
    url: '/trades',
    headers: { authorization: `Bearer ${token}` },
    payload: { counterparty_id: providerId, amount_mxn: 500, flow },
  });
  strictEqual(res.statusCode, 201, `${flow}: ${res.statusCode} ${res.body}`);
  const t = res.json().trade;
  const expected = computeTradeFees(500, 1.5, flow);
  strictEqual(t.fee_model, 'cash_in_hand');
  strictEqual(Number(t.escrow_amount_mxn), expected.escrowAmountMxn, `${flow}: escrow_amount_mxn`);
  strictEqual(Number(t.payout_mxn), expected.clientReceivesMxn, `${flow}: payout_mxn = lo que recibe el cliente`);
  strictEqual(
    String(t.amount_stroops),
    stroopsAtFrozenRate(expected.escrowAmountMxn, String(t.rate_mxn)).toString(),
    `${flow}: amount_stroops = conversion de escrow_amount_mxn, no del monto escrito`,
  );
  strictEqual(t.client_pays_mxn, expected.clientPaysMxn);
  strictEqual(t.client_receives_mxn, expected.clientReceivesMxn);
  console.log(`  ✓ ${flow}: createTrade guarda escrow_amount_mxn=${expected.escrowAmountMxn} y lo convierte`);
}

async function run() {
  console.log('H5 · efectivo en mano');
  testExampleFromThePlan();
  testPropertiesOverAGrid();
  testDefaultFlowIsDeposit();
  testBreakdownOnlyForCashInHand();
  const app = await buildTestApp();
  try {
    await testCreatePersistsEscrowAmount(app, 'cashout');
    await testCreatePersistsEscrowAmount(app, 'deposit');
    console.log('\nAll cash-in-hand tests passed.\n');
  } finally {
    await app.close();
    await pool?.end();
  }
}

run().catch((err) => {
  console.error('\n✗', err?.message ?? err);
  process.exit(1);
});
