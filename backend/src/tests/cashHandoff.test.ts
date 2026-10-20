/**
 * CASH-4 · Cierre del cash-out desde el escaneo del proveedor.
 *
 * Seguimiento correctivo del issue cerrado #70, cuyos criterios exigian exito
 * solo tras un `release_tx_hash` real del backend.
 *
 * Lo que estaba roto y este archivo fija:
 *
 *   1. El escaneo autorizaba contra `seller_id`. En un cash-out el vendedor
 *      del escrow es el CLIENTE, asi que el proveedor real —el unico que
 *      puede escanear— recibia 403 en el unico paso que le tocaba.
 *   2. El escaneo quemaba el QR y no dejaba rastro. Si la firma o el envio
 *      fallaban despues, el proveedor quedaba atrapado: ya habia entregado el
 *      efectivo y su QR estaba gastado.
 *   3. Nada ataba el escaneo a la liberacion, asi que se podia liberar sin
 *      que la entrega hubiera ocurrido.
 *   4. El resumen devolvia el handle del comprador. Como en cash-out el
 *      proveedor ES el comprador, la pantalla le mostraba su propio nombre.
 *
 * Corre contra el store en memoria (ALLOW_IN_MEMORY_DB=true).
 *
 * LIMITE DE ALCANCE: la PK de `trade_cash_handoffs` —que impide fisicamente
 * dos entregas para la misma operacion— no se puede probar aqui, porque el
 * shim en memoria no tiene esquema. Esa parte se verifico contra PostgreSQL
 * real y se documenta en el PR.
 */

import { strictEqual, ok } from "assert";
import { randomBytes } from "crypto";
import db from "../db/schema.js";
import {
  getTradeSecret,
  merchantConfirmScan,
  completeTrade,
  prepareReleaseTrade,
  getCashHandoff,
  createTrade,
  lockTrade,
  revealTrade,
} from "../services/trade.service.js";
import { AppError } from "../utils/errors.js";

const fakeRequest = {
  ip: "127.0.0.1",
  headers: {},
  log: { info: () => {}, warn: () => {}, error: () => {} },
} as any;

let seq = 0;
async function createUser(label: string): Promise<string> {
  seq++;
  const suffix = String(seq).padStart(2, "0");
  // RED-1: los proveedores se dan de alta explicitamente. Desde que pertenecer
  // a Red MicoPay es un estado propio, crear una cuenta "disponible" ya no la
  // convierte en proveedora: esa inferencia era justo el defecto.
  const row = await db.getOne<{ id: string }>(
    `INSERT INTO users (stellar_address, username, phone_hash, merchant_available, availability, is_suspended, provider_status)
     VALUES ($1, $2, $3, $4, $5, $6, 'active')
     RETURNING id`,
    [
      `G${"D".repeat(53)}${suffix}`,
      `cash4_${label}_${suffix}`,
      `hash_cash4_${label}_${suffix}`,
      true,
      "online",
      false,
    ],
  );
  if (!row?.id) throw new Error(`Failed to seed user ${label}`);
  return row.id;
}

/**
 * Cash-out en estado `revealing`: el cliente bloquea la cripto como vendedor
 * del escrow, el proveedor la recibe como comprador y entrega el efectivo.
 */
async function insertCashoutTrade(clientId: string, providerId: string) {
  const { encryptSecret, generateTradeSecret } = await import(
    "../services/secret.service.js"
  );
  const { secret, secretHash } = generateTradeSecret();
  const { encrypted, nonce } = encryptSecret(secret);
  const expiresAt = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();

  const row = await db.getOne<{ id: string }>(
    `INSERT INTO trades
       (seller_id, buyer_id, flow, provider_id, amount_mxn, amount_stroops, platform_fee_mxn,
        secret_hash, secret_enc, secret_nonce, status, expires_at)
     VALUES ($1, $2, 'cashout', $3, $4, $5, $6, $7, $8, $9, 'revealing', $10)
     RETURNING id`,
    [clientId, providerId, providerId, 500, "5000000000", 4, secretHash, encrypted, nonce, expiresAt],
  );
  if (!row?.id) throw new Error("Failed to insert cashout trade");
  return row.id;
}

/** Depósito: el proveedor bloquea como vendedor, el cliente recibe. */
async function insertDepositTrade(clientId: string, providerId: string) {
  const { encryptSecret, generateTradeSecret } = await import(
    "../services/secret.service.js"
  );
  const { secret, secretHash } = generateTradeSecret();
  const { encrypted, nonce } = encryptSecret(secret);
  const expiresAt = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();

  const row = await db.getOne<{ id: string }>(
    `INSERT INTO trades
       (seller_id, buyer_id, flow, provider_id, amount_mxn, amount_stroops, platform_fee_mxn,
        secret_hash, secret_enc, secret_nonce, status, expires_at)
     VALUES ($1, $2, 'deposit', $3, $4, $5, $6, $7, $8, $9, 'revealing', $10)
     RETURNING id`,
    [providerId, clientId, providerId, 500, "5000000000", 4, secretHash, encrypted, nonce, expiresAt],
  );
  if (!row?.id) throw new Error("Failed to insert deposit trade");
  return row.id;
}

/** El QR lo emite quien revela: el vendedor del escrow. */
async function claimTokenFor(tradeId: string, escrowSellerId: string): Promise<string> {
  const { qr_payload } = await getTradeSecret(fakeRequest, tradeId, escrowSellerId, "127.0.0.1", "test");
  const token = new URL(qr_payload.replace("micopay://", "https://x/")).searchParams.get("claim_token");
  if (!token) throw new Error(`No claim token in payload: ${qr_payload}`);
  return token;
}

async function expectAppError(fn: () => Promise<unknown>, code: string, what: string) {
  try {
    await fn();
  } catch (err) {
    if (err instanceof AppError) {
      strictEqual(err.code, code, `${what}: expected ${code}, got ${err.code}`);
      return;
    }
    throw err;
  }
  throw new Error(`${what}: expected ${code} but nothing was thrown`);
}

// ── 1. Autorización ────────────────────────────────────────────────────────

/** El defecto central: el proveedor real recibía 403 al escanear. */
async function testCashoutProviderCanScan() {
  const clientId = await createUser("client");
  const providerId = await createUser("provider");
  const tradeId = await insertCashoutTrade(clientId, providerId);
  const token = await claimTokenFor(tradeId, clientId);

  const result = await merchantConfirmScan(fakeRequest, tradeId, providerId, token);
  strictEqual(result.trade_id, tradeId, "el proveedor del cash-out puede escanear");
  strictEqual(result.flow, "cashout", "el resumen trae el flujo canónico");
  strictEqual(result.resumed, false, "el primer escaneo no es una reanudación");
  console.log("  ✓ el proveedor de un cash-out puede escanear (antes recibía 403)");
}

/** El resumen debe nombrar al cliente, no a quien escanea. */
async function testSummaryNamesTheClient() {
  const clientId = await createUser("client");
  const providerId = await createUser("provider");
  const tradeId = await insertCashoutTrade(clientId, providerId);
  const token = await claimTokenFor(tradeId, clientId);

  const result = await merchantConfirmScan(fakeRequest, tradeId, providerId, token);
  const client = await db.getOne<{ username: string }>("SELECT username FROM users WHERE id = $1", [clientId]);
  const provider = await db.getOne<{ username: string }>("SELECT username FROM users WHERE id = $1", [providerId]);

  strictEqual(result.client_handle, client?.username, "la contraparte mostrada es el cliente");
  ok(result.client_handle !== provider?.username, "el proveedor no ve su propio nombre como contraparte");
  console.log("  ✓ el resumen nombra al cliente, no a quien escanea");
}

/** Un tercero, y también el cliente, no pueden escanear. */
async function testNonProviderIsRejected() {
  const clientId = await createUser("client");
  const providerId = await createUser("provider");
  const strangerId = await createUser("stranger");
  const tradeId = await insertCashoutTrade(clientId, providerId);
  const token = await claimTokenFor(tradeId, clientId);

  await expectAppError(
    () => merchantConfirmScan(fakeRequest, tradeId, strangerId, token),
    "NOT_TRADE_PROVIDER",
    "un tercero escanea",
  );
  await expectAppError(
    () => merchantConfirmScan(fakeRequest, tradeId, clientId, token),
    "NOT_TRADE_PROVIDER",
    "el propio cliente escanea",
  );
  console.log("  ✓ ni un tercero ni el cliente pueden escanear");
}

// ── 2. Entrega durable y reanudación ───────────────────────────────────────

/** Lo que hacía imposible reintentar: el QR quemado sin constancia. */
async function testHandoffIsDurableAndResumable() {
  const clientId = await createUser("client");
  const providerId = await createUser("provider");
  const tradeId = await insertCashoutTrade(clientId, providerId);
  const token = await claimTokenFor(tradeId, clientId);

  const first = await merchantConfirmScan(fakeRequest, tradeId, providerId, token);
  strictEqual(first.resumed, false);

  const handoff = await getCashHandoff(tradeId);
  ok(handoff, "la entrega quedó registrada");
  strictEqual(handoff!.provider_id, providerId, "la entrega pertenece al proveedor que escaneó");

  // Reintento del MISMO proveedor: reanuda, no falla.
  const second = await merchantConfirmScan(fakeRequest, tradeId, providerId, token);
  strictEqual(second.resumed, true, "el reintento del mismo proveedor reanuda");
  strictEqual(second.trade_id, tradeId);
  strictEqual(second.handoff_confirmed_at, first.handoff_confirmed_at, "es la MISMA entrega, no una segunda");
  console.log("  ✓ la entrega es durable y el mismo proveedor puede reanudarla");
}

/** Reanudar es del proveedor; otro actor no hereda su entrega. */
async function testAnotherActorCannotResume() {
  const clientId = await createUser("client");
  const providerId = await createUser("provider");
  const strangerId = await createUser("stranger");
  const tradeId = await insertCashoutTrade(clientId, providerId);
  const token = await claimTokenFor(tradeId, clientId);

  await merchantConfirmScan(fakeRequest, tradeId, providerId, token);
  await expectAppError(
    () => merchantConfirmScan(fakeRequest, tradeId, strangerId, token),
    "NOT_TRADE_PROVIDER",
    "un tercero intenta reanudar",
  );
  console.log("  ✓ otro actor no puede reanudar una entrega ajena");
}

/** Un QR que nunca se emitió sigue siendo rechazado (SEC-02). */
async function testForeignTokenStillRejected() {
  const clientId = await createUser("client");
  const providerId = await createUser("provider");
  const tradeId = await insertCashoutTrade(clientId, providerId);

  await expectAppError(
    () => merchantConfirmScan(fakeRequest, tradeId, providerId, randomBytes(32).toString("hex")),
    "INVALID_CLAIM_TOKEN",
    "token nunca emitido",
  );
  console.log("  ✓ un token que nunca se emitió sigue rechazándose (SEC-02)");
}

// ── 3. No se libera sin entrega ────────────────────────────────────────────

/** El corazón del issue: no hay liberación sin efectivo entregado. */
async function testCannotReleaseWithoutHandoff() {
  const clientId = await createUser("client");
  const providerId = await createUser("provider");
  const tradeId = await insertCashoutTrade(clientId, providerId);

  // El proveedor ES el comprador del escrow, así que pasa la comprobación de
  // rol; lo que debe detenerlo es la ausencia de entrega.
  await expectAppError(
    () => prepareReleaseTrade(fakeRequest, tradeId, providerId),
    "CASH_HANDOFF_REQUIRED",
    "preparar la liberación sin haber escaneado",
  );
  await expectAppError(
    () => completeTrade(fakeRequest, tradeId, providerId),
    "CASH_HANDOFF_REQUIRED",
    "completar sin haber escaneado",
  );
  console.log("  ✓ un cash-out no se puede liberar sin la constancia de entrega");
}

/** Tras escanear, el mismo proveedor sí puede cerrar. */
async function testReleaseSucceedsAfterHandoff() {
  const clientId = await createUser("client");
  const providerId = await createUser("provider");
  const tradeId = await insertCashoutTrade(clientId, providerId);
  const token = await claimTokenFor(tradeId, clientId);

  await merchantConfirmScan(fakeRequest, tradeId, providerId, token);
  const result = await completeTrade(fakeRequest, tradeId, providerId);

  strictEqual(result.status, "completed");
  ok(result.release_tx_hash, "hay un release_tx_hash");
  const row = await db.getOne<{ status: string; release_tx_hash: string }>(
    "SELECT status, release_tx_hash FROM trades WHERE id = $1",
    [tradeId],
  );
  strictEqual(row?.status, "completed", "la operación quedó completada");
  ok(row?.release_tx_hash, "el hash quedó persistido, no solo devuelto");
  console.log("  ✓ tras la entrega, el proveedor cierra la operación");
}

/** Perder la respuesta de red no puede liberar dos veces. */
async function testCompletionIsIdempotent() {
  const clientId = await createUser("client");
  const providerId = await createUser("provider");
  const tradeId = await insertCashoutTrade(clientId, providerId);
  const token = await claimTokenFor(tradeId, clientId);

  await merchantConfirmScan(fakeRequest, tradeId, providerId, token);
  const first = await completeTrade(fakeRequest, tradeId, providerId);
  const second = await completeTrade(fakeRequest, tradeId, providerId);

  strictEqual(second.status, "completed", "reintentar devuelve completado");
  strictEqual(
    second.release_tx_hash,
    first.release_tx_hash,
    "devuelve la MISMA liberación, no una segunda",
  );
  console.log("  ✓ completar es idempotente: no libera dos veces");
}

/** Releer una operación ya cerrada es seguro para quien la atendió. */
async function testScanAfterCompletionIsReadable() {
  const clientId = await createUser("client");
  const providerId = await createUser("provider");
  const strangerId = await createUser("stranger");
  const tradeId = await insertCashoutTrade(clientId, providerId);
  const token = await claimTokenFor(tradeId, clientId);

  await merchantConfirmScan(fakeRequest, tradeId, providerId, token);
  await completeTrade(fakeRequest, tradeId, providerId);

  const reread = await merchantConfirmScan(fakeRequest, tradeId, providerId, token);
  strictEqual(reread.status, "completed");
  strictEqual(reread.resumed, true);
  ok(reread.release_tx_hash, "la relectura trae el hash de la liberación");

  await expectAppError(
    () => merchantConfirmScan(fakeRequest, tradeId, strangerId, token),
    "NOT_TRADE_PROVIDER",
    "un tercero relee una operación cerrada",
  );
  console.log("  ✓ releer una operación cerrada es seguro y solo para su proveedor");
}

// ── 4. El depósito no se rompe ─────────────────────────────────────────────

/**
 * La compuerta es solo del cash-out. En depósito el cliente completa desde su
 * propia pantalla y no hay efectivo que entregar contra el QR del agente.
 */
async function testDepositIsNotRegressed() {
  const clientId = await createUser("client");
  const providerId = await createUser("provider");
  const tradeId = await insertDepositTrade(clientId, providerId);

  // El cliente es el comprador del escrow en depósito: completa sin entrega.
  const result = await completeTrade(fakeRequest, tradeId, clientId);
  strictEqual(result.status, "completed", "el depósito cierra sin constancia de entrega");
  strictEqual(await getCashHandoff(tradeId), null, "y no inventa una entrega");
  console.log("  ✓ el depósito no quedó regresado por la compuerta");
}

/** En depósito el proveedor es el vendedor: su escaneo sigue autorizado. */
async function testDepositProviderCanStillScan() {
  const clientId = await createUser("client");
  const providerId = await createUser("provider");
  const tradeId = await insertDepositTrade(clientId, providerId);
  const token = await claimTokenFor(tradeId, providerId);

  const result = await merchantConfirmScan(fakeRequest, tradeId, providerId, token);
  strictEqual(result.flow, "deposit");
  const client = await db.getOne<{ username: string }>("SELECT username FROM users WHERE id = $1", [clientId]);
  strictEqual(result.client_handle, client?.username, "también aquí la contraparte es el cliente");
  console.log("  ✓ en depósito el proveedor sigue pudiendo escanear");
}


// ── 5. Integración de dos cuentas ──────────────────────────────────────────

/**
 * El recorrido completo del caso estrella, con dos cuentas distintas y usando
 * el servicio real de punta a punta: crear -> bloquear -> revelar -> escanear
 * -> liberar. Es el criterio 9 del issue.
 */
async function testTwoAccountCashoutEndToEnd() {
  const clientId = await createUser("e2e_client");
  const providerId = await createUser("e2e_provider");

  // 1. El cliente crea el cash-out. CASH-1 deriva provider_id server-side.
  const created = await createTrade({
    request: fakeRequest,
    sellerId: clientId,
    buyerId: providerId,
    flow: "cashout",
    amountMxn: 500,
  });
  strictEqual(created.flow, "cashout");
  strictEqual(created.provider_id, providerId, "el proveedor es la contraparte");
  strictEqual(created.status, "pending");

  // 2. El cliente bloquea la cripto: es el vendedor del escrow.
  await lockTrade(fakeRequest, created.id, clientId);
  let row = await db.getOne<{ status: string }>("SELECT status FROM trades WHERE id = $1", [created.id]);
  strictEqual(row?.status, "locked", "locked");

  // 3. El cliente revela para generar el QR de entrega.
  await revealTrade(fakeRequest, created.id, clientId);
  row = await db.getOne<{ status: string }>("SELECT status FROM trades WHERE id = $1", [created.id]);
  strictEqual(row?.status, "revealing", "revealing");

  // 4. El proveedor escanea. Este es el paso que antes le daba 403.
  const token = await claimTokenFor(created.id, clientId);
  const scan = await merchantConfirmScan(fakeRequest, created.id, providerId, token);
  strictEqual(scan.flow, "cashout");
  strictEqual(scan.resumed, false);

  // 5. El proveedor libera; el backend nunca tuvo su llave privada.
  const done = await completeTrade(fakeRequest, created.id, providerId);
  strictEqual(done.status, "completed");

  const final = await db.getOne<{ status: string; release_tx_hash: string | null }>(
    "SELECT status, release_tx_hash FROM trades WHERE id = $1",
    [created.id],
  );
  strictEqual(final?.status, "completed", "completed");
  ok(final?.release_tx_hash, "quedó un release_tx_hash persistido");
  console.log("  ✓ dos cuentas: creado → locked → revealing → escaneo → completed");
}

async function main() {
  console.log("\n  CASH-4 (#70 follow-up) cierre del cash-out:\n");
  await testCashoutProviderCanScan();
  await testSummaryNamesTheClient();
  await testNonProviderIsRejected();
  await testHandoffIsDurableAndResumable();
  await testAnotherActorCannotResume();
  await testForeignTokenStillRejected();
  await testCannotReleaseWithoutHandoff();
  await testReleaseSucceedsAfterHandoff();
  await testCompletionIsIdempotent();
  await testScanAfterCompletionIsReadable();
  await testDepositIsNotRegressed();
  await testDepositProviderCanStillScan();
  await testTwoAccountCashoutEndToEnd();
  console.log("\nAll CASH-4 cash handoff tests passed.\n");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
