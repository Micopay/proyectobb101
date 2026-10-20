import { strictEqual, ok, throws, rejects } from "assert";
import { randomUUID } from "crypto";
import db from "../db/schema.js";
import { config } from "../config.js";
import {
  aggregateMonthlyOperations,
  generateMonthlyFiling,
  createComplianceAlert,
  checkAndRunComplianceJob,
} from "../services/compliance.service.js";
import { logAuditEvent } from "../services/audit.service.js";

async function seedUser(username: string): Promise<string> {
  const stellarAddress = `G${randomUUID().replace(/-/g, "").toUpperCase().slice(0, 55)}`;
  const user = await db.getOne<{ id: string }>(
    `INSERT INTO users (stellar_address, username, kyc_level, kyc_level_verified_at)
     VALUES ($1, $2, 0, NULL)
     RETURNING id`,
    [stellarAddress, username],
  );
  if (!user?.id) throw new Error("Failed to seed user");
  return user.id;
}

// ── Test 1: Aggregation threshold edge cases ───────────────────────────────
async function testAggregationThresholds() {
  const buyerId1 = await seedUser(`buyer_${randomUUID().slice(0, 8)}`);
  const buyerId2 = await seedUser(`buyer_${randomUUID().slice(0, 8)}`);
  const buyerId3 = await seedUser(`buyer_${randomUUID().slice(0, 8)}`);
  const sellerId = await seedUser(`seller_${randomUUID().slice(0, 8)}`);

  const year = 2026;
  const month = 6; // June
  const completedAt = "2026-06-15T12:00:00.000Z";

  // Threshold MXN = 210 * 117.31 = 24635.1
  const thresholdMxn = config.umaDailyMxn * config.kycAvisoThresholdUma;
  const underAmount = Math.floor(thresholdMxn - 10);
  const exactAmount = thresholdMxn;
  const overAmount = Math.ceil(thresholdMxn + 10);

  // User 1: Under threshold (P2P Trade)
  await db.execute(
    `INSERT INTO trades (id, seller_id, buyer_id, flow, provider_id, amount_mxn, amount_stroops, secret_hash, status, completed_at, created_at, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'completed', $9, $10, $11)`,
    [
      randomUUID(),
      sellerId,
      buyerId1,
      'deposit',
      sellerId,
      underAmount,
      (underAmount * 10000000).toString(),
      `hash_${randomUUID()}`,
      completedAt,
      completedAt,
      completedAt,
    ],
  );

  // User 2: Exactly at threshold (P2P Trade)
  await db.execute(
    `INSERT INTO trades (id, seller_id, buyer_id, flow, provider_id, amount_mxn, amount_stroops, secret_hash, status, completed_at, created_at, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'completed', $9, $10, $11)`,
    [
      randomUUID(),
      sellerId,
      buyerId2,
      'deposit',
      sellerId,
      exactAmount,
      (exactAmount * 10000000).toString(),
      `hash_${randomUUID()}`,
      completedAt,
      completedAt,
      completedAt,
    ],
  );

  // User 3: Over threshold (Cash In Risk Event)
  await logAuditEvent({
    action: "kyc_gate.decision",
    actorUserId: buyerId3,
    entityType: "kyc_gate",
    entityId: "cash_in",
    details: {
      operation_type: "cash_in",
      amount_mxn: overAmount,
      gate_decision: "pass",
    },
  });
  // Update created_at to target month manually because DEFAULT now() is used
  await db.execute(
    `UPDATE platform_risk_events SET created_at = $2 WHERE actor_user_id = $1`,
    [buyerId3, completedAt],
  ).catch(() => {
    // In memory fallback, platform_risk_events doesn't allow UPDATE, so we'll simulate by
    // setting it in our mock logic or in memory table directly if needed.
    // Wait, platform_risk_events doesn't allow UPDATE due to append-only trigger!
    // That means we must seed it with the correct created_at from the beginning.
    // But logAuditEvent doesn't let us pass created_at!
    // So for test, let's insert it directly into db.execute!
  });

  // Let's insert the risk event directly with created_at to bypass logAuditEvent limits
  await db.execute(
    `INSERT INTO platform_risk_events (action, actor_user_id, entity_type, entity_id, details, created_at)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      "kyc_gate.decision",
      buyerId3,
      "kyc_gate",
      "cash_in",
      {
        operation_type: "cash_in",
        amount_mxn: overAmount,
        gate_decision: "pass",
      },
      completedAt,
    ],
  );

  const reportableRecords = await aggregateMonthlyOperations(year, month);

  // User 1 should be excluded. User 2 and 3 should be included.
  const user1Record = reportableRecords.find((r) => r.userId === buyerId1);
  const user2Record = reportableRecords.find((r) => r.userId === buyerId2);
  const user3Record = reportableRecords.find((r) => r.userId === buyerId3);

  strictEqual(user1Record, undefined, "User under threshold should not be reportable");
  ok(user2Record !== undefined, "User exactly at threshold should be reportable");
  ok(user3Record !== undefined, "User over threshold should be reportable");
  strictEqual(user2Record.totalVolumeMxn, exactAmount, "Volume calculation should be exact");
  strictEqual(user3Record.totalVolumeMxn, overAmount, "Volume calculation should match event details");

  console.log("testAggregationThresholds: OK");
}

// ── Test 2: Zero-report generation logic ───────────────────────────────────
async function testZeroReport() {
  const year = 2026;
  const month = 5; // May (no operations seeded)

  const filing = await generateMonthlyFiling(year, month);
  ok(filing !== null, "Should generate filing record");
  strictEqual(filing.is_zero_report, true, "is_zero_report should be true");
  strictEqual(filing.report_data.isZeroReport, true, "report_data.isZeroReport should be true");
  strictEqual(filing.report_data.records.length, 0, "No records in zero-report");

  console.log("testZeroReport: OK");
}

// ── Test 3: Compliance alerts SLA deadlines ───────────────────────────────
async function testComplianceAlerts() {
  const userId = await seedUser(`alert_${randomUUID().slice(0, 8)}`);
  const alert = await createComplianceAlert({
    userId,
    reason: "velocity_limit_exceeded",
    severity: "high",
    details: { txsCount: 15 },
  });

  ok(alert.id !== undefined, "Alert should have an ID");
  strictEqual(alert.reason, "velocity_limit_exceeded", "Reason should match");
  strictEqual(alert.severity, "high", "Severity should match");

  const createdTime = new Date(alert.created_at).getTime();
  const deadlineTime = new Date(alert.sla_deadline).getTime();
  const diffHours = (deadlineTime - createdTime) / (60 * 60 * 1000);

  // Diff should be exactly 24 hours
  strictEqual(Math.round(diffHours), 24, "SLA deadline should be exactly 24 hours after creation");

  console.log("testComplianceAlerts: OK");
}

// ── Test 4: Append-only enforcement ────────────────────────────────────────
async function testAppendOnlyEnforcement() {
  const userId = await seedUser(`append_${randomUUID().slice(0, 8)}`);

  // Insert an alert
  const alert = await createComplianceAlert({
    userId,
    reason: "test_append_only",
    severity: "low",
  });

  // Try updating the alert (should reject or throw)
  await rejects(
    db.execute(`UPDATE compliance_alerts SET reason = 'hacked' WHERE id = $1`, [alert.id]),
    /Updates and deletions are not allowed on this table/i,
    "Alert update should be blocked"
  );

  // Try deleting the alert (should reject or throw)
  await rejects(
    db.execute(`DELETE FROM compliance_alerts WHERE id = $1`, [alert.id]),
    /Updates and deletions are not allowed on this table/i,
    "Alert deletion should be blocked"
  );

  console.log("testAppendOnlyEnforcement: OK");
}

// ── Test 5: Scheduled job integration end-to-end ───────────────────────────
async function testScheduledJobIntegration() {
  // Clear any existing filings for test period first
  await db.execute(`DELETE FROM compliance_filings`).catch(() => {
    // If append-only triggers block DELETE, that's fine. We'll verify missing report generation using a unique month.
  });

  const now = new Date();
  // We'll test with a unique month so that checkAndRunComplianceJob will definitely find it missing
  // Let's manually trigger checkAndRunComplianceJob.
  // Wait, checkAndRunComplianceJob depends on current system date's getUTCDate() >= 17.
  // Let's temporarily override Date.prototype.getUTCDate (or Mock Date) in test to make it think it's Day 17.
  const originalGetUTCDate = Date.prototype.getUTCDate;
  const originalGetUTCMonth = Date.prototype.getUTCMonth;
  const originalGetUTCFullYear = Date.prototype.getUTCFullYear;

  // Let's mock Date.prototype to return: Day 17, Month 10 (November), Year 2026.
  // This means previous month is October 2026.
  Date.prototype.getUTCDate = () => 17;
  Date.prototype.getUTCMonth = () => 10; // 0-indexed, so 10 is November
  Date.prototype.getUTCFullYear = () => 2026;

  try {
    const periodStart = new Date(Date.UTC(2026, 9, 1, 0, 0, 0, 0)); // October 1st

    // Run the scheduler check
    await checkAndRunComplianceJob();

    // Verify report was generated for October 2026
    const report = await db.getOne(
      `SELECT id, is_zero_report FROM compliance_filings WHERE period_start = $1 AND filing_type = 'monthly_sat'`,
      [periodStart.toISOString()]
    );

    ok(report !== null, "Filing should be generated by checkAndRunComplianceJob");
    strictEqual(report.is_zero_report, true, "Should be zero report because no data was seeded for October 2026");
  } finally {
    // Restore original Date functions
    Date.prototype.getUTCDate = originalGetUTCDate;
    Date.prototype.getUTCMonth = originalGetUTCMonth;
    Date.prototype.getUTCFullYear = originalGetUTCFullYear;
  }

  console.log("testScheduledJobIntegration: OK");
}

async function run() {
  console.log("Running compliance service tests...");
  await testAggregationThresholds();
  await testZeroReport();
  await testComplianceAlerts();
  await testAppendOnlyEnforcement();
  await testScheduledJobIntegration();
  console.log("All compliance service tests passed.");
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
