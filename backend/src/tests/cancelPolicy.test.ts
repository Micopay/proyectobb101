/**
 * CASH-2 · Quién puede cancelar, según flujo y actor.
 *
 * Seguimiento correctivo de los issues cerrados #20 y #31.
 *
 * La cancelación en `locked` y `revealing` consultaba la disponibilidad
 * comercial sobre `trade.seller_id`. En depósito ese es el proveedor, pero en
 * cash-out es el CLIENTE: se preguntaba por la persona equivocada. El
 * resultado era que quien había bloqueado su USDC se quedaba sin vía de
 * recuperación en la app, mientras el proveedor podía cancelar en casos donde
 * debía mandar el cliente.
 *
 * LA TABLA que este archivo fija, aprobada por producto:
 *
 *   ┌─────────────┬──────────────────────┬──────────────────────────────────┐
 *   │ estado      │ actor                │ ¿puede cancelar?                 │
 *   ├─────────────┼──────────────────────┼──────────────────────────────────┤
 *   │ pending     │ cliente o proveedor  │ sí — nada en cadena todavía      │
 *   │ locked      │ cliente              │ sí — detiene el flujo            │
 *   │ locked      │ proveedor            │ solo si él está no disponible    │
 *   │ revealing   │ cliente              │ sí, si no hay entrega confirmada │
 *   │ revealing   │ proveedor            │ solo si él está no disponible    │
 *   │ cualquiera  │ con entrega hecha    │ NO — completar o soporte         │
 *   │ terminal    │ cualquiera           │ NO                               │
 *   │ cualquiera  │ un tercero           │ NO                               │
 *   └─────────────┴──────────────────────┴──────────────────────────────────┘
 *
 * Y en ningún caso cancelar devuelve fondos. Sin un `decline` en el contrato
 * —que producto decidió no implementar todavía— la única vía on-chain tras el
 * bloqueo es el reembolso por vencimiento.
 */

import { strictEqual, ok } from "assert";
import db from "../db/schema.js";
import { cancelTrade } from "../services/trade.service.js";
import { AppError } from "../utils/errors.js";

const fakeRequest = {
  ip: "127.0.0.1",
  headers: {},
  log: { info: () => {}, warn: () => {}, error: () => {} },
} as any;

let seq = 0;
async function createUser(label: string, available = true): Promise<string> {
  seq++;
  const suffix = String(seq).padStart(2, "0");
  const row = await db.getOne<{ id: string }>(
    `INSERT INTO users (stellar_address, username, phone_hash, merchant_available, availability, is_suspended)
     VALUES ($1, $2, $3, $4, $5, false)
     RETURNING id`,
    [
      `G${"K".repeat(53)}${suffix}`,
      `cash2_${label}_${suffix}`,
      `h_cash2_${label}_${suffix}`,
      available,
      available ? "online" : "paused",
    ],
  );
  if (!row?.id) throw new Error(`Failed to seed ${label}`);
  return row.id;
}

/** Cash-out: el cliente es el vendedor del escrow; el proveedor, el comprador. */
async function insertTrade(opts: {
  flow: "cashout" | "deposit";
  clientId: string;
  providerId: string;
  status: string;
  locked?: boolean;
}): Promise<string> {
  seq++;
  const cashout = opts.flow === "cashout";
  const sellerId = cashout ? opts.clientId : opts.providerId;
  const buyerId = cashout ? opts.providerId : opts.clientId;
  const row = await db.getOne<{ id: string }>(
    `INSERT INTO trades
       (seller_id, buyer_id, flow, provider_id, amount_mxn, amount_stroops, secret_hash,
        status, lock_tx_hash, expires_at)
     VALUES ($1, $2, $3, $4, 500, 5000000000, $5, $6, $7, $8)
     RETURNING id`,
    [
      sellerId,
      buyerId,
      opts.flow,
      opts.providerId,
      `h2_${seq}_${Math.random()}`,
      opts.status,
      opts.locked === false ? null : `mock_lock_${seq}`,
      new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
    ],
  );
  if (!row?.id) throw new Error("Failed to insert trade");
  return row.id;
}

async function expectRejected(fn: () => Promise<unknown>, code: string, what: string) {
  try {
    await fn();
  } catch (err) {
    if (err instanceof AppError) {
      strictEqual(err.code, code, `${what}: se esperaba ${code}, llegó ${err.code}`);
      return;
    }
    throw err;
  }
  throw new Error(`${what}: se esperaba ${code} y no hubo error`);
}

// ── El arreglo central ─────────────────────────────────────────────────────

/**
 * El caso que estaba roto: en cash-out el cliente es el vendedor del escrow,
 * así que la comprobación de disponibilidad recaía sobre él.
 */
async function testCashoutClientCanStopTheFlow() {
  const client = await createUser("cli");
  const provider = await createUser("prov");
  const tradeId = await insertTrade({ flow: "cashout", clientId: client, providerId: provider, status: "locked" });

  const result = await cancelTrade(fakeRequest, tradeId, client);
  strictEqual(result.status, "cancelled", "el cliente del cash-out puede detener el flujo");
  console.log("  ✓ cash-out: el cliente puede cancelar en locked (antes no podía)");
}

async function testCashoutProviderNeedsToPauseFirst() {
  const client = await createUser("cli");
  const provider = await createUser("prov", true);
  const tradeId = await insertTrade({ flow: "cashout", clientId: client, providerId: provider, status: "locked" });

  await expectRejected(
    () => cancelTrade(fakeRequest, tradeId, provider),
    "PROVIDER_MUST_PAUSE_FIRST",
    "proveedor disponible cancelando",
  );
  console.log("  ✓ un proveedor disponible no puede deshacer la operación de otro");
}

async function testUnavailableProviderMayWithdraw() {
  const client = await createUser("cli");
  const provider = await createUser("prov", false);
  const tradeId = await insertTrade({ flow: "cashout", clientId: client, providerId: provider, status: "locked" });

  const result = await cancelTrade(fakeRequest, tradeId, provider);
  strictEqual(result.status, "cancelled", "un proveedor pausado sí puede replegarse");
  console.log("  ✓ el proveedor pausado conserva su vía de repliegue");
}

/** La disponibilidad se mira sobre el proveedor, no sobre el vendedor. */
async function testAvailabilityIsCheckedOnTheProvider() {
  // Cliente NO disponible, proveedor SÍ. Antes, en cash-out, la comprobación
  // caía sobre el cliente (que es el vendedor) y dejaba pasar al proveedor.
  const client = await createUser("cli", false);
  const provider = await createUser("prov", true);
  const tradeId = await insertTrade({ flow: "cashout", clientId: client, providerId: provider, status: "locked" });

  await expectRejected(
    () => cancelTrade(fakeRequest, tradeId, provider),
    "PROVIDER_MUST_PAUSE_FIRST",
    "la no disponibilidad del cliente no habilita al proveedor",
  );
  console.log("  ✓ la disponibilidad se evalúa sobre provider_id, nunca sobre seller_id");
}

// ── El depósito no se rompe ────────────────────────────────────────────────

async function testDepositUnchanged() {
  const client = await createUser("cli");
  const provider = await createUser("prov", true);
  const tradeId = await insertTrade({ flow: "deposit", clientId: client, providerId: provider, status: "locked" });

  const result = await cancelTrade(fakeRequest, tradeId, client);
  strictEqual(result.status, "cancelled", "en depósito el cliente sigue pudiendo cancelar");

  const other = await insertTrade({ flow: "deposit", clientId: client, providerId: provider, status: "locked" });
  await expectRejected(
    () => cancelTrade(fakeRequest, other, provider),
    "PROVIDER_MUST_PAUSE_FIRST",
    "proveedor disponible en depósito",
  );
  console.log("  ✓ en depósito la política se mantiene (ahí ya era correcta)");
}

// ── Los fondos no vuelven al cancelar ──────────────────────────────────────

async function testCancellationNeverReturnsFundsImmediately() {
  const client = await createUser("cli");
  const provider = await createUser("prov");
  const tradeId = await insertTrade({ flow: "cashout", clientId: client, providerId: provider, status: "locked" });

  const result = await cancelTrade(fakeRequest, tradeId, client);
  ok(result.refund_expected, "hay fondos que volverán");
  ok(result.refund_available_at, "y se dice desde cuándo");
  ok(
    new Date(result.refund_available_at!).getTime() > Date.now(),
    "el momento es futuro: cancelar NO liquida la cadena",
  );

  const row = await db.getOne<{ status: string; release_tx_hash: string | null }>(
    "SELECT status, release_tx_hash FROM trades WHERE id = $1",
    [tradeId],
  );
  strictEqual(row?.status, "cancelled");
  strictEqual(row?.release_tx_hash ?? null, null, "no se inventó una liberación");
  console.log("  ✓ cancelar nunca se presenta como un reembolso on-chain inmediato");
}

async function testPendingHasNoFunds() {
  const client = await createUser("cli");
  const provider = await createUser("prov");
  const tradeId = await insertTrade({
    flow: "cashout", clientId: client, providerId: provider, status: "pending", locked: false,
  });

  const result = await cancelTrade(fakeRequest, tradeId, client);
  strictEqual(result.refund_expected, false, "sin bloqueo no hay nada que devolver");
  strictEqual(result.refund_available_at, null);
  console.log("  ✓ en pending se suelta la reserva y no se promete reembolso");
}

// ── Tras la entrega, no se cancela ─────────────────────────────────────────

async function testNoCancellationAfterCashHandoff() {
  const client = await createUser("cli");
  const provider = await createUser("prov", false);
  const tradeId = await insertTrade({ flow: "cashout", clientId: client, providerId: provider, status: "revealing" });

  await db.execute(
    `INSERT INTO trade_cash_handoffs (trade_id, provider_id, claim_token_hash)
     VALUES ($1, $2, $3)`,
    [tradeId, provider, "hash"],
  );

  // Ni el cliente ni el proveedor, aunque este último esté pausado.
  for (const [actor, label] of [[client, "cliente"], [provider, "proveedor pausado"]] as const) {
    await expectRejected(
      () => cancelTrade(fakeRequest, tradeId, actor),
      "CASH_HANDOFF_CONFIRMED",
      `${label} cancelando tras la entrega`,
    );
  }
  console.log("  ✓ con la entrega confirmada nadie cancela: el efectivo ya cambió de manos");
}

// ── Terceros y estados terminales ──────────────────────────────────────────

async function testStrangerCannotCancel() {
  const client = await createUser("cli");
  const provider = await createUser("prov");
  const stranger = await createUser("x");
  const tradeId = await insertTrade({ flow: "cashout", clientId: client, providerId: provider, status: "locked" });

  await expectRejected(
    () => cancelTrade(fakeRequest, tradeId, stranger),
    "FORBIDDEN",
    "un tercero cancelando",
  );
  console.log("  ✓ nadie puede cancelar la operación de otros");
}

async function testTerminalStatesCannotBeCancelled() {
  const client = await createUser("cli");
  const provider = await createUser("prov");

  for (const status of ["completed", "refunded", "cancelled", "expired"]) {
    const tradeId = await insertTrade({ flow: "cashout", clientId: client, providerId: provider, status });
    await expectRejected(
      () => cancelTrade(fakeRequest, tradeId, client),
      "TRADE_NOT_CANCELLABLE",
      `cancelando una operación ${status}`,
    );
  }
  console.log("  ✓ una operación terminal no se cancela");
}

async function testDoubleCancellation() {
  const client = await createUser("cli");
  const provider = await createUser("prov");
  const tradeId = await insertTrade({ flow: "cashout", clientId: client, providerId: provider, status: "locked" });

  await cancelTrade(fakeRequest, tradeId, client);
  await expectRejected(
    () => cancelTrade(fakeRequest, tradeId, client),
    "TRADE_NOT_CANCELLABLE",
    "cancelando dos veces",
  );
  console.log("  ✓ cancelar dos veces no hace nada la segunda");
}

async function main() {
  console.log("\n  CASH-2 (#20/#31 follow-up) política de cancelación:\n");
  await testCashoutClientCanStopTheFlow();
  await testCashoutProviderNeedsToPauseFirst();
  await testUnavailableProviderMayWithdraw();
  await testAvailabilityIsCheckedOnTheProvider();
  await testDepositUnchanged();
  await testCancellationNeverReturnsFundsImmediately();
  await testPendingHasNoFunds();
  await testNoCancellationAfterCashHandoff();
  await testStrangerCannotCancel();
  await testTerminalStatesCannotBeCancelled();
  await testDoubleCancellation();
  console.log("\nAll CASH-2 cancellation policy tests passed.\n");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
