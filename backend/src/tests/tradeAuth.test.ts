/**
 * SEC-10 — Regression tests: Role-based authorization in the trade state machine.
 *
 * Verifies that the role guards in trade.service.ts are upheld:
 *   - lockTrade:      only the seller may lock         (ForbiddenError)
 *   - revealTrade:    only the seller may reveal       (ForbiddenError)
 *   - getTradeSecret: only the seller may read secret  (AuthError / httpStatus 403)
 *   - completeTrade:  only the buyer may complete      (ForbiddenError)
 *
 * Also confirms that a third party (neither buyer nor seller) is rejected by
 * getTradeById (403) and therefore cannot reach any of those guarded paths.
 *
 * Runs against the in-memory DB (ALLOW_IN_MEMORY_DB=true, no PostgreSQL needed).
 */

import { strictEqual, ok } from "assert";
import db from "../db/schema.js";
import {
  lockTrade,
  revealTrade,
  getTradeSecret,
  completeTrade,
  getTradeById,
} from "../services/trade.service.js";
import {
  ForbiddenError,
  AuthError,
  AppError,
} from "../utils/errors.js";

// ── Helpers ────────────────────────────────────────────────────────────────

/** Minimal Fastify-request stub used by service functions. */
const fakeRequest = {
  ip: "127.0.0.1",
  headers: {},
  log: {
    info: () => {},
    warn: () => {},
    error: () => {},
  },
} as any;

async function createUser(suffix: string): Promise<string> {
  const row = await db.getOne<{ id: string }>(
    `INSERT INTO users (stellar_address, username, phone_hash, merchant_available, availability, is_suspended)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id`,
    [
      `G${"A".repeat(54)}${suffix.padStart(1, "0")}`,
      `user_sec10_${suffix}`,
      `hash_sec10_${suffix}`,
      true,
      "online",
      false,
    ],
  );
  if (!row?.id) throw new Error(`Failed to seed user ${suffix}`);
  return row.id;
}

/**
 * Insert a trade row directly into the in-memory store at a specific status.
 * Returns the trade id.
 */
async function insertTrade(
  sellerId: string,
  buyerId: string,
  status: string,
): Promise<string> {
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
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     RETURNING id`,
    [
      sellerId,
      buyerId,
      "deposit",
      sellerId,
      500,
      "5000000000",
      4,
      secretHash,
      encrypted,
      nonce,
      status,
      expiresAt,
    ],
  );
  if (!row?.id) throw new Error("Failed to insert trade");
  return row.id;
}

/** Assert that calling `fn()` throws an AppError with httpStatus 403. */
async function assert403(fn: () => Promise<unknown>, label: string) {
  let threw = false;
  try {
    await fn();
  } catch (err) {
    threw = true;
    ok(
      err instanceof AppError && err.httpStatus === 403,
      `${label}: expected AppError(403) but got ${(err as Error)?.constructor?.name} ${(err as any)?.httpStatus}`,
    );
  }
  ok(threw, `${label}: expected an error to be thrown but none was`);
}

// ── Tests ──────────────────────────────────────────────────────────────────

async function testLockTradeByBuyerIsRejected() {
  const sellerId = await createUser("s1");
  const buyerId = await createUser("b1");
  const tradeId = await insertTrade(sellerId, buyerId, "pending");

  await assert403(
    () => lockTrade(fakeRequest, tradeId, buyerId),
    "lockTrade called by buyer",
  );
  console.log("  ✓ lockTrade: buyer cannot lock (403 ForbiddenError)");
}

async function testLockTradeByThirdPartyIsRejected() {
  const sellerId = await createUser("s2");
  const buyerId = await createUser("b2");
  const thirdId = await createUser("t2");
  const tradeId = await insertTrade(sellerId, buyerId, "pending");

  await assert403(
    () => lockTrade(fakeRequest, tradeId, thirdId),
    "lockTrade called by third party",
  );
  console.log("  ✓ lockTrade: third party cannot lock (403 ForbiddenError)");
}

async function testRevealTradeByBuyerIsRejected() {
  const sellerId = await createUser("s3");
  const buyerId = await createUser("b3");
  const tradeId = await insertTrade(sellerId, buyerId, "locked");

  await assert403(
    () => revealTrade(fakeRequest, tradeId, buyerId),
    "revealTrade called by buyer",
  );
  console.log("  ✓ revealTrade: buyer cannot reveal (403 ForbiddenError)");
}

async function testRevealTradeByThirdPartyIsRejected() {
  const sellerId = await createUser("s4");
  const buyerId = await createUser("b4");
  const thirdId = await createUser("t4");
  const tradeId = await insertTrade(sellerId, buyerId, "locked");

  await assert403(
    () => revealTrade(fakeRequest, tradeId, thirdId),
    "revealTrade called by third party",
  );
  console.log("  ✓ revealTrade: third party cannot reveal (403 ForbiddenError)");
}

async function testGetTradeSecretByBuyerIsRejected() {
  const sellerId = await createUser("s5");
  const buyerId = await createUser("b5");
  const tradeId = await insertTrade(sellerId, buyerId, "revealing");

  await assert403(
    () => getTradeSecret(fakeRequest, tradeId, buyerId, "127.0.0.1", "test"),
    "getTradeSecret called by buyer",
  );
  console.log("  ✓ getTradeSecret: buyer cannot read secret (403 AuthError)");
}

async function testGetTradeSecretByThirdPartyIsRejected() {
  const sellerId = await createUser("s6");
  const buyerId = await createUser("b6");
  const thirdId = await createUser("t6");
  const tradeId = await insertTrade(sellerId, buyerId, "revealing");

  await assert403(
    () => getTradeSecret(fakeRequest, tradeId, thirdId, "127.0.0.1", "test"),
    "getTradeSecret called by third party",
  );
  console.log(
    "  ✓ getTradeSecret: third party cannot read secret (403 AuthError)",
  );
}

async function testCompleteTradeBySellerIsRejected() {
  const sellerId = await createUser("s7");
  const buyerId = await createUser("b7");
  const tradeId = await insertTrade(sellerId, buyerId, "revealing");

  await assert403(
    () => completeTrade(fakeRequest, tradeId, sellerId),
    "completeTrade called by seller",
  );
  console.log("  ✓ completeTrade: seller cannot complete (403 ForbiddenError)");
}

async function testCompleteTradeByThirdPartyIsRejected() {
  const sellerId = await createUser("s8");
  const buyerId = await createUser("b8");
  const thirdId = await createUser("t8");
  const tradeId = await insertTrade(sellerId, buyerId, "revealing");

  await assert403(
    () => completeTrade(fakeRequest, tradeId, thirdId),
    "completeTrade called by third party",
  );
  console.log(
    "  ✓ completeTrade: third party cannot complete (403 ForbiddenError)",
  );
}

async function testGetTradeByIdThirdPartyIsRejected() {
  const sellerId = await createUser("s9");
  const buyerId = await createUser("b9");
  const thirdId = await createUser("t9");
  const tradeId = await insertTrade(sellerId, buyerId, "pending");

  await assert403(
    () => getTradeById(tradeId, thirdId),
    "getTradeById called by third party",
  );
  console.log(
    "  ✓ getTradeById: third party cannot view trade details (403 AuthError)",
  );
}

// ── Runner ─────────────────────────────────────────────────────────────────

async function run() {
  console.log("\nSEC-10 — Role-based authorization regression tests\n");

  await testLockTradeByBuyerIsRejected();
  await testLockTradeByThirdPartyIsRejected();
  await testRevealTradeByBuyerIsRejected();
  await testRevealTradeByThirdPartyIsRejected();
  await testGetTradeSecretByBuyerIsRejected();
  await testGetTradeSecretByThirdPartyIsRejected();
  await testCompleteTradeBySellerIsRejected();
  await testCompleteTradeByThirdPartyIsRejected();
  await testGetTradeByIdThirdPartyIsRejected();

  console.log("\nAll SEC-10 role-authorization tests passed.\n");
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
