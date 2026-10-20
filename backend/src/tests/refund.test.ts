/**
 * Regression tests for docs/AUDIT_MOBILE_MAINNET.md finding B3:
 *   - Cancelling a locked/revealing trade must leave a path to recover the
 *     on-chain funds (refundTrade must accept the seller, not just the buyer,
 *     and must not reject an already-'cancelled' trade).
 *   - `sweepPendingRefunds` must settle cancelled-but-still-locked trades
 *     automatically once they expire, without requiring any user action.
 *
 * Runs against the in-memory DB with MOCK_STELLAR=true (no real Soroban call
 * — `executeRefundOnChain` short-circuits to a `mock_refund_*` hash), so this
 * is a pure state-machine test.
 */

import { strictEqual, ok } from "assert";
import db from "../db/schema.js";
import {
  cancelTrade,
  refundTrade,
  sweepPendingRefunds,
} from "../services/trade.service.js";
import { ConflictError, AppError } from "../utils/errors.js";

const fakeRequest = {
  ip: "127.0.0.1",
  headers: {},
  log: { info: () => {}, warn: () => {}, error: () => {} },
} as any;

async function createUser(suffix: string): Promise<string> {
  const row = await db.getOne<{ id: string }>(
    `INSERT INTO users (stellar_address, username, phone_hash, merchant_available, availability, is_suspended)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id`,
    [
      `G${"B".repeat(54)}${suffix.padStart(1, "0")}`,
      `user_refund_${suffix}`,
      `hash_refund_${suffix}`,
      true,
      "online",
      false,
    ],
  );
  if (!row?.id) throw new Error(`Failed to seed user ${suffix}`);
  return row.id;
}

/** Insert a 'locked' trade with a mock lock_tx_hash, optionally already expired. */
async function insertLockedTrade(
  sellerId: string,
  buyerId: string,
  opts: { expired: boolean },
): Promise<string> {
  const { encryptSecret, generateTradeSecret } = await import("../services/secret.service.js");
  const { secret, secretHash } = generateTradeSecret();
  const { encrypted, nonce } = encryptSecret(secret);
  const expiresAt = new Date(
    Date.now() + (opts.expired ? -60_000 : 2 * 60 * 60 * 1000),
  ).toISOString();
  const lockTxHash = `mock_lock_${Math.random().toString(36).slice(2)}`;

  const row = await db.getOne<{ id: string }>(
    `INSERT INTO trades
       (seller_id, buyer_id, flow, provider_id, amount_mxn, amount_stroops, platform_fee_mxn,
        secret_hash, secret_enc, secret_nonce, status, expires_at, lock_tx_hash, locked_at)
     VALUES ($1, $2, 'deposit', $3, $4, $5, $6, $7, $8, $9, 'locked', $10, $11, NOW())
     RETURNING id`,
    [sellerId, buyerId, sellerId, 500, "5000000000", 4, secretHash, encrypted, nonce, expiresAt, lockTxHash],
  );
  if (!row?.id) throw new Error("Failed to insert trade");
  return row.id;
}

async function getTrade(id: string) {
  return db.getOne<{ status: string; release_tx_hash: string | null; lock_tx_hash: string | null }>(
    "SELECT status, release_tx_hash, lock_tx_hash FROM trades WHERE id = $1",
    [id],
  );
}

// ── Tests ──────────────────────────────────────────────────────────────────

/** Cashout shape: the app-user is `seller_id` (they locked their own crypto). */
async function testSellerCanRefundAfterCancellingLockedCashoutTrade() {
  const sellerId = await createUser("s1"); // the human who locked funds (cashout caller)
  const buyerId = await createUser("b1"); // the merchant/agent
  const tradeId = await insertLockedTrade(sellerId, buyerId, { expired: true });

  // Buyer (merchant) cancels the locked trade — matches existing cancelTrade behavior.
  const cancelResult = await cancelTrade(fakeRequest, tradeId, buyerId);
  strictEqual(cancelResult.status, "cancelled");
  ok(cancelResult.refund_expected, "cancel of a locked trade should flag refund_expected");

  const afterCancel = await getTrade(tradeId);
  strictEqual(afterCancel?.status, "cancelled");
  ok(afterCancel?.release_tx_hash == null, "release_tx_hash should still be unset after cancel");

  // The SELLER (whose funds are locked) must be able to trigger the refund —
  // this is the exact permission bug fixed for B3 (previously buyer-only).
  const refundResult = await refundTrade(fakeRequest, tradeId, sellerId);
  strictEqual(refundResult.status, "refunded");
  ok(refundResult.refund_tx_hash.startsWith("mock_refund_"));

  const afterRefund = await getTrade(tradeId);
  strictEqual(afterRefund?.status, "refunded");
  ok(afterRefund?.release_tx_hash, "release_tx_hash should be set after a successful refund");

  console.log("  ✓ seller can refund a cancelled+expired locked trade (B3 permission fix)");
}

async function testRefundRejectedBeforeExpiry() {
  const sellerId = await createUser("s2");
  const buyerId = await createUser("b2");
  const tradeId = await insertLockedTrade(sellerId, buyerId, { expired: false });

  await cancelTrade(fakeRequest, tradeId, buyerId);

  let threw = false;
  try {
    await refundTrade(fakeRequest, tradeId, sellerId);
  } catch (err) {
    threw = true;
    ok(err instanceof AppError, "expected an AppError");
  }
  ok(threw, "refund before expiry should be rejected");

  console.log("  ✓ refund is rejected before the contract timeout has passed");
}

async function testRefundIsNotDoubleSpendable() {
  const sellerId = await createUser("s3");
  const buyerId = await createUser("b3");
  const tradeId = await insertLockedTrade(sellerId, buyerId, { expired: true });

  await cancelTrade(fakeRequest, tradeId, buyerId);
  await refundTrade(fakeRequest, tradeId, sellerId);

  let threw = false;
  try {
    await refundTrade(fakeRequest, tradeId, sellerId);
  } catch (err) {
    threw = true;
    ok(err instanceof ConflictError, `expected ConflictError, got ${(err as Error)?.constructor?.name}`);
  }
  ok(threw, "a second refund attempt on an already-refunded trade should be rejected");

  console.log("  ✓ refund cannot be replayed on an already-refunded trade");
}

async function testSweepAutoRefundsCancelledExpiredTrades() {
  const sellerId = await createUser("s4");
  const buyerId = await createUser("b4");
  const tradeId = await insertLockedTrade(sellerId, buyerId, { expired: true });

  // Cancel, but nobody ever calls POST /trades/:id/refund manually.
  await cancelTrade(fakeRequest, tradeId, buyerId);
  const beforeSweep = await getTrade(tradeId);
  strictEqual(beforeSweep?.status, "cancelled");

  const { swept, failed } = await sweepPendingRefunds(fakeRequest);
  ok(swept >= 1, `expected sweep to refund at least 1 trade, got swept=${swept} failed=${failed}`);

  const afterSweep = await getTrade(tradeId);
  strictEqual(afterSweep?.status, "refunded");

  console.log("  ✓ sweepPendingRefunds auto-refunds a cancelled+expired trade with no user action");
}

async function testSweepIgnoresNonExpiredCancelledTrades() {
  const sellerId = await createUser("s5");
  const buyerId = await createUser("b5");
  const tradeId = await insertLockedTrade(sellerId, buyerId, { expired: false });

  await cancelTrade(fakeRequest, tradeId, buyerId);
  await sweepPendingRefunds(fakeRequest);

  const trade = await getTrade(tradeId);
  strictEqual(trade?.status, "cancelled", "sweep must not touch trades that haven't hit the contract timeout yet");

  console.log("  ✓ sweepPendingRefunds leaves not-yet-expired cancelled trades alone");
}

async function main() {
  console.log("\nB3 — Cancel/refund regression tests\n");
  await testSellerCanRefundAfterCancellingLockedCashoutTrade();
  await testRefundRejectedBeforeExpiry();
  await testRefundIsNotDoubleSpendable();
  await testSweepAutoRefundsCancelledExpiredTrades();
  await testSweepIgnoresNonExpiredCancelledTrades();
  console.log("\nAll B3 refund tests passed.\n");
}

main().catch((err) => {
  console.error("❌ B3 refund tests failed:", err);
  process.exit(1);
});
