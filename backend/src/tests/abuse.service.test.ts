import { strictEqual, ok, rejects } from "assert";
import db from "../db/schema.js";
import {
  assertCanCreateTrade,
  pauseUser,
  unpauseUser,
} from "../services/abuse.service.js";
import { RiskBlockedError } from "../utils/errors.js";

async function seedUsers() {
  const seller = await db.getOne<{ id: string }>(
    `INSERT INTO users (stellar_address, username, phone_hash, merchant_available, availability, is_suspended)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id`,
    ["GSELLER1111111111111111111111111111111111111111111111111111", "seller_abuse", "hash_a", true, "online", false],
  );
  const buyer = await db.getOne<{ id: string }>(
    `INSERT INTO users (stellar_address, username, phone_hash, merchant_available, availability, is_suspended)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id`,
    ["GBUYER11111111111111111111111111111111111111111111111111111", "buyer_abuse", "hash_b", true, "online", false],
  );
  if (!seller?.id || !buyer?.id) throw new Error("Failed to seed users");
  return { sellerId: seller.id, buyerId: buyer.id };
}

async function testSelfTradeBlocked() {
  const { sellerId } = await seedUsers();
  const mockRequest = { ip: "10.0.0.1", headers: {} } as any;

  await rejects(
    () =>
      assertCanCreateTrade({
        request: mockRequest,
        buyerId: sellerId,
        sellerId,
        // CASH-9: la firma exige flujo y proveedor explicitos. Un deposito
        // donde ambos lados son la misma persona sigue siendo invalido.
        flow: "deposit",
        providerId: sellerId,
        amountMxn: 500,
      }),
    (err: unknown) => {
      ok(err instanceof RiskBlockedError || (err as Error).message.includes("mismo"));
      return true;
    },
  );
  console.log("Self-trade path: blocked via trade.service ValidationError (separate test)");
}

async function testSuspendedUserBlocked() {
  const { sellerId, buyerId } = await seedUsers();
  await pauseUser(sellerId, "test_suspend", null);

  const mockRequest = { ip: "10.0.0.2", headers: { "x-device-id": "device-test-1" } } as any;

  await rejects(
    () =>
      assertCanCreateTrade({
        request: mockRequest,
        buyerId,
        sellerId,
        // Deposito: el proveedor es el vendedor del escrow.
        flow: "deposit",
        providerId: sellerId,
        amountMxn: 500,
      }),
    (err: unknown) =>
      err instanceof RiskBlockedError &&
      (err.code === "MERCHANT_SUSPENDED" || err.code === "ACCOUNT_SUSPENDED"),
  );

  await unpauseUser(sellerId, null);
  console.log("Suspended merchant: blocked create trade");
}

async function testRelatedAccountsBlocked() {
  const seller = await db.getOne<{ id: string }>(
    `INSERT INTO users (stellar_address, username, phone_hash, merchant_available, availability, is_suspended)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id`,
    ["GREL111111111111111111111111111111111111111111111111111111", "rel_seller", "same_hash", true, "online", false],
  );
  const buyer = await db.getOne<{ id: string }>(
    `INSERT INTO users (stellar_address, username, phone_hash, merchant_available, availability, is_suspended)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id`,
    ["GREL222222222222222222222222222222222222222222222222222222", "rel_buyer", "same_hash", true, "online", false],
  );

  const mockRequest = { ip: "10.0.0.3", headers: {} } as any;

  await rejects(
    () =>
      assertCanCreateTrade({
        request: mockRequest,
        buyerId: buyer!.id,
        sellerId: seller!.id,
        flow: "deposit",
        providerId: seller!.id,
        amountMxn: 500,
      }),
    (err: unknown) => err instanceof RiskBlockedError && err.code === "RELATED_ACCOUNTS",
  );
  console.log("Related accounts (shared phone_hash): blocked");
}

async function run() {
  console.log("Running abuse.service tests...");
  await testSuspendedUserBlocked();
  await testRelatedAccountsBlocked();
  await testSelfTradeBlocked();
  console.log("All abuse.service tests passed.");
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
