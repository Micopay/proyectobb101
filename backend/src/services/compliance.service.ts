import db from '../db/schema.js';
import { config } from '../config.js';
import pino from 'pino';

const logger = pino({ name: 'compliance.service' });

export interface AggregatedOperation {
  operationId: string;
  type: string;
  amountMxn: number;
  timestamp: string;
}

export interface ReportableUserRecord {
  userId: string;
  stellarAddress: string;
  username: string;
  totalVolumeMxn: number;
  operationsCount: number;
  operations: AggregatedOperation[];
}

export interface SatReportData {
  period: string;
  generatedAt: string;
  thresholdUma: number;
  umaValueMxn: number;
  thresholdMxn: number;
  isZeroReport: boolean;
  reportableUsersCount: number;
  records: ReportableUserRecord[];
}

/**
 * Aggregates operations for a given calendar month (1-indexed month: 1-12).
 * Operates on JS side to ensure Postgres and in-memory fallback behaves identically.
 */
export async function aggregateMonthlyOperations(year: number, month: number): Promise<ReportableUserRecord[]> {
  const periodStart = new Date(Date.UTC(year, month - 1, 1, 0, 0, 0, 0));
  const periodEnd = new Date(Date.UTC(year, month, 1, 0, 0, 0, 0));

  // 1. Fetch user map for username and stellar_address resolution
  const users = await db.getMany<{ id: string; username: string | null; stellar_address: string }>(
    `SELECT id, username, stellar_address FROM users`
  );
  const userMap = new Map(users.map((u) => [u.id, u]));

  // 2. Fetch completed P2P trades in period
  const trades = await db.getMany<{ id: string; buyer_id: string; amount_mxn: string | number; completed_at: string }>(
    `SELECT id, buyer_id, amount_mxn, completed_at FROM trades WHERE status = 'completed'`
  );

  // 3. Fetch passed gate decisions (cash_in, cash_out, cetes_purchase)
  const riskEvents = await db.getMany<{ id: string; actor_user_id: string | null; details: any; created_at: string }>(
    `SELECT id, actor_user_id, details, created_at FROM platform_risk_events WHERE action = $1`,
    ['kyc_gate.decision']
  );

  const userOperations: Record<string, AggregatedOperation[]> = {};

  // Process trades
  for (const t of trades) {
    if (!t.completed_at) continue;
    const completedTime = new Date(t.completed_at).getTime();
    if (completedTime >= periodStart.getTime() && completedTime < periodEnd.getTime()) {
      if (!userOperations[t.buyer_id]) {
        userOperations[t.buyer_id] = [];
      }
      userOperations[t.buyer_id].push({
        operationId: t.id,
        type: 'p2p_transfer',
        amountMxn: Number(t.amount_mxn),
        timestamp: t.completed_at,
      });
    }
  }

  // Process other gated operations (cash_in, cash_out, cetes_purchase)
  for (const event of riskEvents) {
    if (!event.actor_user_id) continue;
    const details = event.details || {};
    if (details.gate_decision !== 'pass') continue;
    const opType = details.operation_type;
    if (opType === 'p2p_transfer') continue; // Handled by actual completed trades

    const createdTime = new Date(event.created_at).getTime();
    if (createdTime >= periodStart.getTime() && createdTime < periodEnd.getTime()) {
      if (!userOperations[event.actor_user_id]) {
        userOperations[event.actor_user_id] = [];
      }
      userOperations[event.actor_user_id].push({
        operationId: event.id,
        type: opType || 'unknown',
        amountMxn: Number(details.amount_mxn || 0),
        timestamp: event.created_at,
      });
    }
  }

  const thresholdMxn = config.umaDailyMxn * config.kycAvisoThresholdUma;
  const records: ReportableUserRecord[] = [];

  for (const [userId, ops] of Object.entries(userOperations)) {
    const totalVolumeMxn = ops.reduce((sum, op) => sum + op.amountMxn, 0);
    if (totalVolumeMxn >= thresholdMxn) {
      const u = userMap.get(userId);
      records.push({
        userId,
        stellarAddress: u?.stellar_address || '',
        username: u?.username || 'Usuario Micopay',
        totalVolumeMxn,
        operationsCount: ops.length,
        operations: ops,
      });
    }
  }

  return records;
}

/**
 * Generates the monthly report (or zero-report) and records it to compliance_filings.
 */
export async function generateMonthlyFiling(year: number, month: number): Promise<any> {
  const periodStart = new Date(Date.UTC(year, month - 1, 1, 0, 0, 0, 0));
  const periodEnd = new Date(Date.UTC(year, month, 1, 0, 0, 0, 0));

  const records = await aggregateMonthlyOperations(year, month);
  const isZeroReport = records.length === 0;

  const reportData: SatReportData = {
    period: `${year}-${String(month).padStart(2, '0')}`,
    generatedAt: new Date().toISOString(),
    thresholdUma: config.kycAvisoThresholdUma,
    umaValueMxn: config.umaDailyMxn,
    thresholdMxn: config.umaDailyMxn * config.kycAvisoThresholdUma,
    isZeroReport,
    reportableUsersCount: records.length,
    records,
  };

  const [filing] = await db.getMany(
    `INSERT INTO compliance_filings (period_start, period_end, filing_type, report_data, is_zero_report)
     VALUES ($1, $2, 'monthly_sat', $3, $4)
     RETURNING *`,
    [periodStart.toISOString(), periodEnd.toISOString(), reportData, isZeroReport]
  );

  logger.info(
    { period: reportData.period, isZeroReport, recordsCount: records.length },
    '[compliance] Generated monthly SAT report'
  );

  return filing;
}

/**
 * Enters a compliance alert into the database. Exposes 24h SLA.
 */
export async function createComplianceAlert(input: {
  userId: string;
  reason: string;
  severity?: string;
  details?: Record<string, any>;
}): Promise<any> {
  const { userId, reason, severity = 'medium', details = {} } = input;
  const createdAt = new Date();
  const slaDeadline = new Date(createdAt.getTime() + 24 * 60 * 60 * 1000);

  const [alert] = await db.getMany(
    `INSERT INTO compliance_alerts (user_id, reason, severity, details, created_at, sla_deadline)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [userId, reason, severity, details, createdAt.toISOString(), slaDeadline.toISOString()]
  );

  logger.warn(
    { userId, reason, severity, deadline: slaDeadline.toISOString() },
    '[compliance] Compliance alert created'
  );

  return alert;
}

/**
 * Checks if the report for the previous month is missing and runs it if Day 17 is reached.
 */
export async function checkAndRunComplianceJob(): Promise<void> {
  try {
    const now = new Date();
    const day = now.getUTCDate();

    // Only run on or after Day 17 of the month
    if (day < 17) {
      return;
    }

    let prevYear = now.getUTCFullYear();
    let prevMonth = now.getUTCMonth(); // 0-indexed, so 0 is Jan (we want Dec of prev year)
    
    if (prevMonth === 0) {
      prevMonth = 12;
      prevYear -= 1;
    }

    const periodStart = new Date(Date.UTC(prevYear, prevMonth - 1, 1, 0, 0, 0, 0));

    const existing = await db.getOne(
      `SELECT id FROM compliance_filings WHERE period_start = $1 AND filing_type = 'monthly_sat'`,
      [periodStart.toISOString()]
    );

    if (!existing) {
      logger.info(
        { prevYear, prevMonth },
        '[compliance] Scheduled check: Monthly report missing. Triggering generation...'
      );
      await generateMonthlyFiling(prevYear, prevMonth);
    }
  } catch (err: any) {
    logger.error({ err: err.message }, '[compliance] Scheduled check cycle failed');
  }
}

let complianceJobInterval: NodeJS.Timeout | null = null;
const COMPLIANCE_CHECK_INTERVAL_MS = 60 * 60 * 1000; // Hourly check

export function startComplianceJob(): void {
  // Check immediately on start
  checkAndRunComplianceJob().catch((err) => {
    logger.error({ err: err.message }, '[compliance] Startup check failed');
  });

  // Schedule hourly check
  complianceJobInterval = setInterval(() => {
    checkAndRunComplianceJob().catch((err) => {
      logger.error({ err: err.message }, '[compliance] Scheduled check failed');
    });
  }, COMPLIANCE_CHECK_INTERVAL_MS);

  logger.info({ intervalMs: COMPLIANCE_CHECK_INTERVAL_MS }, '[compliance] Scheduler active');
}

export function stopComplianceJob(): void {
  if (complianceJobInterval) {
    clearInterval(complianceJobInterval);
    complianceJobInterval = null;
    logger.info('[compliance] Scheduler stopped');
  }
}
