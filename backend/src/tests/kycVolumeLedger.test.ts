/**
 * CASH-10 · KYC de los dos participantes y contabilidad atomica del volumen.
 *
 * Corrige los issues cerrados de GrantFox #314 y #316.
 *
 * Lo que estaba mal:
 *
 *   1. `createTrade` solo comprobaba `buyer_id`. En cash-out ese es el
 *      PROVEEDOR, asi que el cliente quedaba sin comprobar. Encender
 *      KYC_GATE_ENABLED habria aplicado la cobertura equivocada.
 *   2. El volumen se incrementaba ANTES de que la operacion existiera: un
 *      fallo posterior dejaba volumen fantasma cargado a una persona por una
 *      operacion que nunca ocurrio.
 *   3. Reintentar la misma operacion contaba dos veces.
 *   4. El mutex era en proceso: dos instancias del backend podian superar el
 *      tope juntas.
 *
 * NECESITA POSTGRESQL REAL. Nada de lo importante aqui —transacciones, locks
 * de aviso, el trigger de ciclo de vida, la llave primaria compuesta— existe
 * en el shim en memoria, que ademas no evalua estos WHERE. Correrlo contra el
 * shim daria verde sin probar nada, asi que la suite se niega:
 *
 *   docker run -d --name mp-pg -e POSTGRES_PASSWORD=x -e POSTGRES_DB=micopay \
 *     -p 55432:5432 postgres:16-alpine
 *   DATABASE_URL=postgres://postgres:x@localhost:55432/micopay npm run migrate
 *   DATABASE_URL=postgres://postgres:x@localhost:55432/micopay npm run test:kyc-ledger
 */

import { strictEqual, ok } from "assert";
import db, { pool } from "../db/schema.js";
import {
  currentMonthKey,
  getMonthlyReservedMxn,
  getTradeReservations,
  lockUsersForVolume,
  reserveVolume,
} from "../services/kycVolumeLedger.service.js";

const RUN = Math.random().toString(36).slice(2, 8);
let seq = 0;

async function createUser(label: string): Promise<string> {
  seq++;
  const suffix = `${RUN}${String(seq).padStart(2, "0")}`;
  const row = await db.getOne<{ id: string }>(
    `INSERT INTO users (stellar_address, username, phone_hash, merchant_available, availability, is_suspended)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id`,
    [
      // 1 + 47 + 8 = 56, el largo exacto de una direccion Stellar.
      `G${"F".repeat(47)}${suffix}`,
      `cash10_${label}_${suffix}`,
      `hash_cash10_${label}_${suffix}`,
      true,
      "online",
      false,
    ],
  );
  if (!row?.id) throw new Error(`Failed to seed user ${label}`);
  return row.id;
}

async function insertTrade(sellerId: string, buyerId: string, amountMxn = 500): Promise<string> {
  seq++;
  const row = await db.getOne<{ id: string }>(
    `INSERT INTO trades
       (seller_id, buyer_id, flow, provider_id, amount_mxn, amount_stroops, secret_hash, status, expires_at)
     VALUES ($1, $2, 'cashout', $2, $3, $4, $5, 'pending', NOW() + INTERVAL '2 hours')
     RETURNING id`,
    [sellerId, buyerId, amountMxn, "5000000000", `h10_${RUN}_${seq}`],
  );
  if (!row?.id) throw new Error("Failed to insert trade");
  return row.id;
}

async function withTx<T>(fn: (client: any) => Promise<T>): Promise<T> {
  const client = await pool!.connect();
  try {
    await client.query("BEGIN");
    const out = await fn(client);
    await client.query("COMMIT");
    return out;
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

// ── 1. Idempotencia ────────────────────────────────────────────────────────

async function testRetryDoesNotCountTwice() {
  const client = await createUser("cli");
  const provider = await createUser("prov");
  const tradeId = await insertTrade(client, provider, 700);

  await withTx((c) => reserveVolume(c, { tradeId, userId: client, amountMxn: 700 }));
  await withTx((c) => reserveVolume(c, { tradeId, userId: client, amountMxn: 700 }));

  strictEqual(await getMonthlyReservedMxn(client), 700, "reintentar no suma dos veces");
  strictEqual((await getTradeReservations(tradeId)).length, 1, "hay una sola reserva");
  console.log("  ✓ reintentar la misma operación no cuenta el volumen dos veces");
}

// ── 2. Los dos participantes ───────────────────────────────────────────────

async function testBothParticipantsAreCharged() {
  const client = await createUser("cli");
  const provider = await createUser("prov");
  const tradeId = await insertTrade(client, provider, 400);

  await withTx(async (c) => {
    await reserveVolume(c, { tradeId, userId: client, amountMxn: 400 });
    await reserveVolume(c, { tradeId, userId: provider, amountMxn: 400 });
  });

  strictEqual(await getMonthlyReservedMxn(client), 400, "el cliente cuenta");
  strictEqual(await getMonthlyReservedMxn(provider), 400, "y el proveedor también");
  strictEqual((await getTradeReservations(tradeId)).length, 2);
  console.log("  ✓ el volumen se aparta para los dos participantes");
}

// ── 3. Nada de volumen fantasma ────────────────────────────────────────────

async function testFailedTradeLeavesNoVolume() {
  const client = await createUser("cli");
  const provider = await createUser("prov");
  const tradeId = await insertTrade(client, provider, 900);

  // La reserva del primero entra y luego algo falla: sin transaccion, ese
  // volumen se quedaba cargado. Con ella, no queda rastro.
  try {
    await withTx(async (c) => {
      await reserveVolume(c, { tradeId, userId: client, amountMxn: 900 });
      throw new Error("fallo simulado después de la primera reserva");
    });
  } catch {
    /* esperado */
  }

  strictEqual(await getMonthlyReservedMxn(client), 0, "no quedó volumen fantasma");
  strictEqual((await getTradeReservations(tradeId)).length, 0, "ni reservas huérfanas");
  console.log("  ✓ una creación fallida no deja volumen cargado a nadie");
}

// ── 4. Concurrencia entre clientes de base distintos ───────────────────────

async function testConcurrentReservationsSerialize() {
  const user = await createUser("concurrente");
  const provider = await createUser("prov");
  const tradeA = await insertTrade(user, provider, 600);
  const tradeB = await insertTrade(user, provider, 600);
  const CAP = 1000;

  /**
   * Se prueba el MECANISMO, no una carrera con temporizadores.
   *
   * Un primer intento con dos transacciones en paralelo y una barrera no
   * servia: pasaba igual con y sin el lock, asi que no probaba nada. Aqui se
   * comprueba lo que el lock hace: la segunda transaccion NO puede leer el
   * volumen hasta que la primera suelte, y por tanto ve el valor ya
   * reservado en vez de uno rancio.
   */
  const first = await pool!.connect();
  const second = await pool!.connect();

  try {
    await first.query("BEGIN");
    await lockUsersForVolume(first, [user]);
    await reserveVolume(first, { tradeId: tradeA, userId: user, amountMxn: 600 });

    // La segunda pide el mismo lock mientras la primera sigue abierta.
    await second.query("BEGIN");
    let secondAcquired = false;
    const secondLock = lockUsersForVolume(second, [user]).then(() => {
      secondAcquired = true;
    });

    await new Promise((r) => setTimeout(r, 400));
    strictEqual(
      secondAcquired,
      false,
      "la segunda transacción debe quedarse esperando el lock de la primera",
    );

    await first.query("COMMIT");
    await secondLock;
    ok(secondAcquired, "al soltar la primera, la segunda entra");

    // Y ahora lee el valor real, no uno rancio.
    const reserved = await getMonthlyReservedMxn(user, currentMonthKey(), second);
    strictEqual(reserved, 600, "la segunda ve lo que reservó la primera");
    ok(reserved + 600 > CAP, "así que se topa, en vez de superar el tope entre las dos");

    await second.query("ROLLBACK");
  } finally {
    first.release();
    second.release();
  }

  strictEqual(await getMonthlyReservedMxn(user), 600, "el tope no se superó");
  console.log("  ✓ el lock de base serializa a dos clientes distintos (no es un mutex de proceso)");
}

// ── 5. Ciclo de vida por trigger ───────────────────────────────────────────

async function testLifecycleTrigger() {
  const client = await createUser("cli");
  const provider = await createUser("prov");

  // Completada: el volumen se consolida y sigue contando.
  const completed = await insertTrade(client, provider, 300);
  await withTx(async (c) => {
    await reserveVolume(c, { tradeId: completed, userId: client, amountMxn: 300 });
  });
  await db.execute(`UPDATE trades SET status = 'completed' WHERE id = $1`, [completed]);
  strictEqual((await getTradeReservations(completed))[0].status, "finalized", "completed → finalized");
  strictEqual(await getMonthlyReservedMxn(client), 300, "el volumen finalizado sigue contando");

  // Cancelada: el volumen se libera y deja de contar.
  const cancelled = await insertTrade(client, provider, 500);
  await withTx(async (c) => {
    await reserveVolume(c, { tradeId: cancelled, userId: client, amountMxn: 500 });
  });
  strictEqual(await getMonthlyReservedMxn(client), 800, "mientras está viva, cuenta");
  await db.execute(`UPDATE trades SET status = 'cancelled' WHERE id = $1`, [cancelled]);
  strictEqual((await getTradeReservations(cancelled))[0].status, "released", "cancelled → released");
  strictEqual(await getMonthlyReservedMxn(client), 300, "liberada, deja de contar");

  console.log("  ✓ completada consolida, cancelada libera — vía trigger, sin tocar esos flujos");
}

async function testRefundedAndExpiredAlsoRelease() {
  for (const terminal of ["refunded", "expired"] as const) {
    const client = await createUser(`cli_${terminal}`);
    const provider = await createUser(`prov_${terminal}`);
    const tradeId = await insertTrade(client, provider, 250);
    await withTx((c) => reserveVolume(c, { tradeId, userId: client, amountMxn: 250 }));
    strictEqual(await getMonthlyReservedMxn(client), 250);

    await db.execute(`UPDATE trades SET status = $2 WHERE id = $1`, [tradeId, terminal]);
    strictEqual((await getTradeReservations(tradeId))[0].status, "released", `${terminal} → released`);
    strictEqual(await getMonthlyReservedMxn(client), 0, `${terminal} libera el volumen`);
  }
  console.log("  ✓ reembolsada y expirada también liberan");
}

async function main() {
  console.log("\n  CASH-10 (#314/#316 follow-up) ledger de volumen KYC:\n");

  if (!pool) {
    console.error(
      "\n  ✗ NO VERIFICADO: esta suite necesita PostgreSQL real.\n" +
        "    Transacciones, locks de aviso, el trigger de ciclo de vida y la\n" +
        "    llave primaria compuesta no existen en el store en memoria, que\n" +
        "    ademas no evalúa estos WHERE: pasaría en verde sin probar nada.\n" +
        "    Ver el encabezado del archivo.\n",
    );
    process.exit(1);
  }

  await testRetryDoesNotCountTwice();
  await testBothParticipantsAreCharged();
  await testFailedTradeLeavesNoVolume();
  await testConcurrentReservationsSerialize();
  await testLifecycleTrigger();
  await testRefundedAndExpiredAlsoRelease();
  console.log("\nAll CASH-10 KYC volume ledger tests passed.\n");
  await pool.end();
}

main().catch(async (err) => {
  console.error(err);
  await pool?.end().catch(() => {});
  process.exit(1);
});
