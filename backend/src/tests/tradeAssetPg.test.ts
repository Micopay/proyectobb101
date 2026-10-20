/**
 * WP-A · un activo sin escrow no deja efectos de negocio, contra PostgreSQL real.
 *
 * tradeAsset.test.ts prueba la politica contra el store en memoria, que omite
 * la transaccion CASH-10 (`if (client)` en createTrade). Consultar ahi el ledger
 * vacio no demostraria nada. Esta suite corre la ruta real y comprueba que un
 * 422 no inserta la operacion ni reserva volumen, y que una operacion XLM
 * valida SI reserva: sin ese control, "cero reservas" podria ser solo que el
 * ledger nunca se escribe.
 *
 * NECESITA POSTGRESQL REAL; con el shim la suite se niega:
 *
 *   docker run -d --name mp-pg -e POSTGRES_PASSWORD=x -e POSTGRES_DB=micopay \
 *     -p 55432:5432 postgres:16-alpine
 *   DATABASE_URL=postgres://postgres:x@localhost:55432/micopay npm run migrate
 *   DATABASE_URL=postgres://postgres:x@localhost:55432/micopay npm run test:trade-asset-pg
 *
 * Crear operaciones consulta la tasa XLM/MXN viva.
 */

import Fastify from 'fastify';
import fastifyJwt from '@fastify/jwt';
import { strictEqual, ok } from 'assert';
import db, { pool } from '../db/schema.js';
import { config } from '../config.js';
import { tradeRoutes } from '../routes/trades.js';
import { getTradeReservations } from '../services/kycVolumeLedger.service.js';
import { AppError } from '../utils/errors.js';

const RUN = Math.random().toString(36).slice(2, 8);
let seq = 0;

async function createUser(label: string): Promise<string> {
  seq++;
  const suffix = `${RUN}${String(seq).padStart(2, '0')}`;
  const row = await db.getOne<{ id: string }>(
    `INSERT INTO users (stellar_address, username, phone_hash, merchant_available, availability, is_suspended, provider_status)
     VALUES ($1, $2, $3, $4, $5, $6, 'active')
     RETURNING id`,
    // 1 + 47 + 8 = 56, el largo exacto de una direccion Stellar.
    [`G${'H'.repeat(47)}${suffix}`, `wpapg_${label}_${suffix}`, `hash_wpapg_${label}_${suffix}`, true, 'online', false],
  );
  if (!row?.id) throw new Error(`Failed to seed user ${label}`);
  return row.id;
}

async function reservationsFor(userIds: string[]): Promise<number> {
  const row = await db.getOne<{ n: string }>(
    'SELECT COUNT(*)::text AS n FROM kyc_volume_reservations WHERE user_id = ANY($1)',
    [userIds],
  );
  return Number(row?.n ?? 0);
}

async function tradesFor(userIds: string[]): Promise<number> {
  const row = await db.getOne<{ n: string }>(
    'SELECT COUNT(*)::text AS n FROM trades WHERE seller_id = ANY($1) OR buyer_id = ANY($1)',
    [userIds],
  );
  return Number(row?.n ?? 0);
}

async function buildApp() {
  const app = Fastify({ logger: false });
  app.register(fastifyJwt, { secret: config.jwtSecret });
  app.setErrorHandler((error: any, _req: any, reply: any) => {
    if (error instanceof AppError) {
      reply.status(error.httpStatus).send({ code: error.code });
      return;
    }
    reply.status(error.statusCode ?? 500).send({ code: 'ERROR', message: error.message });
  });
  app.register(tradeRoutes);
  await app.ready();
  return app;
}

async function main() {
  console.log('\nWP-A · asset policy vs CASH-10 ledger (PostgreSQL)\n');
  if (!pool) {
    console.log('  ✗ NO VERIFICADO: esta suite necesita PostgreSQL real (ver encabezado).');
    process.exit(1);
  }

  const app = await buildApp();
  try {
    for (const flow of ['deposit', 'cashout'] as const) {
      const callerId = await createUser(`${flow}_caller`);
      const counterpartyId = await createUser(`${flow}_cp`);
      const users = [callerId, counterpartyId];
      const token = app.jwt.sign({ id: callerId, stellar_address: 'GCALLER' });
      const send = (asset_code?: unknown) =>
        app.inject({
          method: 'POST',
          url: '/trades',
          headers: { authorization: `Bearer ${token}` },
          payload: { counterparty_id: counterpartyId, amount_mxn: 500, flow, ...(asset_code === undefined ? {} : { asset_code }) },
        });

      for (const asset of ['USDC', 'MXNE', 'FOO']) {
        const res = await send(asset);
        strictEqual(res.statusCode, 422, `${flow}/${asset}: expected 422, got ${res.statusCode}: ${res.body}`);
      }
      strictEqual(await tradesFor(users), 0, `${flow}: a rejected asset must not insert a trade`);
      strictEqual(await reservationsFor(users), 0, `${flow}: a rejected asset must not reserve volume`);

      // Control: la misma pareja con XLM SI crea la operacion y reserva a los dos.
      const okRes = await send('XLM');
      strictEqual(okRes.statusCode, 201, `${flow}/XLM control: expected 201, got ${okRes.statusCode}: ${okRes.body}`);
      const tradeId = okRes.json().trade.id;
      const reservations = await getTradeReservations(tradeId);
      strictEqual(reservations.length, 2, `${flow}/XLM control: both participants must be reserved`);
      ok(reservations.every((r) => r.amount_mxn === 500), `${flow}/XLM control: reserved amount must be 500`);

      console.log(`  ✓ ${flow}: USDC/MXNE/FOO -> 422 with no trade and no reservation; XLM control reserves both`);
    }
    console.log('\nAll WP-A PostgreSQL asset tests passed.\n');
  } finally {
    await app.close();
    await pool.end();
  }
}

main().catch(async (err) => {
  console.error('\n✗', err?.message ?? err);
  await pool?.end().catch(() => {});
  process.exit(1);
});
