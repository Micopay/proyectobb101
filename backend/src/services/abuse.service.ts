import { createHash } from "crypto";
import type { FastifyRequest } from "fastify";
import db from "../db/schema.js";
import { config } from "../config.js";
import { insertTradeAuditEvent } from "../db/audit-log.model.js";
import { logAuditEvent } from "./audit.service.js";
import {
  NotFoundError,
  ForbiddenError,
  ConflictError,
  ValidationError,
  RiskBlockedError,
} from "../utils/errors.js";

const UTC_DAY_MS = 24 * 60 * 60 * 1000;

export interface ClientContext {
  ip: string;
  deviceIdHash: string | null;
}

export interface RecordTradeDisputeInput {
  tradeId: string;
  reportedBy?: string;
  openerId?: string;
  sellerId?: string;
  disputeId?: string;
  reason?: string;
  evidenceUrls?: string[];
}

export interface DisputeRecord {
  id: string;
  trade_id: string;
  reported_by: string;
  reason: string;
  evidence_urls: string[] | string;
  status: 'open' | 'resolved' | 'dismissed';
  resolution?: string | null;
  resolution_note?: string | null;
  resolved_by?: string | null;
  resolved_at?: string | null;
  created_at: string;
}

export function getClientContext(request: FastifyRequest): ClientContext {
  const ip =
    (request.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() ||
    request.ip ||
    "unknown";
  const rawDevice =
    (request.headers["x-device-id"] as string) ||
    (request.headers["x-micopay-device-id"] as string) ||
    "";
  const deviceIdHash = rawDevice
    ? createHash("sha256").update(rawDevice).digest("hex")
    : null;
  return { ip, deviceIdHash };
}

function getUtcDayRange(date = new Date()) {
  const start = new Date(
    Date.UTC(
      date.getUTCFullYear(),
      date.getUTCMonth(),
      date.getUTCDate(),
      0,
      0,
      0,
      0,
    ),
  );
  const end = new Date(start.getTime() + UTC_DAY_MS);
  return { start, end };
}

export async function touchUserDevice(
  userId: string,
  ctx: ClientContext,
): Promise<void> {
  if (!ctx.deviceIdHash) return;

  const existing = await db.getOne<{ id: string }>(
    `SELECT id FROM user_devices
     WHERE user_id = $1 AND device_id_hash = $2`,
    [userId, ctx.deviceIdHash],
  );

  if (existing) {
    await db.execute(
      `UPDATE user_devices
       SET last_ip = $1, last_seen_at = NOW()
       WHERE user_id = $2 AND device_id_hash = $3`,
      [ctx.ip, userId, ctx.deviceIdHash],
    );
    return;
  }

  await db.execute(
    `INSERT INTO user_devices (user_id, device_id_hash, last_ip, last_seen_at)
     VALUES ($1, $2, $3, NOW())`,
    [userId, ctx.deviceIdHash, ctx.ip],
  );
}

export async function assertUserCanAct(userId: string): Promise<void> {
  const user = await db.getOne<{
    is_suspended: boolean | null;
    is_banned?: boolean | null;
    availability: string | null;
  }>(
    `SELECT is_suspended, is_banned, availability FROM users WHERE id = $1 AND deleted_at IS NULL`,
    [userId],
  );

  if (!user) {
    throw new RiskBlockedError(
      "ACCOUNT_NOT_FOUND",
      "Tu cuenta no está disponible. Inicia sesión de nuevo.",
      `User ${userId} not found or deleted`,
    );
  }

  if (user.is_suspended || user.is_banned) {
    throw new RiskBlockedError(
      "ACCOUNT_SUSPENDED",
      "Tu cuenta está suspendida o bloqueada. Contacta a soporte si crees que es un error.",
      `User ${userId} is suspended or banned`,
    );
  }
}

/**
 * CASH-9: el actor del evento es el INICIADOR. Antes se registraba siempre al
 * comprador del escrow, asi que en cash-out el bloqueo quedaba a nombre del
 * proveedor y no de quien de verdad intento operar con una cuenta vinculada.
 * La comprobacion en si es simetrica y no cambia.
 */
async function assertNotRelatedAccounts(
  initiatorId: string,
  counterpartyId: string,
): Promise<void> {
  const initiator = await db.getOne<{ phone_hash: string | null }>(
    `SELECT phone_hash FROM users WHERE id = $1`,
    [initiatorId],
  );
  const counterparty = await db.getOne<{ phone_hash: string | null }>(
    `SELECT phone_hash FROM users WHERE id = $1`,
    [counterpartyId],
  );

  if (
    initiator?.phone_hash &&
    counterparty?.phone_hash &&
    initiator.phone_hash === counterparty.phone_hash
  ) {
    await logAuditEvent({
      action: "abuse.related_account_blocked",
      actorUserId: initiatorId,
      entityType: "trade",
      entityId: `${initiatorId}:${counterpartyId}`,
      details: { reason: "shared_phone_hash" },
    });
    throw new RiskBlockedError(
      "RELATED_ACCOUNTS",
      "No puedes operar con una cuenta vinculada a la tuya.",
      "Initiator and counterparty share phone_hash",
    );
  }
}

/**
 * CASH-9: operaciones que ESTA persona inicio hoy, en los dos flujos.
 *
 * Antes contaba `buyer_id = $1`, o sea el comprador del escrow. En un
 * cash-out ese es el PROVEEDOR, asi que el limite diario del cliente no se
 * medía y, en cambio, todo el volumen de cash-out del proveedor se le cargaba
 * a el como si fuera un cliente intensivo.
 *
 * Quien inicia es el cliente: comprador del escrow en deposito, vendedor en
 * cash-out. Con `flow` persistido (CASH-1) eso ya se puede preguntar.
 */
async function countInitiatorDailyTrades(initiatorId: string): Promise<{
  count: number;
  volumeMxn: number;
}> {
  const { start, end } = getUtcDayRange();
  const rows = await db.getMany<{ amount_mxn: number }>(
    `SELECT amount_mxn FROM trades
     WHERE ((flow = 'deposit' AND buyer_id = $1)
         OR (flow = 'cashout' AND seller_id = $1))
       AND created_at >= $2
       AND created_at < $3
       AND status IN ('pending', 'locked', 'revealing', 'completed')`,
    [initiatorId, start.toISOString(), end.toISOString()],
  );
  const volumeMxn = rows.reduce((sum, r) => sum + Number(r.amount_mxn || 0), 0);
  return { count: rows.length, volumeMxn };
}

async function countTradesForDeviceOrIp(
  deviceIdHash: string | null,
  ip: string,
): Promise<{ deviceCount: number; ipCount: number }> {
  const { start, end } = getUtcDayRange();
  const windowStart = start.toISOString();
  const windowEnd = end.toISOString();

  let deviceCount = 0;
  if (deviceIdHash) {
    const deviceUsers = await db.getMany<{ user_id: string }>(
      `SELECT user_id FROM user_devices WHERE device_id_hash = $1`,
      [deviceIdHash],
    );
    const userIds = deviceUsers.map((u) => u.user_id);
    for (const userId of userIds) {
      const rows = await db.getMany<{ id: string }>(
        `SELECT id FROM trades
         WHERE buyer_id = $1
           AND created_at >= $2
           AND created_at < $3
           AND status IN ('pending', 'locked', 'revealing', 'completed')`,
        [userId, windowStart, windowEnd],
      );
      deviceCount += rows.length;
    }
  }

  const ipRows = await db.getMany<{ id: string }>(
    `SELECT DISTINCT t.id
     FROM trades t
     JOIN user_devices d ON d.user_id = t.buyer_id
     WHERE d.last_ip = $1
       AND t.created_at >= $2
       AND t.created_at < $3
       AND t.status IN ('pending', 'locked', 'revealing', 'completed')`,
    [ip, windowStart, windowEnd],
  );

  return { deviceCount, ipCount: ipRows.length };
}

/**
 * CASH-9: el iniciador de una operacion es el CLIENTE, y quien es depende del
 * flujo, no del rol del escrow.
 *
 *   deposito · el cliente compra cripto con efectivo -> comprador del escrow
 *   cash-out · el cliente entrega cripto             -> vendedor del escrow
 *
 * Antes todo —dispositivo, limites diarios, actor de auditoria— se colgaba de
 * `buyer_id`. En cash-out eso es el proveedor, asi que el dispositivo del
 * cliente quedaba guardado bajo el proveedor, el mismo cliente no se seguia
 * entre proveedores distintos, y dos clientes sin relacion que usaran al mismo
 * proveedor parecian la misma persona.
 */
export function deriveInitiatorId(
  flow: TradeFlowForAbuse,
  sellerId: string,
  buyerId: string,
): string {
  return flow === 'cashout' ? sellerId : buyerId;
}

/** El flujo canonico, tal como lo persiste CASH-1. */
export type TradeFlowForAbuse = 'deposit' | 'cashout';

/** Ninguno de los dos participantes puede estar suspendido o baneado. */
async function assertParticipantsCanAct(buyerId: string, sellerId: string): Promise<void> {
  await assertUserCanAct(buyerId);
  await assertUserCanAct(sellerId);
}

/**
 * Politica del proveedor. CASH-9 la EXTRAE sin tocarla: es propiedad de
 * CASH-8, que la modificara despues sin editar el mismo cuerpo mezclado.
 */
async function assertProviderAvailable(providerId: string): Promise<void> {
  const provider = await db.getOne<{
    availability: string | null;
    is_suspended: boolean | null;
    merchant_available: boolean | null;
    provider_status: string | null;
  }>(
    `SELECT availability, is_suspended, merchant_available, provider_status
       FROM users WHERE id = $1`,
    [providerId],
  );

  // RED-1: quien no esta dado de alta en la Red no es proveedor, por muy
  // disponible que diga estar. El descubrimiento ya no lo ofrece; esto cierra
  // la puerta a quien llegue con un id directo.
  if ((provider?.provider_status ?? "not_enrolled") !== "active") {
    throw new RiskBlockedError(
      "MERCHANT_NOT_ENROLLED",
      "Esta persona no es agente de Red MicoPay.",
      `Provider ${providerId} provider_status=${provider?.provider_status ?? "not_enrolled"}`,
    );
  }

  if (provider?.is_suspended) {
    throw new RiskBlockedError(
      "MERCHANT_SUSPENDED",
      "Este comercio no puede recibir operaciones en este momento.",
      `Provider ${providerId} is suspended`,
    );
  }

  const availability = provider?.availability ?? "online";
  if (availability !== "online" || provider?.merchant_available === false) {
    throw new RiskBlockedError(
      "MERCHANT_UNAVAILABLE",
      "El comercio no está disponible para nuevas operaciones.",
      `Provider ${providerId} availability=${availability}`,
    );
  }
}

/** Limites diarios, de dispositivo y de red, todos del INICIADOR. */
async function assertInitiatorWithinLimits(
  initiatorId: string,
  ctx: { deviceIdHash: string | null; ip: string },
  amountMxn: number,
): Promise<void> {
  const { count, volumeMxn } = await countInitiatorDailyTrades(initiatorId);
  if (count >= config.buyerDailyTradeMax) {
    await logAuditEvent({
      action: "abuse.buyer_daily_trade_limit",
      actorUserId: initiatorId,
      entityType: "user",
      entityId: initiatorId,
      details: { count, limit: config.buyerDailyTradeMax },
    });
    throw new RiskBlockedError(
      "BUYER_DAILY_TRADE_LIMIT",
      `Has alcanzado el límite diario de ${config.buyerDailyTradeMax} operaciones. Intenta mañana (UTC).`,
      `Initiator ${initiatorId} exceeded daily trade count`,
      422,
    );
  }

  if (volumeMxn + amountMxn > config.buyerDailyAmountMxnMax) {
    throw new RiskBlockedError(
      "BUYER_DAILY_AMOUNT_LIMIT",
      `Superarías el límite diario de ${config.buyerDailyAmountMxnMax} MXN. Reduce el monto o intenta mañana (UTC).`,
      `Initiator ${initiatorId} daily volume cap`,
      422,
    );
  }

  const { deviceCount, ipCount } = await countTradesForDeviceOrIp(
    ctx.deviceIdHash,
    ctx.ip,
  );

  if (ctx.deviceIdHash && deviceCount >= config.deviceRateLimitMax) {
    throw new RiskBlockedError(
      "DEVICE_DAILY_LIMIT",
      "Este dispositivo alcanzó el límite diario de operaciones. Intenta mañana o usa otro dispositivo.",
      `Device ${ctx.deviceIdHash} trade limit`,
      429,
    );
  }

  if (ipCount >= config.ipRateLimitMax) {
    throw new RiskBlockedError(
      "IP_DAILY_LIMIT",
      "Se alcanzó el límite diario de operaciones desde esta red. Intenta más tarde.",
      `IP ${ctx.ip} trade limit`,
      429,
    );
  }
}

export async function assertCanCreateTrade(input: {
  request: FastifyRequest;
  buyerId: string;
  sellerId: string;
  /** CASH-1: flujo canonico. Sin el no se sabe quien inicia. */
  flow: TradeFlowForAbuse;
  /** CASH-1: proveedor derivado en el servidor, nunca del cuerpo. */
  providerId: string;
  amountMxn: number;
}): Promise<void> {
  const { request, buyerId, sellerId, flow, providerId, amountMxn } = input;
  const ctx = getClientContext(request);
  const initiatorId = deriveInitiatorId(flow, sellerId, buyerId);

  await assertParticipantsCanAct(buyerId, sellerId);

  // CASH-9: el dispositivo se guarda bajo quien de verdad opera.
  await touchUserDevice(initiatorId, ctx);
  await assertNotRelatedAccounts(initiatorId, providerId);

  await assertProviderAvailable(providerId);
  await assertInitiatorWithinLimits(initiatorId, ctx, amountMxn);
}

export async function assertCanCancelTrade(userId: string): Promise<void> {
  await assertUserCanAct(userId);

  const since = new Date(Date.now() - config.cancelCooldownWindowMs).toISOString();
  const recent = await db.getOne<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM audit_log
     WHERE actor = $1
       AND to_state = 'cancelled'
       AND occurred_at >= $2`,
    [userId, since],
  );

  const cancelCount = parseInt(recent?.count ?? "0", 10);
  if (cancelCount >= config.cancelCooldownThreshold) {
    await logAuditEvent({
      action: "abuse.cancel_cooldown",
      actorUserId: userId,
      entityType: "user",
      entityId: userId,
      details: {
        recent_cancellations: cancelCount,
        cooldown_ms: config.cancelCooldownMs,
      },
    });
    throw new RiskBlockedError(
      "CANCEL_COOLDOWN",
      `Demasiadas cancelaciones recientes. Espera ${Math.ceil(config.cancelCooldownMs / 60000)} minutos antes de cancelar otra operación.`,
      `User ${userId} cancel cooldown`,
      429,
    );
  }
}

export async function recordTradeCancelled(input: {
  tradeId: string;
  sellerId: string;
  cancelledBy: string;
}): Promise<void> {
  const { tradeId, sellerId, cancelledBy } = input;

  await logAuditEvent({
    action: "trade.cancelled",
    actorUserId: cancelledBy,
    entityType: "trade",
    entityId: tradeId,
    details: { seller_id: sellerId },
  });

  await maybeAutoPauseMerchant(sellerId);
}

export async function maybeAutoPauseMerchant(merchantId: string): Promise<void> {
  const { start, end } = getUtcDayRange();

  const cancelRow = await db.getOne<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM trades
     WHERE seller_id = $1
       AND status = 'cancelled'
       AND created_at >= $2
       AND created_at < $3`,
    [merchantId, start.toISOString(), end.toISOString()],
  );

  const cancelCount = parseInt(cancelRow?.count ?? "0", 10);
  if (cancelCount < config.merchantCancelPauseThreshold) {
    return;
  }

  await pauseUser(merchantId, "auto_pause_excessive_cancellations", null);
}

export async function recordTradeDispute(input: RecordTradeDisputeInput): Promise<DisputeRecord> {
  const { tradeId, reportedBy, openerId, sellerId, disputeId, reason = 'Trade dispute opened', evidenceUrls = [] } = input;
  const actor = reportedBy || openerId;

  if (!reason || reason.trim().length === 0) {
    throw new ValidationError('INVALID_REASON', 'Se requiere una razón para la disputa', 'Dispute reason is required');
  }

  const trade = await db.getOne<{ id: string; seller_id: string; buyer_id: string; status: string }>(
    'SELECT id, seller_id, buyer_id, status FROM trades WHERE id = $1',
    [tradeId],
  );

  if (!trade) {
    throw new NotFoundError('TRADE_NOT_FOUND', 'El intercambio no existe', 'Trade not found');
  }

  if (actor && trade.seller_id !== actor && trade.buyer_id !== actor) {
    throw new ForbiddenError('Solo los participantes del intercambio pueden abrir una disputa');
  }

  if (['completed', 'cancelled', 'refunded'].includes(trade.status)) {
    throw new ConflictError(`No se puede disputar un intercambio en estado ${trade.status}`);
  }

  // Check if an open dispute already exists in trade_disputes
  const existingDispute = await db.getOne<DisputeRecord>(
    "SELECT id, trade_id, opener_id AS reported_by, reason, evidence_urls, status, created_at FROM trade_disputes WHERE trade_id = $1 AND status = 'open'",
    [tradeId],
  );

  if (existingDispute) {
    return existingDispute;
  }

  const evidenceJson = JSON.stringify(evidenceUrls);
  const effectiveOpener = actor || trade.buyer_id;

  const dispute = await db.getOne<DisputeRecord>(
    `INSERT INTO trade_disputes (trade_id, opener_id, reason, evidence_urls, status)
     VALUES ($1, $2, $3, $4, 'open')
     RETURNING id, trade_id, opener_id AS reported_by, reason, evidence_urls, status, created_at`,
    [tradeId, effectiveOpener, reason, evidenceJson],
  );

  if (!dispute) {
    throw new Error('Failed to create dispute record in trade_disputes');
  }

  // Update trade status to 'disputed'
  await db.execute(
    "UPDATE trades SET status = 'disputed' WHERE id = $1",
    [tradeId],
  );

  // Log state transition
  if (actor) {
    await insertTradeAuditEvent({
      tradeId,
      fromState: trade.status,
      toState: 'disputed',
      actor,
      metadata: {
        dispute_id: dispute.id,
        reason,
        evidence_urls: evidenceUrls,
      },
    });
  }

  // Log audit event
  await logAuditEvent({
    action: 'trade.dispute_opened',
    actorUserId: effectiveOpener,
    entityType: 'trade_dispute',
    entityId: disputeId || dispute.id,
    details: { trade_id: tradeId, seller_id: sellerId || trade.seller_id, reason },
  });

  const effectiveSellerId = sellerId || trade.seller_id;
  const openDisputes = await db.getOne<{ count: string }>(
    `SELECT COUNT(*)::text AS count
     FROM trade_disputes d
     JOIN trades t ON t.id = d.trade_id
     WHERE t.seller_id = $1 AND d.status = 'open'`,
    [effectiveSellerId],
  );

  const count = parseInt(openDisputes?.count ?? '0', 10);
  if (count >= config.merchantDisputePauseThreshold) {
    await pauseUser(effectiveSellerId, 'auto_pause_excessive_disputes', null);
  }

  return {
    ...dispute,
    reported_by: dispute.reported_by || (dispute as any).opener_id || effectiveOpener,
  };
}

export async function getDisputeById(disputeId: string): Promise<DisputeRecord | null> {
  return db.getOne<DisputeRecord>(
    'SELECT id, trade_id, opener_id AS reported_by, reason, evidence_urls, status, resolution, resolution_note, resolved_by, resolved_at, created_at FROM trade_disputes WHERE id = $1',
    [disputeId],
  );
}

export async function getDisputeByTradeId(tradeId: string): Promise<DisputeRecord | null> {
  return db.getOne<DisputeRecord>(
    'SELECT id, trade_id, opener_id AS reported_by, reason, evidence_urls, status, resolution, resolution_note, resolved_by, resolved_at, created_at FROM trade_disputes WHERE trade_id = $1 ORDER BY created_at DESC LIMIT 1',
    [tradeId],
  );
}

export async function pauseUser(
  userId: string,
  reason: string,
  adminId: string | null,
): Promise<void> {
  await db.execute(
    // RED-1: pausar tiene que sacar del mapa de verdad. `availability` y
    // `merchant_available` son el mismo hecho contado dos veces; escribir solo
    // uno dejaba al proveedor pausado pero visible.
    `UPDATE users
     SET is_suspended = true,
         availability = 'paused',
         merchant_available = false,
         suspended_at = NOW(),
         suspension_reason = $2
     WHERE id = $1`,
    [userId, reason],
  );

  await logAuditEvent({
    action: "admin.user.suspended",
    actorUserId: adminId,
    entityType: "user",
    entityId: userId,
    details: { reason },
  });
}

export async function unpauseUser(
  userId: string,
  adminId: string | null,
): Promise<void> {
  await db.execute(
    // Reactivar no re-publica sola a una cuenta: vuelve en pausa y es la
    // persona quien decide ponerse disponible otra vez. Y si nunca fue agente,
    // levantar una suspension no puede convertirla en uno.
    `UPDATE users
     SET is_suspended = false,
         availability = 'paused',
         merchant_available = false,
         suspended_at = NULL,
         suspension_reason = NULL
     WHERE id = $1`,
    [userId],
  );

  await logAuditEvent({
    action: "admin.user.unsuspended",
    actorUserId: adminId,
    entityType: "user",
    entityId: userId,
    details: {},
  });
}

export async function assertCanOpenDispute(
  userId: string,
  tradeId: string,
): Promise<void> {
  await assertUserCanAct(userId);

  const existing = await db.getOne<{ id: string }>(
    `SELECT id FROM trade_disputes WHERE trade_id = $1 AND status = 'open'`,
    [tradeId],
  );
  if (existing) {
    throw new ForbiddenError(
      "DISPUTE_ALREADY_OPEN",
      "Ya hay una disputa abierta para esta operación.",
      `Open dispute exists for trade ${tradeId}`,
    );
  }
}
