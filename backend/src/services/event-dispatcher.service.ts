import pino from 'pino';
import db from '../db/schema.js';
import { insertTradeAuditEvent } from '../db/audit-log.model.js';

const logger = pino({ name: 'event-dispatcher' });

// ── Types ─────────────────────────────────────────────────────────────────

/** Raw event shape from Stellar RPC getEvents. */
export interface RawContractEvent {
  id: string;
  topic: unknown[];
  value: unknown;
  txHash: string;
  ledger: number;
}

/** Parsed, XDR-free representation of a known escrow event. */
export interface ParsedEscrowEvent {
  type: 'locked' | 'released' | 'refunded';
  /** 64-char hex of the contract's trade_id (sha256 of secret_hash). */
  contractTradeIdHex: string;
  /** Stellar RPC event ID — used in audit metadata for traceability. */
  eventId: string;
  txHash: string;
  ledger: number;
}

// ── Parsing ───────────────────────────────────────────────────────────────

/**
 * Convert a raw Soroban contract event to a ParsedEscrowEvent.
 *
 * The escrow contract emits three event types:
 *   locked   → topic[0] = Symbol("locked"),   value = (trade_id, seller, buyer, amount, timeout_ledger)
 *   released → topic[0] = Symbol("released"), value = (trade_id, seller, buyer)
 *   refunded → topic[0] = Symbol("refunded"), value = (trade_id, seller)
 *
 * `scValToNative` is injected so this function is pure and unit-testable.
 *
 * Returns null for unknown or malformed events (caller should skip them).
 */
export function parseEscrowEvent(
  event: RawContractEvent,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  scValToNative: (v: any) => any,
): ParsedEscrowEvent | null {
  let eventType: string;
  try {
    eventType = String(scValToNative(event.topic[0]));
  } catch {
    return null;
  }

  if (eventType !== 'locked' && eventType !== 'released' && eventType !== 'refunded') {
    return null;
  }

  let tradeIdBytes: Buffer;
  try {
    const values = scValToNative(event.value) as unknown[];
    const raw = values[0];
    if (!raw || typeof raw !== 'object') return null;
    tradeIdBytes = Buffer.from(raw as ArrayBufferLike);
    if (tradeIdBytes.length !== 32) return null;
  } catch {
    return null;
  }

  return {
    type: eventType,
    contractTradeIdHex: tradeIdBytes.toString('hex'),
    eventId: event.id,
    txHash: event.txHash,
    ledger: event.ledger,
  };
}

// ── DB mutations (idempotent) ─────────────────────────────────────────────

const ACTOR_SYSTEM = 'system:event-listener';

/**
 * Estados en los que el escrow YA se liquido: los fondos salieron del contrato.
 *
 * Antes eran `completed` y `cancelled`. Pero `cancelled` no es una liquidacion:
 * cancelar detiene la app y NO toca el contrato (CASH-2). Una operacion
 * cancelada con bloqueo sigue teniendo los fondos dentro hasta que alguien
 * llama a `refund()` o `release()`, y ese evento era justo el que se ignoraba.
 * Y `refunded` no estaba, asi que un evento tardio podia degradar a `cancelled`
 * una operacion que el refund HTTP o el sweep ya habian liquidado.
 * (Hallazgo H1 de docs/AUDITORIA_IMPLEMENTACION_SELECTOR_ACTIVO_2026-09-14.md.)
 */
const SETTLED_STATES = new Set(['completed', 'refunded']);

/**
 * Apply a parsed escrow event to the database.
 *
 * Mutations are guarded with NOT IN ('completed', 'refunded') so re-delivering
 * the same event is a safe no-op, and a settled trade is never rewritten.
 *
 * - released  → completed, with the tx hash (clears encrypted secret).
 * - refunded  → refunded, with the tx hash in `release_tx_hash`, the same
 *               column the HTTP refund and the sweep use (clears secret).
 *               Also from `cancelled`: that is where refunds usually happen.
 * - locked    → no-op (the HTTP lock route already handled this).
 */
export async function applyEscrowEvent(parsed: ParsedEscrowEvent): Promise<void> {
  if (parsed.type === 'released') {
    await handleReleased(parsed);
  } else if (parsed.type === 'refunded') {
    await handleRefunded(parsed);
  }
  // 'locked': trade already updated by the HTTP route; nothing to do here.
}

// ── Full pipeline ─────────────────────────────────────────────────────────

/**
 * Parse a raw RPC event and apply the resulting DB mutation.
 * Called by EscrowEventListener for each deduplicated event.
 */
export async function dispatchEscrowEvent(event: RawContractEvent): Promise<void> {
  const { scValToNative } = await import('@stellar/stellar-sdk');

  const parsed = parseEscrowEvent(event, scValToNative);
  if (!parsed) {
    logger.debug({ event_id: event.id }, '[dispatcher] Unknown or malformed event — skipped');
    return;
  }

  await applyEscrowEvent(parsed);
}

// ── Handlers ──────────────────────────────────────────────────────────────

async function handleReleased(ev: ParsedEscrowEvent): Promise<void> {
  const trade = await db.getOne<{ id: string; status: string }>(
    'SELECT id, status FROM trades WHERE contract_trade_id = $1',
    [ev.contractTradeIdHex],
  );

  if (!trade) {
    // Expected when the on-chain release was performed by a different environment or
    // before this server had the contract_trade_id populated.
    logger.info(
      { contract_trade_id: ev.contractTradeIdHex, ledger: ev.ledger, category: 'event-dispatcher' },
      '[dispatcher] released event for untracked trade — skipped',
    );
    return;
  }

  if (SETTLED_STATES.has(trade.status)) {
    // Idempotent: already settled — no mutation required.
    return;
  }

  await db.execute(
    `UPDATE trades
        SET status       = 'completed',
            release_tx_hash = $2,
            completed_at = NOW(),
            secret_enc   = NULL,
            secret_nonce = NULL
      WHERE id     = $1
        AND status NOT IN ('completed', 'refunded')`,
    [trade.id, ev.txHash],
  );

  await insertTradeAuditEvent({
    tradeId: trade.id,
    fromState: trade.status,
    toState: 'completed',
    actor: ACTOR_SYSTEM,
    metadata: {
      source: 'soroban_event',
      event_id: ev.eventId,
      release_tx_hash: ev.txHash,
      ledger: ev.ledger,
    },
  });

  logger.info(
    { trade_id: trade.id, ledger: ev.ledger, tx_hash: ev.txHash, category: 'event-dispatcher' },
    '[dispatcher] Trade completed via on-chain released event',
  );
}

async function handleRefunded(ev: ParsedEscrowEvent): Promise<void> {
  const trade = await db.getOne<{ id: string; status: string }>(
    'SELECT id, status FROM trades WHERE contract_trade_id = $1',
    [ev.contractTradeIdHex],
  );

  if (!trade) {
    logger.info(
      { contract_trade_id: ev.contractTradeIdHex, ledger: ev.ledger, category: 'event-dispatcher' },
      '[dispatcher] refunded event for untracked trade — skipped',
    );
    return;
  }

  if (SETTLED_STATES.has(trade.status)) {
    return;
  }

  // Antes pasaba a `cancelled` sin guardar el hash: la fila quedaba con
  // `lock_tx_hash` y sin liquidacion, exactamente lo que la app lee como "en
  // garantia", con el dinero ya devuelto. Ahora queda como lo deja el refund
  // HTTP (`executeRefundOnChain`): `refunded` y el hash en `release_tx_hash`.
  await db.execute(
    `UPDATE trades
        SET status          = 'refunded',
            release_tx_hash = $2,
            completed_at    = NOW(),
            secret_enc      = NULL,
            secret_nonce    = NULL
      WHERE id     = $1
        AND status NOT IN ('completed', 'refunded')`,
    [trade.id, ev.txHash],
  );

  await insertTradeAuditEvent({
    tradeId: trade.id,
    fromState: trade.status,
    toState: 'refunded',
    actor: ACTOR_SYSTEM,
    metadata: {
      source: 'soroban_event',
      event_id: ev.eventId,
      refund_tx_hash: ev.txHash,
      ledger: ev.ledger,
    },
  });

  logger.info(
    { trade_id: trade.id, ledger: ev.ledger, tx_hash: ev.txHash, category: 'event-dispatcher' },
    '[dispatcher] Trade refunded via on-chain refunded event',
  );
}
