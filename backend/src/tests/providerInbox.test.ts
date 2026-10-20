/**
 * CASH-3 — La bandeja del proveedor tiene que traer los DOS flujos.
 *
 * `getMerchantTrades` filtraba por `seller_id`. En deposito ese es el
 * proveedor, pero en cash-out el vendedor del escrow es el CLIENTE: el
 * proveedor no veia ni una sola solicitud de cash-out. Es el flujo donde tiene
 * que salir de lo que este haciendo para entregar efectivo, asi que el que no
 * llegaba era el que mas urgia.
 *
 * Lo mismo con el nombre de la contraparte: salia de un JOIN sobre `buyer_id`,
 * que en cash-out es el propio proveedor. La fila le mostraba su nombre.
 *
 * Corre contra el store en memoria (ALLOW_IN_MEMORY_DB=true, sin PostgreSQL).
 *
 * LIMITE DE ALCANCE — leelo antes de fiarte de este fichero: el store de
 * src/db/schema.ts es un shim de expresiones regulares sin esquema. Cubre el
 * WHERE, el filtro por estado y la derivacion del cliente, que es donde estaba
 * el defecto. NO cubre `chk_trades_flow_provider` ni el plan del indice
 * `idx_trades_provider`: eso solo se prueba contra PostgreSQL de verdad.
 */

import Fastify from 'fastify';
import fastifyJwt from '@fastify/jwt';
import { strictEqual, ok } from 'assert';
import db from '../db/schema.js';
import { config } from '../config.js';
import { tradeRoutes } from '../routes/trades.js';
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
async function createUser(label: string): Promise<{ id: string; username: string }> {
  seq++;
  const suffix = String(seq).padStart(2, '0');
  const username = `cash3_${label}_${suffix}`;
  const row = await db.getOne<{ id: string }>(
    `INSERT INTO users (stellar_address, username, phone_hash, merchant_available, availability, is_suspended, provider_status)
     VALUES ($1, $2, $3, $4, $5, $6, 'active')
     RETURNING id`,
    [`G${'C'.repeat(53)}${suffix}`, username, `hash_cash3_${label}_${suffix}`, true, 'online', false],
  );
  if (!row?.id) throw new Error(`Failed to seed user ${label}`);
  return { id: row.id, username };
}

async function createTrade(
  app: any,
  callerId: string,
  counterpartyId: string,
  flow: 'deposit' | 'cashout',
) {
  const token = app.jwt.sign({ id: callerId, stellar_address: 'GCALLER' });
  const res = await app.inject({
    method: 'POST',
    url: '/trades',
    headers: { authorization: `Bearer ${token}` },
    payload: { counterparty_id: counterpartyId, amount_mxn: 500, flow },
  });
  strictEqual(res.statusCode, 201, `${flow} must be created (got ${res.statusCode}: ${res.body})`);
  return res.json().trade;
}

async function inbox(app: any, userId: string, state = 'all') {
  const token = app.jwt.sign({ id: userId, stellar_address: 'GPROVIDER' });
  const res = await app.inject({
    method: 'GET',
    url: `/merchants/me/trades?state=${state}`,
    headers: { authorization: `Bearer ${token}` },
  });
  strictEqual(res.statusCode, 200, `inbox must respond 200 (got ${res.statusCode}: ${res.body})`);
  return res.json().trades as Array<{ id: string; flow: string; client_handle: string }>;
}

/** El caso que estaba roto: en cash-out el proveedor es el COMPRADOR. */
async function testCashoutReachesTheProvider(app: any) {
  const client = await createUser('cashout_client');
  const provider = await createUser('cashout_provider');
  const trade = await createTrade(app, client.id, provider.id, 'cashout');

  ok(trade.seller_id === client.id, 'premisa: en cash-out el cliente es el vendedor del escrow');

  const rows = await inbox(app, provider.id);
  const row = rows.find((r) => r.id === trade.id);
  ok(row, 'el proveedor tiene que ver la solicitud de cash-out — este es el defecto CASH-3');
  strictEqual(row!.flow, 'cashout', 'la fila declara su flujo');
  strictEqual(
    row!.client_handle,
    client.username,
    'la contraparte es el cliente, no el propio proveedor',
  );
  console.log('  ✓ cash-out: llega a la bandeja del proveedor y nombra al cliente');
}

/** El caso que ya funcionaba no se puede romper al arreglar el otro. */
async function testDepositStillReachesTheProvider(app: any) {
  const client = await createUser('deposit_client');
  const provider = await createUser('deposit_provider');
  const trade = await createTrade(app, client.id, provider.id, 'deposit');

  const rows = await inbox(app, provider.id);
  const row = rows.find((r) => r.id === trade.id);
  ok(row, 'el proveedor sigue viendo los depositos');
  strictEqual(row!.flow, 'deposit', 'la fila declara su flujo');
  strictEqual(row!.client_handle, client.username, 'la contraparte es el cliente');
  console.log('  ✓ deposito: sigue llegando y nombra al cliente');
}

/** La bandeja es del PROVEEDOR. El cliente no ve ahi sus propias operaciones. */
async function testClientDoesNotSeeOwnTradeAsProvider(app: any) {
  const client = await createUser('solo_client');
  const provider = await createUser('solo_provider');
  const trade = await createTrade(app, client.id, provider.id, 'cashout');

  const rows = await inbox(app, client.id);
  ok(
    !rows.some((r) => r.id === trade.id),
    'la bandeja del proveedor no puede convertirse en "cualquiera de los dos"',
  );
  console.log('  ✓ el cliente no ve su propia operacion en la bandeja de proveedor');
}

/** El filtro por estado tiene que seguir discriminando. */
async function testStateFilter(app: any) {
  const client = await createUser('filter_client');
  const provider = await createUser('filter_provider');
  const trade = await createTrade(app, client.id, provider.id, 'cashout');

  const pending = await inbox(app, provider.id, 'pending');
  ok(pending.some((r) => r.id === trade.id), 'una operacion recien creada esta pending');

  const completed = await inbox(app, provider.id, 'completed');
  ok(!completed.some((r) => r.id === trade.id), 'y no aparece bajo otro estado');
  console.log('  ✓ el filtro por estado discrimina');
}

async function main() {
  console.log('\n  CASH-3 — bandeja del proveedor, los dos flujos:\n');
  const app = await buildTestApp();
  await testCashoutReachesTheProvider(app);
  await testDepositStillReachesTheProvider(app);
  await testClientDoesNotSeeOwnTradeAsProvider(app);
  await testStateFilter(app);
  await app.close();
  console.log('\nAll CASH-3 provider inbox tests passed.\n');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
