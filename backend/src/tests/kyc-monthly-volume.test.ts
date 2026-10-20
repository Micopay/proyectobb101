/**
 * Monthly cumulative KYC volume cap tests — #316 [4c]
 *
 * config.kycGateEnabled and config.kycMonthlyVolumeCeilingsMxn are baked in
 * at import time (they're plain properties on a `const config` object), so
 * this file sets the env vars it needs and only ever *dynamically* imports
 * anything that (transitively) imports config.js — a static top-level
 * `import` would be hoisted and evaluate config.js before these env vars are
 * set. See kyc-gate.service.test.ts for the equivalent audit-only-gate test,
 * which relies on the (unset) default instead.
 */
import { strictEqual, ok } from 'node:assert';
import { randomUUID } from 'node:crypto';

process.env.KYC_GATE_ENABLED = 'true';
process.env.KYC_MONTHLY_VOLUME_CEILINGS_MXN_JSON = JSON.stringify({ 0: 0, 1: 1000, 2: 50000 });

const db = (await import('../db/schema.js')).default;
const {
  assertKycTierSufficient,
  assertKycMonthlyVolumeWithinCap,
  getMonthlyVolumeCeiling,
} = await import('../services/kyc-gate.service.js');
const { KycMonthlyCapExceededError } = await import('../utils/errors.js');

async function seedUser(kycLevel: number): Promise<string> {
  const stellarAddress = `G${randomUUID().replace(/-/g, '').toUpperCase().slice(0, 55)}`;
  const user = await db.getOne<{ id: string }>(
    `INSERT INTO users (stellar_address, username, kyc_level, kyc_level_verified_at)
     VALUES ($1, $2, $3, $4)
     RETURNING id`,
    [stellarAddress, `vol_${randomUUID().slice(0, 8)}`, kycLevel, new Date().toISOString()],
  );
  if (!user?.id) throw new Error('Failed to seed user');
  return user.id;
}

async function getMonthlyTotal(userId: string): Promise<number> {
  const row = await db.getOne<{ amount_mxn: number }>(
    `SELECT amount_mxn FROM user_monthly_volume WHERE user_id = $1`,
    [userId],
  );
  return row ? Number(row.amount_mxn) : 0;
}

// ── 1. Config plumbing ───────────────────────────────────────────────────

function testGetMonthlyVolumeCeiling() {
  strictEqual(getMonthlyVolumeCeiling(0), 0, 'level 0 ceiling is 0 (no cash<->crypto op runs at level 0 anyway)');
  strictEqual(getMonthlyVolumeCeiling(1), 1000, 'level 1 ceiling from KYC_MONTHLY_VOLUME_CEILINGS_MXN_JSON override');
  strictEqual(getMonthlyVolumeCeiling(2), 50000, 'level 2 ceiling from override');
  strictEqual(getMonthlyVolumeCeiling(99), null, 'undefined level falls back to no ceiling rather than throwing');
  console.log('getMonthlyVolumeCeiling: config-driven, no-code-change override OK');
}

// ── 2. Under / at / over cap ─────────────────────────────────────────────

async function testUnderCap_passes() {
  const userId = await seedUser(1);
  await assertKycMonthlyVolumeWithinCap({ userId, operationType: 'p2p_transfer', amountMxn: 400, currentLevel: 1 });
  strictEqual(await getMonthlyTotal(userId), 400);
  console.log('assertKycMonthlyVolumeWithinCap: under cap passes and records volume OK');
}

async function testExactlyAtCap_passes() {
  const userId = await seedUser(1);
  await assertKycMonthlyVolumeWithinCap({ userId, operationType: 'p2p_transfer', amountMxn: 1000, currentLevel: 1 });
  strictEqual(await getMonthlyTotal(userId), 1000, 'exactly-at-cap must be inclusive (<=), not exclusive');
  console.log('assertKycMonthlyVolumeWithinCap: exactly at cap passes (inclusive boundary) OK');
}

async function testOverCap_blocksAndDoesNotMutate() {
  const userId = await seedUser(1);
  await assertKycMonthlyVolumeWithinCap({ userId, operationType: 'p2p_transfer', amountMxn: 600, currentLevel: 1 });

  let threw: unknown = null;
  try {
    await assertKycMonthlyVolumeWithinCap({ userId, operationType: 'p2p_transfer', amountMxn: 500, currentLevel: 1 }); // 600+500=1100 > 1000
  } catch (err) {
    threw = err;
  }
  ok(threw instanceof KycMonthlyCapExceededError, 'must throw KycMonthlyCapExceededError when the cap would be exceeded');
  strictEqual((threw as InstanceType<typeof KycMonthlyCapExceededError>).remainingMxn, 400, 'error reports remaining monthly allowance');
  ok((threw as InstanceType<typeof KycMonthlyCapExceededError>).resetAt, 'error reports a reset date');

  strictEqual(await getMonthlyTotal(userId), 600, 'a blocked operation must not mutate the recorded monthly volume');
  console.log('assertKycMonthlyVolumeWithinCap: over cap blocks, reports remaining+reset, does not mutate OK');
}

// ── 3. Month rollover ─────────────────────────────────────────────────────

async function testMonthRollover_previousMonthDoesNotCarryOver() {
  const userId = await seedUser(1);

  // Directly seed a *previous* month's row already at the level-1 ceiling.
  const now = new Date();
  const prevMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  const prevMonthKey = `${prevMonth.getUTCFullYear()}-${String(prevMonth.getUTCMonth() + 1).padStart(2, '0')}`;
  await db.execute(
    `INSERT INTO user_monthly_volume (user_id, month_key, amount_mxn) VALUES ($1, $2, $3)`,
    [userId, prevMonthKey, 1000],
  );

  // A same-size operation *this* month must still pass — last month's volume
  // must not count against this month's ceiling.
  await assertKycMonthlyVolumeWithinCap({ userId, operationType: 'p2p_transfer', amountMxn: 1000, currentLevel: 1 });
  strictEqual(await getMonthlyTotal(userId), 1000, 'current month starts its own running total, independent of last month');
  console.log('assertKycMonthlyVolumeWithinCap: month rollover does not carry over volume OK');
}

// ── 4. Concurrency: two operations cannot jointly exceed the cap ─────────

async function testConcurrentOperations_cannotJointlyExceedCap() {
  const userId = await seedUser(1);
  // Ceiling is 1000; two concurrent 600 MXN operations. If unsynchronized,
  // both could read "current total = 0" before either writes, and both
  // would then wrongly pass (jointly reaching 1200 > 1000).
  const opA = assertKycMonthlyVolumeWithinCap({ userId, operationType: 'p2p_transfer', amountMxn: 600, currentLevel: 1 });
  const opB = assertKycMonthlyVolumeWithinCap({ userId, operationType: 'cash_in', amountMxn: 600, currentLevel: 1 });

  const [resA, resB] = await Promise.allSettled([opA, opB]);
  const outcomes = [resA.status, resB.status];

  strictEqual(outcomes.filter((s) => s === 'fulfilled').length, 1, 'exactly one of the two concurrent operations must succeed');
  strictEqual(outcomes.filter((s) => s === 'rejected').length, 1, 'exactly one of the two concurrent operations must be blocked');

  const rejected = resA.status === 'rejected' ? resA : (resB as PromiseRejectedResult);
  ok(rejected.reason instanceof KycMonthlyCapExceededError, 'the blocked operation must fail with KycMonthlyCapExceededError');

  const finalTotal = await getMonthlyTotal(userId);
  strictEqual(finalTotal, 600, 'final recorded volume must reflect exactly the one operation that was allowed through — not both (1200) and not neither (0)');
  console.log('assertKycMonthlyVolumeWithinCap: concurrent operations cannot jointly exceed the cap (race-safe) OK');
}

// ── 5. Through the real gated-operation entry point ──────────────────────

async function testIntegration_throughAssertKycTierSufficient() {
  const userId = await seedUser(1);

  // First operation: well within both the per-operation tier threshold
  // (<=3000 MXN needs only level 1) and the monthly cap (1000).
  await assertKycTierSufficient({ userId, operationType: 'cash_in', amountMxn: 900 });

  // Second operation: tier check alone would pass (still <=3000 MXN, level 1
  // suffices) but pushes monthly volume to 900+900=1800 > 1000 ceiling — the
  // monthly cap, not the tier check, must be what blocks it.
  let threw: unknown = null;
  try {
    await assertKycTierSufficient({ userId, operationType: 'cash_in', amountMxn: 900 });
  } catch (err) {
    threw = err;
  }
  ok(threw instanceof KycMonthlyCapExceededError, 'assertKycTierSufficient must enforce #316\'s monthly cap after its own tier check passes');
  strictEqual(await getMonthlyTotal(userId), 900, 'the blocked second operation must not have mutated recorded volume');
  console.log('assertKycTierSufficient: monthly volume cap enforced through the real gate entry point OK');
}

async function run() {
  console.log('Running KYC monthly volume cap tests...\n');
  testGetMonthlyVolumeCeiling();
  await testUnderCap_passes();
  await testExactlyAtCap_passes();
  await testOverCap_blocksAndDoesNotMutate();
  await testMonthRollover_previousMonthDoesNotCarryOver();
  await testConcurrentOperations_cannotJointlyExceedCap();
  await testIntegration_throughAssertKycTierSufficient();
  console.log('\n✅ All KYC monthly volume cap tests passed.');
}

run().catch((err) => {
  console.error('❌ Tests failed:', err);
  process.exit(1);
});
