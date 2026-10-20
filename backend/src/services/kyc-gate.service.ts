import db from '../db/schema.js';
import { getMonthlyReservedMxn } from './kycVolumeLedger.service.js';
import { config, type KycOperationType } from '../config.js';
import { logAuditEvent } from './audit.service.js';
import { KycTierInsufficientError, KycMonthlyCapExceededError } from '../utils/errors.js';
import { withKeyedLock } from '../lib/keyedMutex.js';

const DAY_MS = 24 * 60 * 60 * 1000;

export type GateDecision = 'pass' | 'block';

interface UserKycRow {
  kyc_level: number | null;
  kyc_level_verified_at: string | null;
}

/**
 * Effective KYC level right now: the stored tier, downgraded to 0 if the
 * verification is older than config.kycLevelExpiryDays. Expiry keeps a
 * one-time verification from being treated as permanent (#314's "tier
 * expiry and renewal logic").
 */
export async function getEffectiveKycLevel(userId: string): Promise<number> {
  const user = await db.getOne<UserKycRow>(
    `SELECT kyc_level, kyc_level_verified_at FROM users WHERE id = $1`,
    [userId],
  );
  if (!user || !user.kyc_level) return 0;
  if (!user.kyc_level_verified_at) return 0;

  const verifiedAtMs = new Date(user.kyc_level_verified_at).getTime();
  const expiresAtMs = verifiedAtMs + config.kycLevelExpiryDays * DAY_MS;
  if (Date.now() >= expiresAtMs) return 0;

  return user.kyc_level;
}

/**
 * Required tier for an operation of the given amount, per config (see the
 * default table in config.ts). `amountMxn` omitted (e.g. an offramp quoted
 * in a non-MXN source asset before conversion) falls back to the lowest
 * configured tier for that operation, rather than guessing.
 */
export function getRequiredKycLevel(operationType: KycOperationType, amountMxn?: number): number {
  const tiers = config.kycOperationThresholds[operationType];
  if (!tiers || tiers.length === 0) return 0;
  if (amountMxn == null) return tiers[0].requiredLevel;

  for (const tier of tiers) {
    if (tier.maxAmountMxn === null || amountMxn <= tier.maxAmountMxn) {
      return tier.requiredLevel;
    }
  }
  return tiers[tiers.length - 1].requiredLevel;
}

/** Pure pass/block decision — independent of whether enforcement is turned on. */
export function computeGateDecision(currentLevel: number, requiredLevel: number): GateDecision {
  return currentLevel >= requiredLevel ? 'pass' : 'block';
}

export interface AssertKycTierInput {
  userId: string;
  operationType: KycOperationType;
  amountMxn?: number;
}

/**
 * Gate for #314: computes the tier decision for an operation, always logs it
 * to the platform audit trail (pass or block, decoupled from enforcement),
 * and throws only when the decision is 'block' AND config.kycGateEnabled is
 * true. Enforcement defaults to off — thresholds are pending legal counsel
 * review (LFPIORPI reform) — see docs/GRANTFOX_KYC_QUEUE_2026-07.md.
 *
 * #316 extends this same gate with a monthly cumulative volume check, run
 * after the tier check passes (or after a would-block tier decision that
 * enforcement is currently ignoring) — see assertKycMonthlyVolumeWithinCap.
 */
export async function assertKycTierSufficient(input: AssertKycTierInput): Promise<void> {
  const { userId, operationType, amountMxn } = input;

  const currentLevel = await getEffectiveKycLevel(userId);
  const requiredLevel = getRequiredKycLevel(operationType, amountMxn);
  const decision = computeGateDecision(currentLevel, requiredLevel);

  await logAuditEvent({
    action: 'kyc_gate.decision',
    actorUserId: userId,
    entityType: 'kyc_gate',
    entityId: operationType,
    details: {
      check_type: 'tier',
      operation_type: operationType,
      amount_mxn: amountMxn ?? null,
      tier_at_time: currentLevel,
      required_level: requiredLevel,
      gate_decision: decision,
      enforcement_enabled: config.kycGateEnabled,
    },
  });

  if (decision === 'block' && config.kycGateEnabled) {
    throw new KycTierInsufficientError(requiredLevel, currentLevel, operationType);
  }

  if (amountMxn !== undefined) {
    await assertKycMonthlyVolumeWithinCap({ userId, operationType, amountMxn, currentLevel });
  }
}

export function currentMonthWindow(now: Date = new Date()): { monthKey: string; resetAt: string } {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth(); // 0-indexed
  const monthKey = `${year}-${String(month + 1).padStart(2, '0')}`;
  const resetAt = new Date(Date.UTC(year, month + 1, 1, 0, 0, 0, 0)).toISOString();
  return { monthKey, resetAt };
}

/** Monthly cumulative volume ceiling for a KYC level, MXN. null = no ceiling. */
export function getMonthlyVolumeCeiling(level: number): number | null {
  const ceiling = config.kycMonthlyVolumeCeilingsMxn[level];
  return ceiling === undefined ? null : ceiling;
}

interface MonthlyVolumeRow {
  amount_mxn: number | string;
}

export interface MonthlyVolumeCheckResult {
  allowed: boolean;
  newTotalMxn: number;
  ceilingMxn: number | null;
  remainingMxn: number | null;
  resetAt: string;
}

/**
 * Atomic check-and-increment for a user's monthly cumulative volume. The
 * entire read -> decide -> write sequence runs inside withKeyedLock(userId),
 * so two concurrent calls for the SAME user are fully serialized — the
 * second call always sees the first call's write before making its own
 * decision, so they cannot jointly exceed `ceilingMxn` (#316's "race-safe"
 * acceptance criterion). Calls for different users never block each other.
 *
 * When `enforce` is false (audit-only gate), the amount is still recorded —
 * the real operation proceeds either way in that mode, so the tracked total
 * should reflect real volume — but `allowed` only ever reports false while
 * `enforce` is true, mirroring assertKycTierSufficient's own enforcement
 * toggle immediately above.
 */
async function recordMonthlyVolumeAndCheckCap(
  userId: string,
  amountMxn: number,
  ceilingMxn: number | null,
  enforce: boolean,
): Promise<MonthlyVolumeCheckResult> {
  return withKeyedLock(`kyc-monthly-volume:${userId}`, async () => {
    const { monthKey, resetAt } = currentMonthWindow();

    const row = await db.getOne<MonthlyVolumeRow>(
      `SELECT amount_mxn FROM user_monthly_volume WHERE user_id = $1 AND month_key = $2`,
      [userId, monthKey],
    );
    const currentTotal = row ? Number(row.amount_mxn) : 0;
    const prospectiveTotal = currentTotal + amountMxn;
    const withinCap = ceilingMxn === null || prospectiveTotal <= ceilingMxn;

    if (!enforce || withinCap) {
      if (row) {
        await db.execute(
          `UPDATE user_monthly_volume SET amount_mxn = $1, updated_at = NOW() WHERE user_id = $2 AND month_key = $3`,
          [prospectiveTotal, userId, monthKey],
        );
      } else {
        await db.execute(
          `INSERT INTO user_monthly_volume (user_id, month_key, amount_mxn) VALUES ($1, $2, $3)`,
          [userId, monthKey, prospectiveTotal],
        );
      }
      return {
        allowed: withinCap,
        newTotalMxn: prospectiveTotal,
        ceilingMxn,
        remainingMxn: ceilingMxn === null ? null : Math.max(ceilingMxn - prospectiveTotal, 0),
        resetAt,
      };
    }

    // Enforced and over cap: no mutation — the operation did not proceed,
    // so recorded volume must not change (mirrors #314's "failed op does not
    // mutate balance" invariant).
    return {
      allowed: false,
      newTotalMxn: currentTotal,
      ceilingMxn,
      remainingMxn: ceilingMxn === null ? null : Math.max(ceilingMxn - currentTotal, 0),
      resetAt,
    };
  });
}

export interface AssertKycMonthlyVolumeInput {
  userId: string;
  operationType: KycOperationType;
  amountMxn: number;
  currentLevel: number;
}

/**
 * #316: verifies `amountMxn` plus the user's already-accumulated volume this
 * calendar month stays within their KYC level's monthly ceiling. Ceilings
 * are keyed by the user's actual current level (not the level required for
 * this specific operation) — a Level 2 user's monthly allowance is Level 2's
 * ceiling regardless of what any single operation needs.
 */
export async function assertKycMonthlyVolumeWithinCap(input: AssertKycMonthlyVolumeInput): Promise<void> {
  const { userId, operationType, amountMxn, currentLevel } = input;
  const ceilingMxn = getMonthlyVolumeCeiling(currentLevel);

  const result = await recordMonthlyVolumeAndCheckCap(userId, amountMxn, ceilingMxn, config.kycGateEnabled);

  await logAuditEvent({
    action: 'kyc_gate.decision',
    actorUserId: userId,
    entityType: 'kyc_gate',
    entityId: operationType,
    details: {
      check_type: 'monthly_volume',
      operation_type: operationType,
      amount_mxn: amountMxn,
      kyc_level: currentLevel,
      monthly_ceiling_mxn: ceilingMxn,
      monthly_total_mxn: result.newTotalMxn,
      gate_decision: result.allowed ? 'pass' : 'block',
      enforcement_enabled: config.kycGateEnabled,
      reset_at: result.resetAt,
    },
  });

  // Mirrors assertKycTierSufficient immediately above: the decision is always
  // computed and logged, but only enforced (throws) once config.kycGateEnabled
  // is explicitly turned on.
  if (!result.allowed && config.kycGateEnabled) {
    throw new KycMonthlyCapExceededError(result.remainingMxn ?? 0, ceilingMxn ?? 0, result.resetAt, currentLevel);
  }
}

export type KycGateCheckType = 'tier' | 'monthly_volume';

export interface KycAuditFilters {
  userId?: string;
  operationType?: KycOperationType;
  gateDecision?: GateDecision;
  /**
   * #316 records the monthly-volume decision as its own event alongside
   * #314's tier decision (same action, same table — "no parallel logging
   * path" — just two rows per gated operation instead of one). Filter here
   * to look at just one check's decisions. Rows written before #316 have no
   * check_type recorded and are treated as 'tier' (that's all that existed).
   */
  checkType?: KycGateCheckType;
  fromDate?: string;
  toDate?: string;
  limit?: number;
}

export interface KycAuditEvent {
  id: string;
  action: string;
  actor_user_id: string | null;
  entity_type: string;
  entity_id: string;
  details: Record<string, unknown>;
  created_at: string;
}

const AUDIT_FETCH_CAP = 500;

/**
 * Admin query over the kyc_gate.decision audit trail. Only action (and,
 * when given, actor_user_id) are filtered in SQL — everything else is
 * filtered in JS so this behaves identically against real Postgres and the
 * in-memory test fallback (which doesn't parse JSONB operators or `>=`).
 */
export async function getKycAuditTrail(filters: KycAuditFilters = {}): Promise<KycAuditEvent[]> {
  const { userId, operationType, gateDecision, checkType, fromDate, toDate, limit = 50 } = filters;

  const rows = userId
    ? await db.getMany<KycAuditEvent>(
        `SELECT id, action, actor_user_id, entity_type, entity_id, details, created_at
         FROM platform_risk_events
         WHERE action = $1 AND actor_user_id = $2
         ORDER BY created_at DESC
         LIMIT ${AUDIT_FETCH_CAP}`,
        ['kyc_gate.decision', userId],
      )
    : await db.getMany<KycAuditEvent>(
        `SELECT id, action, actor_user_id, entity_type, entity_id, details, created_at
         FROM platform_risk_events
         WHERE action = $1
         ORDER BY created_at DESC
         LIMIT ${AUDIT_FETCH_CAP}`,
        ['kyc_gate.decision'],
      );

  const fromMs = fromDate ? new Date(fromDate).getTime() : null;
  const toMs = toDate ? new Date(toDate).getTime() : null;

  const filtered = rows.filter((row) => {
    if (operationType && row.details?.operation_type !== operationType) return false;
    if (gateDecision && row.details?.gate_decision !== gateDecision) return false;
    if (checkType && (row.details?.check_type ?? 'tier') !== checkType) return false;
    const createdMs = new Date(row.created_at).getTime();
    if (fromMs !== null && createdMs < fromMs) return false;
    if (toMs !== null && createdMs > toMs) return false;
    return true;
  });

  return filtered.slice(0, limit);
}

// ── CASH-10 · decision pura, sin escrituras ────────────────────────────────

export interface KycParticipantDecision {
  userId: string;
  currentLevel: number;
  requiredLevel: number;
  tierDecision: GateDecision;
  ceilingMxn: number | null;
  /** Volumen ya comprometido este mes, leido del ledger. */
  reservedMxn: number;
  /** Total si esta operacion se aceptara. */
  prospectiveMxn: number;
  volumeDecision: GateDecision;
  /** `pass` solo si ambas comprobaciones pasan. */
  decision: GateDecision;
}

/**
 * CASH-10: evalua a UNA persona sin tocar nada.
 *
 * `assertKycTierSufficient` mezclaba decidir con incrementar el acumulado, y
 * por eso no se podia preguntar por los dos participantes antes de commitear:
 * consultar al primero ya le cargaba volumen aunque el segundo fallara.
 * Separar la decision de la escritura es lo que hace posible el "o los dos, o
 * ninguno".
 */
export async function evaluateKycForParticipant(input: {
  userId: string;
  operationType: KycOperationType;
  amountMxn: number;
  monthKey?: string;
}): Promise<KycParticipantDecision> {
  const { userId, operationType, amountMxn } = input;

  const currentLevel = await getEffectiveKycLevel(userId);
  const requiredLevel = getRequiredKycLevel(operationType, amountMxn);
  const tierDecision = computeGateDecision(currentLevel, requiredLevel);

  const ceilingMxn = getMonthlyVolumeCeiling(currentLevel);
  const reservedMxn = await getMonthlyReservedMxn(userId, input.monthKey);
  const prospectiveMxn = reservedMxn + amountMxn;
  const volumeDecision: GateDecision =
    ceilingMxn === null || prospectiveMxn <= ceilingMxn ? 'pass' : 'block';

  return {
    userId,
    currentLevel,
    requiredLevel,
    tierDecision,
    ceilingMxn,
    reservedMxn,
    prospectiveMxn,
    volumeDecision,
    decision: tierDecision === 'pass' && volumeDecision === 'pass' ? 'pass' : 'block',
  };
}

/**
 * Registra la decision de una persona. Se llama DESPUES de commitear, para
 * que la auditoria refleje operaciones durables y no intentos fallidos, como
 * pide el issue.
 */
export async function logKycDecision(
  d: KycParticipantDecision,
  operationType: KycOperationType,
  amountMxn: number,
  tradeId: string | null,
): Promise<void> {
  await logAuditEvent({
    action: 'kyc_gate.decision',
    actorUserId: d.userId,
    entityType: 'kyc_gate',
    entityId: tradeId ?? operationType,
    details: {
      check_type: 'tier_and_volume',
      operation_type: operationType,
      trade_id: tradeId,
      amount_mxn: amountMxn,
      tier_at_time: d.currentLevel,
      required_level: d.requiredLevel,
      tier_decision: d.tierDecision,
      monthly_ceiling_mxn: d.ceilingMxn,
      monthly_reserved_mxn: d.reservedMxn,
      monthly_total_mxn: d.prospectiveMxn,
      volume_decision: d.volumeDecision,
      gate_decision: d.decision,
      enforcement_enabled: config.kycGateEnabled,
    },
  });
}

/**
 * Traduce una decision bloqueada al error que corresponde.
 * Solo lanza si la aplicacion del gate esta encendida.
 */
export function kycDecisionToError(
  d: KycParticipantDecision,
  operationType: KycOperationType,
): Error | null {
  if (!config.kycGateEnabled || d.decision === 'pass') return null;
  if (d.tierDecision === 'block') {
    return new KycTierInsufficientError(d.requiredLevel, d.currentLevel, operationType);
  }
  const remaining = d.ceilingMxn === null ? 0 : Math.max(d.ceilingMxn - d.reservedMxn, 0);
  return new KycMonthlyCapExceededError(
    remaining,
    d.ceilingMxn ?? 0,
    currentMonthWindow().resetAt,
    d.currentLevel,
  );
}
