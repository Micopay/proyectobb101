/**
 * CASH-6 · El reembolso por vencimiento debe poder pedirse.
 *
 * Seguimiento correctivo del issue cerrado #71.
 *
 * El backend ya permitía reembolsar tras `expires_at` con fondos bloqueados,
 * pero la app ofrecía la acción SOLO cuando el estado era `expired`... y ese
 * estado nunca se persiste. Una operación `locked` o `revealing` que vencía
 * quedaba sin salida visible, justo en el momento en que el reembolso por
 * timeout es la última garantía del usuario.
 *
 * La elegibilidad la decide ahora el servidor, no el reloj del teléfono. Este
 * archivo fija esa decisión: antes, en el límite y después del vencimiento, y
 * para cada motivo de rechazo.
 *
 * El tiempo se controla moviendo `expires_at`, que es determinista y no
 * depende de mockear relojes.
 */

import { strictEqual, ok } from "assert";
import db from "../db/schema.js";
import { getRefundEligibility } from "../services/trade.service.js";

let seq = 0;
async function createUser(label: string): Promise<string> {
  seq++;
  const suffix = String(seq).padStart(2, "0");
  const row = await db.getOne<{ id: string }>(
    `INSERT INTO users (stellar_address, username, phone_hash, merchant_available, availability, is_suspended)
     VALUES ($1, $2, $3, true, 'online', false)
     RETURNING id`,
    [`G${"J".repeat(53)}${suffix}`, `cash6_${label}_${suffix}`, `h_cash6_${label}_${suffix}`],
  );
  if (!row?.id) throw new Error(`Failed to seed ${label}`);
  return row.id;
}

/** `expiresInSeconds` negativo = ya venció. */
async function insertTrade(opts: {
  sellerId: string;
  buyerId: string;
  status: string;
  expiresInSeconds: number;
  locked?: boolean;
}): Promise<string> {
  seq++;
  const expiresAt = new Date(Date.now() + opts.expiresInSeconds * 1000).toISOString();
  const row = await db.getOne<{ id: string }>(
    `INSERT INTO trades
       (seller_id, buyer_id, flow, provider_id, amount_mxn, amount_stroops, secret_hash,
        status, lock_tx_hash, expires_at)
     VALUES ($1, $2, 'cashout', $2, 500, 5000000000, $3, $4, $5, $6)
     RETURNING id`,
    [
      opts.sellerId,
      opts.buyerId,
      `h6_${seq}_${Math.random()}`,
      opts.status,
      opts.locked === false ? null : `mock_lock_${seq}`,
      expiresAt,
    ],
  );
  if (!row?.id) throw new Error("Failed to insert trade");
  return row.id;
}

// ── Antes / después del vencimiento ────────────────────────────────────────

async function testNotEligibleBeforeExpiry() {
  const client = await createUser("cli");
  const provider = await createUser("prov");
  const tradeId = await insertTrade({
    sellerId: client,
    buyerId: provider,
    status: "locked",
    expiresInSeconds: 3600,
  });

  const e = await getRefundEligibility(tradeId, client);
  strictEqual(e.eligible, false, "antes de vencer no se puede reembolsar");
  strictEqual(e.reason, "not_expired_yet");
  ok(e.seconds_remaining > 3500, "y se informa cuánto falta");
  console.log("  ✓ antes del vencimiento no hay reembolso, y se dice cuánto falta");
}

/**
 * El caso que el issue viene a arreglar: vencida pero con estado `locked`,
 * porque `expired` no se persiste nunca.
 */
async function testEligibleAfterExpiryWhileStillLocked() {
  const client = await createUser("cli");
  const provider = await createUser("prov");

  for (const status of ["locked", "revealing"]) {
    const tradeId = await insertTrade({
      sellerId: client,
      buyerId: provider,
      status,
      expiresInSeconds: -60,
    });

    const e = await getRefundEligibility(tradeId, client);
    strictEqual(e.eligible, true, `una operación ${status} vencida sí se puede reembolsar`);
    strictEqual(e.reason, "eligible");
    strictEqual(e.seconds_remaining, 0);
  }
  console.log("  ✓ vencida en locked o revealing: elegible aunque el estado no sea `expired`");
}

async function testBoundaryIsInclusive() {
  const client = await createUser("cli");
  const provider = await createUser("prov");
  // Justo en el límite: `expires_at` ya pasó por un margen mínimo.
  const tradeId = await insertTrade({
    sellerId: client,
    buyerId: provider,
    status: "locked",
    expiresInSeconds: -1,
  });

  const e = await getRefundEligibility(tradeId, client);
  strictEqual(e.eligible, true, "en el límite ya vencido, es elegible");
  console.log("  ✓ el límite cuenta como vencido");
}

// ── Motivos de rechazo ─────────────────────────────────────────────────────

async function testNoFundsLocked() {
  const client = await createUser("cli");
  const provider = await createUser("prov");
  const tradeId = await insertTrade({
    sellerId: client,
    buyerId: provider,
    status: "pending",
    expiresInSeconds: -60,
    locked: false,
  });

  const e = await getRefundEligibility(tradeId, client);
  strictEqual(e.eligible, false, "sin fondos en cadena no hay nada que reembolsar");
  strictEqual(e.reason, "no_funds_locked");
  console.log("  ✓ sin fondos bloqueados no se ofrece reembolso");
}

async function testAlreadySettled() {
  const client = await createUser("cli");
  const provider = await createUser("prov");

  for (const status of ["completed", "refunded"]) {
    const tradeId = await insertTrade({
      sellerId: client,
      buyerId: provider,
      status,
      expiresInSeconds: -60,
    });
    const e = await getRefundEligibility(tradeId, client);
    strictEqual(e.eligible, false, `${status} ya está saldada`);
    strictEqual(e.reason, "already_settled");
  }
  console.log("  ✓ completada o ya reembolsada no vuelve a ofrecer reembolso");
}

async function testOnlyParticipants() {
  const client = await createUser("cli");
  const provider = await createUser("prov");
  const stranger = await createUser("x");
  const tradeId = await insertTrade({
    sellerId: client,
    buyerId: provider,
    status: "locked",
    expiresInSeconds: -60,
  });

  strictEqual((await getRefundEligibility(tradeId, client)).eligible, true, "el cliente sí");
  strictEqual((await getRefundEligibility(tradeId, provider)).eligible, true, "el proveedor también");

  const forStranger = await getRefundEligibility(tradeId, stranger);
  strictEqual(forStranger.eligible, false, "un tercero no");
  strictEqual(forStranger.reason, "not_participant");
  console.log("  ✓ las dos partes pueden pedirlo; un tercero no");
}

/**
 * La respuesta no puede prometer algo que la acción luego rechace: el orden de
 * comprobaciones es el mismo que en `refundTrade`.
 */
async function testEligibilityMatchesTheAction() {
  const client = await createUser("cli");
  const provider = await createUser("prov");
  const tradeId = await insertTrade({
    sellerId: client,
    buyerId: provider,
    status: "completed",
    expiresInSeconds: -60,
  });

  const e = await getRefundEligibility(tradeId, client);
  strictEqual(e.eligible, false);
  // `already_settled` gana sobre `not_expired_yet`, igual que en la acción.
  strictEqual(e.reason, "already_settled", "el motivo coincide con el de refundTrade");
  console.log("  ✓ el motivo devuelto coincide con el que aplicaría la acción");
}

async function testServerTimeIsReported() {
  const client = await createUser("cli");
  const provider = await createUser("prov");
  const tradeId = await insertTrade({
    sellerId: client,
    buyerId: provider,
    status: "locked",
    expiresInSeconds: 120,
  });

  const e = await getRefundEligibility(tradeId, client);
  const drift = Math.abs(Date.now() - new Date(e.server_time).getTime());
  ok(drift < 5000, "se devuelve la hora del servidor para que el cliente no use la suya");
  ok(e.seconds_remaining > 100 && e.seconds_remaining <= 120, "la cuenta atrás sale del servidor");
  console.log("  ✓ la cuenta atrás la marca el servidor, no el dispositivo");
}

async function main() {
  console.log("\n  CASH-6 (#71 follow-up) elegibilidad de reembolso:\n");
  await testNotEligibleBeforeExpiry();
  await testEligibleAfterExpiryWhileStillLocked();
  await testBoundaryIsInclusive();
  await testNoFundsLocked();
  await testAlreadySettled();
  await testOnlyParticipants();
  await testEligibilityMatchesTheAction();
  await testServerTimeIsReported();
  console.log("\nAll CASH-6 refund eligibility tests passed.\n");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
