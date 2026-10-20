import { strictEqual, ok } from "assert";
import { randomUUID } from "crypto";
import Fastify from "fastify";
import db from "../db/schema.js";
import { config } from "../config.js";
import { adminRoutes } from "../routes/admin.js";

async function seedUser(username: string, createdAt: string, merchantAvailable = false) {
  const stellarAddress = `G${randomUUID().replace(/-/g, "").toUpperCase().slice(0, 55)}`;
  const user = await db.getOne<{ id: string }>(
    `INSERT INTO users (stellar_address, username, merchant_available, created_at, kyc_level, kyc_level_verified_at)
     VALUES ($1, $2, $3, $4, 0, NULL)
     RETURNING id`,
    [stellarAddress, username, merchantAvailable, createdAt],
  );
  if (!user?.id) throw new Error(`Failed to seed user ${username}`);
  return user.id;
}

async function seedTrade(input: {
  id: string;
  sellerId: string;
  buyerId: string;
  amountMxn: number;
  status: string;
  createdAt: string;
  completedAt?: string;
}) {
  await db.execute(
    `INSERT INTO trades (id, seller_id, buyer_id, flow, provider_id, amount_mxn, amount_stroops, secret_hash, status, created_at, completed_at, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
    [
      input.id,
      input.sellerId,
      input.buyerId,
      'deposit',
      input.sellerId,
      input.amountMxn,
      (input.amountMxn * 10000000).toString(),
      `hash_${randomUUID()}`,
      input.status,
      input.createdAt,
      input.completedAt ?? null,
      input.createdAt,
    ],
  );
}

async function testOverviewAnalytics() {
  Object.assign(config, { adminApiKey: "test-admin-key" });

  const app = Fastify();
  await app.register(adminRoutes);

  const merchant1 = await seedUser("merchant_alpha", "2026-06-01T10:00:00.000Z", true);
  const merchant2 = await seedUser("merchant_beta", "2025-01-01T10:00:00.000Z", true);
  const buyer = await seedUser("buyer_alpha", "2026-06-02T10:00:00.000Z", false);

  await seedTrade({
    id: randomUUID(),
    sellerId: merchant1,
    buyerId: buyer,
    amountMxn: 1000,
    status: "completed",
    createdAt: "2026-06-10T10:00:00.000Z",
    completedAt: "2026-06-10T11:00:00.000Z",
  });

  await seedTrade({
    id: randomUUID(),
    sellerId: merchant1,
    buyerId: buyer,
    amountMxn: 300,
    status: "cancelled",
    createdAt: "2026-06-20T10:00:00.000Z",
    completedAt: null,
  });

  await seedTrade({
    id: randomUUID(),
    sellerId: merchant2,
    buyerId: buyer,
    amountMxn: 100,
    status: "disputed",
    createdAt: "2026-07-02T10:00:00.000Z",
    completedAt: null,
  });

  const res = await app.inject({
    method: "GET",
    url: "/admin/analytics/overview?from=2026-06-01T00:00:00.000Z&to=2026-06-30T23:59:59.999Z&active_merchant_window_days=30",
    headers: { "x-admin-api-key": "test-admin-key" },
  });

  strictEqual(res.statusCode, 200, "analytics endpoint should respond with 200");
  const payload = res.json();

  ok(payload.summary, "response should include a summary block");
  strictEqual(payload.summary.total_trade_count, 2, "only trades created in the requested range should count");
  strictEqual(payload.summary.total_trade_volume_mxn, 1300, "trade volume should sum the matching range");
  strictEqual(payload.summary.completed.count, 1, "completed trade count should be reported");
  strictEqual(payload.summary.cancelled.count, 1, "cancelled trade count should be reported");
  strictEqual(payload.summary.disputed.count, 0, "disputed trade count should be 0 for the requested range");
  strictEqual(payload.summary.active_merchants, 1, "only merchants active in the window should be counted");
  strictEqual(payload.summary.new_merchants_in_range, 1, "new merchants created in the range should be counted");
  strictEqual(payload.summary.completion_rate, 0.5, "completion rate should reflect completed trades over total trades");
  strictEqual(payload.summary.average_time_to_completion_seconds, 3600, "average completion time should be derived from completed trades");

  console.log("admin analytics overview test: OK");
}

async function run() {
  await testOverviewAnalytics();
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
