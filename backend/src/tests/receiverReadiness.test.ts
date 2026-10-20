/**
 * Quien recibe del escrow tiene que poder recibir antes de crear la operacion.
 *
 * Hallazgo del 2026-10-09 (pruebas de Raul): la cuenta `Macuin` no existia en
 * la red (Horizon 404), no tenia XLM ni trustline, y aun asi creo tres
 * depositos. Si un agente hubiera bloqueado, Raul no habria podido liberar y,
 * al vencer, el contrato le devolvia el cripto al agente con el efectivo ya
 * entregado.
 *
 *   npm run test:receiver-readiness
 */

import { strictEqual, ok, rejects } from 'assert';
import { config } from '../config.js';
import {
  evaluateReceiverAccount,
  assertReceiverCanReceive,
  setReceiverReadinessFetchForTests,
  ReceiverNotReadyError,
  RELEASE_FEE_BUFFER_XLM,
} from '../services/receiverReadiness.service.js';
import { UpstreamError } from '../utils/errors.js';

let passed = 0;
async function test(name: string, fn: () => void | Promise<void>) {
  await fn();
  passed++;
  console.log(`  ok  ${name}`);
}

function account(xlm: string, opts: { subentries?: number; usdc?: boolean; liabilities?: string } = {}) {
  const balances: any[] = [{ asset_type: 'native', balance: xlm, selling_liabilities: opts.liabilities ?? '0' }];
  if (opts.usdc) balances.unshift({ asset_type: 'credit_alphanum4', asset_code: 'USDC', balance: '0' });
  return { balances, subentry_count: opts.subentries ?? (opts.usdc ? 1 : 0) };
}

const ADDRESS = 'GCXVBZUJXP5KIPMPMCPPVOTIRFIJ4HDQH5WZ6C7AENCLAWUJKXQR3NZ2';

async function main() {
  console.log('evaluateReceiverAccount');

  await test('cuenta inexistente: no lista (el caso de Macuin)', () => {
    const r = evaluateReceiverAccount(null, 'XLM');
    strictEqual(r.ready, false);
    strictEqual(!r.ready && r.reason, 'account_not_found');
  });

  await test('XLM: cuenta con 1 XLM libre sobre la reserva esta lista', () => {
    strictEqual(evaluateReceiverAccount(account('2'), 'XLM').ready, true);
  });

  await test('XLM: cuenta justo en la reserva minima no alcanza para la comision', () => {
    const r = evaluateReceiverAccount(account('1'), 'XLM');
    strictEqual(r.ready, false);
    strictEqual(!r.ready && r.reason, 'insufficient_xlm');
    strictEqual(!r.ready && r.requiredXlm, RELEASE_FEE_BUFFER_XLM);
  });

  await test('USDC con trustline y XLM para la comision: lista', () => {
    // reserva = (2 + 1) * 0.5 = 1.5; libre = 0.2
    strictEqual(evaluateReceiverAccount(account('1.7', { usdc: true }), 'USDC').ready, true);
  });

  await test('USDC sin trustline: necesita 0.5 XLM extra para que la app la cree', () => {
    const corto = evaluateReceiverAccount(account('1.5'), 'USDC'); // libre 0.5 < 0.6
    strictEqual(corto.ready, false);
    strictEqual(!corto.ready && corto.requiredXlm, RELEASE_FEE_BUFFER_XLM + 0.5);
    strictEqual(evaluateReceiverAccount(account('1.7'), 'USDC').ready, true); // libre 0.7
  });

  await test('los selling liabilities no cuentan como XLM disponible', () => {
    strictEqual(evaluateReceiverAccount(account('2', { liabilities: '0.95' }), 'XLM').ready, false);
  });

  console.log('assertReceiverCanReceive');
  const savedMock = config.mockStellar;
  (config as any).mockStellar = false;
  try {
    await test('Horizon 404 -> 422 RECEIVER_NOT_READY con mensaje para quien pide', async () => {
      setReceiverReadinessFetchForTests(async () => ({ ok: false, status: 404, json: async () => ({}) }));
      await rejects(
        assertReceiverCanReceive({ stellarAddress: ADDRESS, assetCode: 'XLM', receiverIsCaller: true }),
        (err: any) => {
          ok(err instanceof ReceiverNotReadyError);
          strictEqual(err.code, 'RECEIVER_NOT_READY');
          strictEqual(err.httpStatus, 422);
          ok(err.userMessage.includes('Tu cuenta'));
          return true;
        },
      );
    });

    await test('el mensaje cambia cuando quien no puede recibir es el agente', async () => {
      setReceiverReadinessFetchForTests(async () => ({ ok: false, status: 404, json: async () => ({}) }));
      await rejects(
        assertReceiverCanReceive({ stellarAddress: ADDRESS, assetCode: 'USDC', receiverIsCaller: false }),
        (err: any) => err.code === 'RECEIVER_NOT_READY' && err.userMessage.includes('agente'),
      );
    });

    await test('cuenta lista -> no lanza y consulta la cuenta correcta', async () => {
      let url = '';
      setReceiverReadinessFetchForTests(async (u) => { url = u; return { ok: true, status: 200, json: async () => account('5') }; });
      await assertReceiverCanReceive({ stellarAddress: ADDRESS, assetCode: 'XLM', receiverIsCaller: true });
      ok(url.endsWith(`/accounts/${ADDRESS}`));
    });

    await test('Horizon caido -> 502 RECEIVER_CHECK_FAILED (no se crea a ciegas)', async () => {
      setReceiverReadinessFetchForTests(async () => { throw new Error('ECONNRESET'); });
      await rejects(
        assertReceiverCanReceive({ stellarAddress: ADDRESS, assetCode: 'XLM', receiverIsCaller: true }),
        (err: any) => err instanceof UpstreamError && err.code === 'RECEIVER_CHECK_FAILED' && err.httpStatus === 502,
      );
    });

    await test('Horizon 500 -> 502 RECEIVER_CHECK_FAILED', async () => {
      setReceiverReadinessFetchForTests(async () => ({ ok: false, status: 500, json: async () => ({}) }));
      await rejects(
        assertReceiverCanReceive({ stellarAddress: ADDRESS, assetCode: 'XLM', receiverIsCaller: true }),
        (err: any) => err.code === 'RECEIVER_CHECK_FAILED',
      );
    });

    await test('MOCK_STELLAR=true no consulta Horizon', async () => {
      (config as any).mockStellar = true;
      let called = false;
      setReceiverReadinessFetchForTests(async () => { called = true; return { ok: false, status: 404, json: async () => ({}) }; });
      await assertReceiverCanReceive({ stellarAddress: ADDRESS, assetCode: 'XLM', receiverIsCaller: true });
      strictEqual(called, false);
    });
  } finally {
    (config as any).mockStellar = savedMock;
    setReceiverReadinessFetchForTests(null);
  }

  await testCreateTradeIntegration();

  console.log(`\n${passed} pruebas OK`);
}

/**
 * POST /trades de punta a punta: la validacion tiene que estar conectada en
 * createTrade, antes de que exista la operacion. Corre con la base en memoria.
 */
async function testCreateTradeIntegration() {
  console.log('POST /trades');
  const { default: Fastify } = await import('fastify');
  const { default: fastifyJwt } = await import('@fastify/jwt');
  const { default: db } = await import('../db/schema.js');
  const { tradeRoutes } = await import('../routes/trades.js');
  const { AppError } = await import('../utils/errors.js');

  const app = Fastify({ logger: false });
  app.register(fastifyJwt, { secret: config.jwtSecret });
  app.setErrorHandler((error: any, _req: any, reply: any) => {
    if (error instanceof AppError) {
      reply.status(error.httpStatus).send({ code: error.code, message: error.userMessage });
      return;
    }
    reply.status(error.statusCode ?? 500).send({ code: 'ERROR', message: error.message });
  });
  app.register(tradeRoutes);
  await app.ready();

  const RUN = Math.random().toString(36).slice(2, 8).padEnd(6, '0');
  let seq = 0;
  const createUser = async () => {
    seq++;
    const suffix = `${RUN}${String(seq).padStart(3, '0')}`;
    const row = await db.getOne<{ id: string }>(
      `INSERT INTO users (stellar_address, username, phone_hash, merchant_available, availability, is_suspended, provider_status)
       VALUES ($1, $2, $3, $4, $5, $6, 'active') RETURNING id`,
      [`G${'R'.repeat(46)}${suffix}`, `rr_${suffix}`, `hash_rr_${suffix}`, true, 'online', false],
    );
    return row!.id;
  };
  const countTrades = async () => (await db.getMany('SELECT id FROM trades')).length;

  const savedMock = config.mockStellar;
  (config as any).mockStellar = false;
  try {
    await test('deposito con cuenta inexistente -> 422 y no se crea la operacion', async () => {
      const callerId = await createUser();
      const agentId = await createUser();
      const token = app.jwt.sign({ id: callerId, stellar_address: 'GCALLER' });
      setReceiverReadinessFetchForTests(async () => ({ ok: false, status: 404, json: async () => ({}) }));
      const before = await countTrades();
      const res = await app.inject({
        method: 'POST',
        url: '/trades',
        headers: { authorization: `Bearer ${token}` },
        payload: { counterparty_id: agentId, amount_mxn: 500, flow: 'deposit' },
      });
      strictEqual(res.statusCode, 422, res.body);
      strictEqual(res.json().code, 'RECEIVER_NOT_READY');
      strictEqual(await countTrades(), before);
    });

    await test('cash-out revisa al agente (buyer), no al cliente', async () => {
      const callerId = await createUser();
      const agentId = await createUser();
      const agent = await db.getOne<{ stellar_address: string }>('SELECT stellar_address FROM users WHERE id = $1', [agentId]);
      const token = app.jwt.sign({ id: callerId, stellar_address: 'GCALLER' });
      let checked = '';
      setReceiverReadinessFetchForTests(async (u) => { checked = u; return { ok: false, status: 404, json: async () => ({}) }; });
      const res = await app.inject({
        method: 'POST',
        url: '/trades',
        headers: { authorization: `Bearer ${token}` },
        payload: { counterparty_id: agentId, amount_mxn: 500, flow: 'cashout' },
      });
      strictEqual(res.json().code, 'RECEIVER_NOT_READY', res.body);
      ok(res.json().message.includes('agente'));
      ok(checked.endsWith(`/accounts/${agent!.stellar_address}`));
    });
  } finally {
    (config as any).mockStellar = savedMock;
    setReceiverReadinessFetchForTests(null);
    await app.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
