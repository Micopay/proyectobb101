import pino from 'pino';
import type { RawContractEvent } from './event-dispatcher.service.js';
import { rpcRead } from '../lib/stellarRpc.js';

const logger = pino({ name: 'event-listener' });

// ── Defaults ──────────────────────────────────────────────────────────────
const POLL_INTERVAL_MS    = 2_000;
const BACKOFF_BASE_MS     = 1_000;
const BACKOFF_MAX_MS      = 60_000;
const HEALTH_STALE_MS     = 30_000;
const EVENTS_PAGE_LIMIT   = 200;
const SYSTEM_UUID         = '00000000-0000-0000-0000-000000000000';

// ── Pure helpers (exported for unit testing) ──────────────────────────────

/**
 * Full-jitter exponential backoff.
 * Returns a random delay in [1, min(maxMs, baseMs * 2^attempt)] ms.
 * Space complexity O(1); time complexity O(1).
 */
export function jitteredBackoff(attempt: number, baseMs: number, maxMs: number): number {
  const cap = Math.min(maxMs, baseMs * 2 ** attempt);
  return Math.floor(Math.random() * cap) + 1;
}

/** True when the RPC error indicates the requested ledger predates the 7-day window. */
export function isBeforeOldestLedgerError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();
  return msg.includes('oldest ledger') || msg.includes('before oldest') || msg.includes('-32600');
}

// ── Types ─────────────────────────────────────────────────────────────────

export interface EventBatch {
  events: RawContractEvent[];
  latestLedger: number;
}

/**
 * Injectable dependencies — the entire I/O surface of EscrowEventListener.
 * All Stellar SDK and DB calls go through these, making the class fully
 * testable without network access.
 */
export interface EventListenerDeps {
  /** Fetch contract events from startLedger onwards (inclusive). */
  fetchEvents: (startLedger: number) => Promise<EventBatch>;
  /** Return the current on-chain latest ledger sequence. */
  currentLedger: () => Promise<number>;
  /** Load the persisted cursor. Returns 0 on first run. */
  loadCursor: () => Promise<number>;
  /** Persist the cursor after a successful batch. */
  saveCursor: (ledger: number) => Promise<void>;
  /**
   * Atomically mark an event as processed.
   * Returns true  → event was already processed (skip dispatch).
   * Returns false → event is new (dispatch and record).
   */
  isDuplicate: (eventId: string) => Promise<boolean>;
  /** Apply a new deduplicated event to the database. */
  dispatch: (event: RawContractEvent) => Promise<void>;
}

type ListenerState = 'running' | 'reconnecting' | 'stopped';

// ── Core class ────────────────────────────────────────────────────────────

export class EscrowEventListener {
  private state: ListenerState = 'stopped';
  private lastSuccessAt = 0;
  private failures = 0;
  private abortController: AbortController | null = null;

  constructor(
    readonly contractId: string,
    private readonly deps: EventListenerDeps,
    private readonly opts: {
      pollIntervalMs?: number;
      backoffBaseMs?: number;
      backoffMaxMs?: number;
      healthStaleMs?: number;
    } = {},
  ) {}

  /**
   * Returns true when the listener has polled successfully within the health
   * stale window. Frontend polling is the fallback when this returns false.
   */
  isHealthy(): boolean {
    if (this.state !== 'running') return false;
    const staleMs = this.opts.healthStaleMs ?? HEALTH_STALE_MS;
    return Date.now() - this.lastSuccessAt < staleMs;
  }

  currentState(): ListenerState {
    return this.state;
  }

  /**
   * Start the background polling loop.
   * Idempotent: second call while already running is a no-op.
   */
  async start(): Promise<void> {
    if (this.state !== 'stopped') return;
    this.state = 'running';
    this.abortController = new AbortController();
    // Detach the loop — errors are caught internally and trigger backoff.
    setImmediate(() => this.loop(this.abortController!.signal).catch((err) => {
      logger.error({ err, category: 'event-listener' }, '[event-listener] Unhandled loop error');
    }));
    logger.info({ contract_id: this.contractId, category: 'event-listener' }, '[event-listener] Started');
  }

  /** Graceful shutdown: aborts the sleep, lets the current poll finish. */
  stop(): void {
    this.state = 'stopped';
    this.abortController?.abort();
    logger.info({ category: 'event-listener' }, '[event-listener] Stopped');
  }

  // ── Private ──────────────────────────────────────────────────────────────

  // Indirection prevents TypeScript from over-narrowing this.state to a
  // specific literal after assignments within the same method body.
  private isStopped(): boolean {
    return this.state === 'stopped';
  }

  private async loop(signal: AbortSignal): Promise<void> {
    while (!signal.aborted && !this.isStopped()) {
      try {
        await this.pollOnce();
        this.failures = 0;
        this.lastSuccessAt = Date.now();
        await sleep(this.opts.pollIntervalMs ?? POLL_INTERVAL_MS, signal);
      } catch (err) {
        if (signal.aborted || this.isStopped()) break;

        this.failures++;
        const delay = jitteredBackoff(
          this.failures,
          this.opts.backoffBaseMs ?? BACKOFF_BASE_MS,
          this.opts.backoffMaxMs  ?? BACKOFF_MAX_MS,
        );
        logger.warn(
          { err, failures: this.failures, backoff_ms: delay, category: 'event-listener' },
          '[event-listener] Poll error — backing off',
        );
        this.state = 'reconnecting';
        await sleep(delay, signal);
        if (!signal.aborted && !this.isStopped()) this.state = 'running';
      }
    }
  }

  private async pollOnce(): Promise<void> {
    const cursor = await this.deps.loadCursor();

    if (cursor === 0) {
      // First run: anchor the cursor to the current ledger so we do not
      // replay the entire 7-day RPC history window.
      const current = await this.deps.currentLedger();
      await this.deps.saveCursor(current);
      logger.info(
        { ledger: current, contract_id: this.contractId, category: 'event-listener' },
        '[event-listener] Cursor bootstrapped to current ledger',
      );
      return;
    }

    let batch: EventBatch;
    try {
      batch = await this.deps.fetchEvents(cursor + 1);
    } catch (err) {
      if (isBeforeOldestLedgerError(err)) {
        // Cursor predates RPC history window (e.g. long downtime).
        // Reset to trigger a fresh bootstrap on the next poll.
        logger.warn(
          { cursor, contract_id: this.contractId, category: 'event-listener' },
          '[event-listener] Cursor outside RPC window — resetting',
        );
        await this.deps.saveCursor(0);
        return; // Not a failure; the next pollOnce will bootstrap.
      }
      throw err;
    }

    // Process events in ledger order. O(n) where n = new events in this batch.
    for (const event of batch.events) {
      const duplicate = await this.deps.isDuplicate(event.id);
      if (duplicate) continue;
      await this.deps.dispatch(event);
    }

    // Advance cursor regardless of whether events were found.
    if (batch.latestLedger > cursor) {
      await this.deps.saveCursor(batch.latestLedger);
    }
  }
}

// ── Production factory ────────────────────────────────────────────────────

/**
 * Construct an EscrowEventListener wired to the real Stellar RPC and DB.
 *
 * All I/O is expressed through lazy closures so this factory remains
 * synchronous. ESM module cache makes repeated dynamic imports O(1).
 */
export function createProductionListener(
  contractId: string,
  rpcUrl: string,
  opts: { pollIntervalMs?: number; healthStaleMs?: number } = {},
): EscrowEventListener {
  // The listener has its own backoff loop, so these reads are not retried
  // here; they still count towards the shared Stellar RPC breaker.
  const fetchEvents = async (startLedger: number): Promise<EventBatch> => {
    const res = await rpcRead(rpcUrl, (server) => server.getEvents({
      startLedger,
      filters: [{ type: 'contract', contractIds: [contractId] }],
      limit: EVENTS_PAGE_LIMIT,
    }), { retry: false });
    return {
      events: res.events as unknown as RawContractEvent[],
      latestLedger: res.latestLedger,
    };
  };

  const currentLedger = async (): Promise<number> => {
    const info = await rpcRead(rpcUrl, (server) => server.getLatestLedger(), { retry: false });
    return info.sequence;
  };

  const isDuplicate = async (eventId: string): Promise<boolean> => {
    const db = (await import('../db/schema.js')).default;
    // Reuse processed_tx for event deduplication.
    // Key format: "evt:{eventId}" — max ~36 chars, within VARCHAR(64).
    const key = `evt:${eventId}`;
    const inserted = await db.insertUnique(
      `INSERT INTO processed_tx (tx_hash, source_route, user_id, processed_at)
       VALUES ($1, 'event-listener', $2, NOW())
       RETURNING tx_hash`,
      [key, SYSTEM_UUID],
      'tx_hash',
    );
    return inserted === null; // null = ON CONFLICT = already processed
  };

  const loadCursor = async (): Promise<number> => {
    const { getEventCursor } = await import('../db/event-cursor.model.js');
    return getEventCursor(contractId);
  };

  const saveCursor = async (ledger: number): Promise<void> => {
    const { setEventCursor } = await import('../db/event-cursor.model.js');
    return setEventCursor(contractId, ledger);
  };

  const dispatch = async (event: RawContractEvent): Promise<void> => {
    const { dispatchEscrowEvent } = await import('./event-dispatcher.service.js');
    return dispatchEscrowEvent(event);
  };

  return new EscrowEventListener(contractId, {
    fetchEvents,
    currentLedger,
    loadCursor,
    saveCursor,
    isDuplicate,
    dispatch,
  }, opts);
}

// ── Helpers ───────────────────────────────────────────────────────────────

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(new Error('sleep aborted'));
    }, { once: true });
  });
}
