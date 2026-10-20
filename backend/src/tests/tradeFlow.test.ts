/**
 * CASH-1 (#372) — Canonical trade flow and liquidity-provider identity.
 *
 * `trades` used to store only escrow roles (seller_id/buyer_id). Those reverse
 * between deposit and cash-out, so consumers could not tell the product flow
 * apart and the code guessed that seller_id is always the Red MicoPay provider —
 * false for cash-out. These tests pin the replacement:
 *
 *   - a deposit persists flow='deposit' and provider_id = seller_id
 *   - a cash-out persists flow='cashout' and provider_id = buyer_id
 *   - the API refuses a missing or invalid flow
 *   - a client-supplied provider_id cannot influence the stored value
 *   - self-trades are still rejected
 *   - the derivation rule has exactly one definition (deriveProviderId)
 *
 * Runs against the in-memory DB (ALLOW_IN_MEMORY_DB=true, no PostgreSQL needed).
 *
 * SCOPE LIMIT — read before trusting this file: the in-memory store in
 * src/db/schema.ts is a regex shim with no schema, so it cannot enforce
 * chk_trades_flow_provider. The database-level rejection of an inconsistent
 * flow/provider/escrow-role row is therefore NOT covered here and has to be
 * proven against real PostgreSQL; same for the migration's abort path. What is
 * covered here is every layer above the database.
 */

import Fastify from 'fastify';
import fastifyJwt from '@fastify/jwt';
import { strictEqual, ok } from 'assert';
import db from '../db/schema.js';
import { config } from '../config.js';
import { tradeRoutes } from '../routes/trades.js';
import { deriveProviderId } from '../services/trade.service.js';
import { AppError } from '../utils/errors.js';

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

let seq = 0;
async function createUser(label: string): Promise<string> {
  seq++;
  const suffix = String(seq).padStart(2, '0');
  // RED-1: los proveedores se dan de alta explicitamente. Desde que pertenecer
  // a Red MicoPay es un estado propio, crear una cuenta "disponible" ya no la
  // convierte en proveedora: esa inferencia era justo el defecto.
  const row = await db.getOne<{ id: string }>(
    `INSERT INTO users (stellar_address, username, phone_hash, merchant_available, availability, is_suspended, provider_status)
     VALUES ($1, $2, $3, $4, $5, $6, 'active')
     RETURNING id`,
    [
      `G${'C'.repeat(53)}${suffix}`,
      `cash1_${label}_${suffix}`,
      `hash_cash1_${label}_${suffix}`,
      true,
      'online',
      false,
    ],
  );
  if (!row?.id) throw new Error(`Failed to seed user ${label}`);
  return row.id;
}

async function post(app: any, token: string, body: unknown) {
  return app.inject({
    method: 'POST',
    url: '/trades',
    headers: { authorization: `Bearer ${token}` },
    payload: body,
  });
}

/**
 * A deposit: the caller buys crypto with cash. The counterparty locks the
 * funds as escrow seller and is the Red MicoPay provider.
 */
async function testDepositPersistsFlowAndProvider(app: any) {
  const callerId = await createUser('dep_caller');
  const providerId = await createUser('dep_provider');
  const token = app.jwt.sign({ id: callerId, stellar_address: 'GCALLER' });

  const res = await post(app, token, {
    counterparty_id: providerId,
    amount_mxn: 500,
    flow: 'deposit',
  });
  strictEqual(res.statusCode, 201, `deposit must be created (got ${res.statusCode}: ${res.body})`);

  const trade = res.json().trade;
  strictEqual(trade.flow, 'deposit', 'flow must persist as deposit');
  strictEqual(trade.provider_id, providerId, 'deposit provider must be the counterparty');
  strictEqual(trade.seller_id, providerId, 'deposit: counterparty is the escrow seller');
  strictEqual(trade.buyer_id, callerId, 'deposit: caller is the escrow buyer');
  strictEqual(trade.provider_id, trade.seller_id, 'deposit: provider_id == seller_id');
  console.log('  ✓ deposit persists flow=deposit and provider_id = seller_id');
}

/**
 * A cash-out: the caller sells crypto for cash. The caller must be the escrow
 * seller (only sellers lock funds and reveal the secret), so the provider is
 * the escrow BUYER — the case the old seller_id guess got wrong.
 */
async function testCashoutPersistsFlowAndProvider(app: any) {
  const callerId = await createUser('cash_caller');
  const providerId = await createUser('cash_provider');
  const token = app.jwt.sign({ id: callerId, stellar_address: 'GCALLER' });

  const res = await post(app, token, {
    counterparty_id: providerId,
    amount_mxn: 500,
    flow: 'cashout',
  });
  strictEqual(res.statusCode, 201, `cashout must be created (got ${res.statusCode}: ${res.body})`);

  const trade = res.json().trade;
  strictEqual(trade.flow, 'cashout', 'flow must persist as cashout');
  strictEqual(trade.provider_id, providerId, 'cashout provider must be the counterparty');
  strictEqual(trade.seller_id, callerId, 'cashout: caller is the escrow seller');
  strictEqual(trade.buyer_id, providerId, 'cashout: counterparty is the escrow buyer');
  strictEqual(trade.provider_id, trade.buyer_id, 'cashout: provider_id == buyer_id');
  ok(trade.provider_id !== trade.seller_id, 'cashout: provider is NOT the seller — the bug this issue fixes');
  console.log('  ✓ cashout persists flow=cashout and provider_id = buyer_id');
}

/** The API must refuse a request that does not state its flow. */
async function testMissingFlowRejected(app: any) {
  const callerId = await createUser('noflow_caller');
  const providerId = await createUser('noflow_provider');
  const token = app.jwt.sign({ id: callerId, stellar_address: 'GCALLER' });

  const res = await post(app, token, { counterparty_id: providerId, amount_mxn: 500 });
  strictEqual(res.statusCode, 400, `missing flow must be rejected (got ${res.statusCode})`);
  console.log('  ✓ missing flow is rejected with 400');
}

/** An unknown flow value must not reach the database. */
async function testInvalidFlowRejected(app: any) {
  const callerId = await createUser('badflow_caller');
  const providerId = await createUser('badflow_provider');
  const token = app.jwt.sign({ id: callerId, stellar_address: 'GCALLER' });

  const res = await post(app, token, {
    counterparty_id: providerId,
    amount_mxn: 500,
    flow: 'legacy',
  });
  strictEqual(res.statusCode, 400, `invalid flow must be rejected (got ${res.statusCode})`);
  console.log('  ✓ invalid flow value is rejected with 400');
}

/**
 * The forged-identity case. A client that tries to name the provider itself
 * must not be able to influence the stored value.
 *
 * Note on the mechanism: Fastify compiles `additionalProperties: false` with
 * ajv's `removeAdditional`, so an unknown body field is STRIPPED before the
 * handler runs rather than producing a 400. The request therefore succeeds and
 * the forged id is simply gone — which is the "ignores" half of the issue's
 * "ignores or rejects client-supplied provider IDs". What this test pins is the
 * property that actually matters: the persisted provider_id is the one derived
 * from the authenticated caller, and nothing is ever written under the id the
 * client asked for.
 */
async function testForgedProviderIdIgnored(app: any) {
  const callerId = await createUser('forge_caller');
  const providerId = await createUser('forge_provider');
  const attackerId = await createUser('forge_attacker');
  const token = app.jwt.sign({ id: callerId, stellar_address: 'GCALLER' });

  const res = await post(app, token, {
    counterparty_id: providerId,
    amount_mxn: 500,
    flow: 'deposit',
    provider_id: attackerId,
  });
  strictEqual(res.statusCode, 201, `request is accepted with the field stripped (got ${res.statusCode}: ${res.body})`);

  const trade = res.json().trade;
  strictEqual(trade.provider_id, providerId, 'stored provider_id must be the server-derived one');
  ok(trade.provider_id !== attackerId, 'the forged provider_id must not survive');

  // And nothing was written under the attacker's identity.
  const forged = await db.getMany('SELECT id FROM trades WHERE provider_id = $1', [attackerId]);
  strictEqual(forged.length, 0, 'no trade may exist with the forged provider_id');
  console.log('  ✓ client-supplied provider_id is stripped and never persisted');
}

/** Self-trades stay rejected — now via the flow-derived participants. */
async function testSelfTradeRejected(app: any) {
  const callerId = await createUser('self_caller');
  const token = app.jwt.sign({ id: callerId, stellar_address: 'GCALLER' });

  const res = await post(app, token, {
    counterparty_id: callerId,
    amount_mxn: 500,
    flow: 'deposit',
  });
  ok(res.statusCode >= 400, `self-trade must be rejected (got ${res.statusCode})`);
  console.log('  ✓ self-trade is rejected');
}

/**
 * The derivation rule has one definition, and it matches the database
 * constraint chk_trades_flow_provider. If someone changes one side, this
 * fails before the mismatch reaches Postgres.
 */
function testDeriveProviderIdRule() {
  strictEqual(deriveProviderId('deposit', 'seller-1', 'buyer-1'), 'seller-1', 'deposit -> seller');
  strictEqual(deriveProviderId('cashout', 'seller-1', 'buyer-1'), 'buyer-1', 'cashout -> buyer');
  console.log('  ✓ deriveProviderId matches chk_trades_flow_provider');
}

async function main() {
  console.log('\n  CASH-1 (#372) canonical flow + provider identity:\n');
  const app = await buildTestApp();
  testDeriveProviderIdRule();
  await testDepositPersistsFlowAndProvider(app);
  await testCashoutPersistsFlowAndProvider(app);
  await testMissingFlowRejected(app);
  await testInvalidFlowRejected(app);
  await testForgedProviderIdIgnored(app);
  await testSelfTradeRejected(app);
  await app.close();
  console.log('\nAll CASH-1 trade flow tests passed.\n');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
