import { strictEqual, ok } from "assert";
import { randomUUID } from "crypto";
import db from "../db/schema.js";
import {
  getEffectiveKycLevel,
  getRequiredKycLevel,
  computeGateDecision,
  assertKycTierSufficient,
  getKycAuditTrail,
} from "../services/kyc-gate.service.js";

async function seedUser(overrides: {
  kycLevel?: number;
  kycVerifiedAt?: string | null;
} = {}) {
  const { kycLevel = 0, kycVerifiedAt = null } = overrides;
  const stellarAddress = `G${randomUUID().replace(/-/g, "").toUpperCase().slice(0, 55)}`;
  const user = await db.getOne<{ id: string }>(
    `INSERT INTO users (stellar_address, username, kyc_level, kyc_level_verified_at)
     VALUES ($1, $2, $3, $4)
     RETURNING id`,
    [stellarAddress, `kyc_${randomUUID().slice(0, 8)}`, kycLevel, kycVerifiedAt],
  );
  if (!user?.id) throw new Error("Failed to seed user");
  return user.id;
}

// ── Pure gate-logic tests (#314 acceptance: "sufficient tier, insufficient
// tier, tier expiry") ────────────────────────────────────────────────────

function testGetRequiredKycLevel_defaults() {
  // Verified LFPIORPI rule: identification required from the first peso, so no
  // cash↔crypto amount (not even 1 peso) may run at Level 0.
  strictEqual(getRequiredKycLevel("p2p_transfer", 1), 1, "even 1 peso requires Level 1 (identification from the first peso)");
  strictEqual(getRequiredKycLevel("p2p_transfer", 1000), 1, "under the 3000 MXN ceiling requires Level 1");
  strictEqual(getRequiredKycLevel("p2p_transfer", 3000), 1, "exactly at the ceiling still requires Level 1 (inclusive)");
  strictEqual(getRequiredKycLevel("p2p_transfer", 3001), 2, "over the ceiling requires Level 2");
  strictEqual(getRequiredKycLevel("p2p_transfer"), 1, "no amount falls back to the lowest configured tier (Level 1, never 0)");
  console.log("getRequiredKycLevel: first-peso rule OK");
}

function testComputeGateDecision() {
  strictEqual(computeGateDecision(0, 0), "pass");
  strictEqual(computeGateDecision(1, 0), "pass");
  strictEqual(computeGateDecision(0, 1), "block");
  strictEqual(computeGateDecision(2, 1), "pass");
  console.log("computeGateDecision: sufficient/insufficient OK");
}

async function testEffectiveKycLevel_freshVerificationCounts() {
  const userId = await seedUser({ kycLevel: 1, kycVerifiedAt: new Date().toISOString() });
  const level = await getEffectiveKycLevel(userId);
  strictEqual(level, 1, "a freshly verified level should count as-is");
  console.log("getEffectiveKycLevel: fresh verification OK");
}

async function testEffectiveKycLevel_expiredVerificationDowngrades() {
  const longAgo = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000).toISOString(); // > 365-day default expiry
  const userId = await seedUser({ kycLevel: 1, kycVerifiedAt: longAgo });
  const level = await getEffectiveKycLevel(userId);
  strictEqual(level, 0, "a verification older than kycLevelExpiryDays should downgrade to level 0");
  console.log("getEffectiveKycLevel: expiry downgrade OK");
}

async function testEffectiveKycLevel_neverVerifiedIsZero() {
  const userId = await seedUser({ kycLevel: 0, kycVerifiedAt: null });
  const level = await getEffectiveKycLevel(userId);
  strictEqual(level, 0, "a user with no verification timestamp is level 0 regardless of stored kyc_level");
  console.log("getEffectiveKycLevel: unverified defaults to 0 OK");
}

// ── Audit trail: writes + queries (#314 acceptance: "Integration tests for
// audit trail writes and queries") ───────────────────────────────────────

async function testAssertKycTierSufficient_neverThrowsWhenGateDisabled() {
  // config.kycGateEnabled defaults to false (KYC_GATE_ENABLED unset) — the
  // gate must be audit-only until explicitly turned on, even for a clearly
  // insufficient tier.
  const userId = await seedUser({ kycLevel: 0, kycVerifiedAt: null });
  await assertKycTierSufficient({ userId, operationType: "p2p_transfer", amountMxn: 999_999 });
  console.log("assertKycTierSufficient: disabled gate never throws OK");
}

async function testAuditTrailWritesAndQueries() {
  // Level 1 user: small ops pass, only the >3000 MXN op (which needs Level 2)
  // is blocked — gives a mix of pass/block to exercise the gate_decision filter.
  //
  // #316 note: each assertKycTierSufficient call below also runs its own
  // monthly-volume decision (since amountMxn is set) and logs it as a
  // *separate* audit event with the same action — see
  // kyc-monthly-volume.test.ts for that behavior. This test is specifically
  // about the tier decision, so every query here passes checkType: "tier" to
  // isolate it, exactly as it did before #316 existed (when "tier" was the
  // only check type there was).
  const userId = await seedUser({ kycLevel: 1, kycVerifiedAt: new Date().toISOString() });

  await assertKycTierSufficient({ userId, operationType: "p2p_transfer", amountMxn: 1000 });   // req 1 → pass
  await assertKycTierSufficient({ userId, operationType: "p2p_transfer", amountMxn: 50_000 });  // req 2 → block
  await assertKycTierSufficient({ userId, operationType: "cash_in", amountMxn: 500 });          // req 1 → pass

  const allEvents = await getKycAuditTrail({ userId, checkType: "tier" });
  strictEqual(allEvents.length, 3, "all three tier gate decisions for this user should be recorded");

  const p2pEvents = await getKycAuditTrail({ userId, checkType: "tier", operationType: "p2p_transfer" });
  strictEqual(p2pEvents.length, 2, "operation_type filter should only return p2p_transfer events");

  const blockedEvents = await getKycAuditTrail({ userId, checkType: "tier", gateDecision: "block" });
  strictEqual(blockedEvents.length, 1, "gate_decision filter should isolate the one insufficient-tier decision (50,000 MXN needs Level 2)");
  strictEqual(blockedEvents[0].details.operation_type, "p2p_transfer");
  strictEqual(blockedEvents[0].details.tier_at_time, 1);
  strictEqual(blockedEvents[0].details.required_level, 2);

  ok(allEvents[0].created_at >= allEvents[allEvents.length - 1].created_at, "results should be ordered most-recent-first");
  console.log("getKycAuditTrail: writes + filters OK");
}

async function run() {
  console.log("Running kyc-gate.service tests...");
  testGetRequiredKycLevel_defaults();
  testComputeGateDecision();
  await testEffectiveKycLevel_freshVerificationCounts();
  await testEffectiveKycLevel_expiredVerificationDowngrades();
  await testEffectiveKycLevel_neverVerifiedIsZero();
  await testAssertKycTierSufficient_neverThrowsWhenGateDisabled();
  await testAuditTrailWritesAndQueries();
  console.log("All kyc-gate.service tests passed.");
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
