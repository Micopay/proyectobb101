/**
 * Tests for the Soroban event listener.
 *
 * Covers:
 *   - jitteredBackoff: pure-function behaviour
 *   - isBeforeOldestLedgerError: error classification
 *   - EscrowEventListener: reconnect/backoff on fetch error
 *   - EscrowEventListener: duplicate event deduplication
 *   - EscrowEventListener: polling-fallback health signal (isHealthy)
 *   - parseEscrowEvent: event type classification and trade_id extraction
 *   - applyEscrowEvent: idempotency on already-terminal trade states
 *
 * Uses in-memory DB fallback (PostgreSQL not required) and mock deps for
 * the listener — no network access needed.
 */

import { ok, strictEqual } from 'assert';
import { randomUUID } from 'crypto';
import {
  jitteredBackoff,
  isBeforeOldestLedgerError,
  EscrowEventListener,
  type EventListenerDeps,
  type EventBatch,
} from '../services/event-listener.service.js';
import {
  parseEscrowEvent,
  applyEscrowEvent,
  type RawContractEvent,
  type ParsedEscrowEvent,
} from '../services/event-dispatcher.service.js';
import db from '../db/schema.js';

// ── Helpers ───────────────────────────────────────────────────────────────

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function makeEvent(id: string, topic0: string, valueBytes: Buffer): RawContractEvent {
  return {
    id,
    topic: [topic0],       // tests provide pre-stringified topics
    value: [valueBytes],   // tests provide pre-parsed values
    txHash: `txhash_${id}`,
    ledger: 1000,
  };
}

/** Build a deps object with safe defaults; override as needed per test. */
function makeDeps(overrides: Partial<EventListenerDeps> = {}): EventListenerDeps {
  return {
    fetchEvents: async (): Promise<EventBatch> => ({ events: [], latestLedger: 101 }),
    currentLedger: async () => 1000,
    loadCursor: async () => 100,
    saveCursor: async () => {},
    isDuplicate: async () => false,
    dispatch: async () => {},
    ...overrides,
  };
}

// ── jitteredBackoff ───────────────────────────────────────────────────────

async function testBackoffRange() {
  for (let attempt = 0; attempt <= 5; attempt++) {
    const ms = jitteredBackoff(attempt, 1_000, 60_000);
    ok(ms >= 1, `attempt ${attempt}: delay must be ≥ 1ms, got ${ms}`);
    ok(ms <= 60_000, `attempt ${attempt}: delay must be ≤ 60000ms, got ${ms}`);
  }
  console.log('  ✓ jitteredBackoff stays within [1, maxMs]');
}

async function testBackoffGrowth() {
  // With deterministic check: cap doubles per attempt up to maxMs.
  // Run many samples to verify median grows with attempt count.
  const samples = 200;
  const avg = (attempt: number) => {
    let sum = 0;
    for (let i = 0; i < samples; i++) sum += jitteredBackoff(attempt, 100, 100_000);
    return sum / samples;
  };
  ok(avg(3) > avg(0), 'Later attempts should have larger average backoff');
  console.log('  ✓ jitteredBackoff average grows with attempt count');
}

// ── isBeforeOldestLedgerError ─────────────────────────────────────────────

async function testBeforeOldestLedgerError() {
  ok(isBeforeOldestLedgerError(new Error('start is before oldest ledger')));
  ok(isBeforeOldestLedgerError(new Error('ledger before oldest')));
  ok(!isBeforeOldestLedgerError(new Error('network timeout')));
  ok(!isBeforeOldestLedgerError('not an error'));
  console.log('  ✓ isBeforeOldestLedgerError classifies correctly');
}

// ── EscrowEventListener — health signal ───────────────────────────────────

async function testHealthWhenStopped() {
  const listener = new EscrowEventListener('C_TEST', makeDeps());
  strictEqual(listener.isHealthy(), false, 'Stopped listener must not be healthy');
  strictEqual(listener.currentState(), 'stopped');
  console.log('  ✓ isHealthy() = false when stopped');
}

async function testHealthAfterSuccessfulPoll() {
  let pollCount = 0;
  const deps = makeDeps({
    fetchEvents: async () => {
      pollCount++;
      return { events: [], latestLedger: 101 };
    },
  });

  const listener = new EscrowEventListener('C_TEST', deps, {
    pollIntervalMs: 50,
    healthStaleMs: 5_000,
  });

  await listener.start();
  await delay(120); // allow at least two poll cycles
  const healthy = listener.isHealthy();
  listener.stop();

  ok(pollCount >= 1, `Expected at least 1 poll, got ${pollCount}`);
  ok(healthy, 'Listener should be healthy after successful polls');
  console.log('  ✓ isHealthy() = true after successful polls');
}

async function testHealthAfterStale() {
  const listener = new EscrowEventListener('C_TEST', makeDeps(), {
    pollIntervalMs: 10_000,   // long interval — won't poll again
    healthStaleMs: 1,          // expire immediately
  });
  await listener.start();
  await delay(50); // enough for first poll
  await delay(10); // ensure stale threshold passes
  const healthy = listener.isHealthy();
  listener.stop();

  // With healthStaleMs=1 the signal goes stale almost immediately.
  strictEqual(healthy, false, 'Listener should be unhealthy when stale');
  console.log('  ✓ isHealthy() = false after stale window');
}

// ── EscrowEventListener — reconnect / backoff ────────────────────────────

async function testReconnectAfterError() {
  let fetchCalls = 0;
  const deps = makeDeps({
    fetchEvents: async () => {
      fetchCalls++;
      if (fetchCalls === 1) throw new Error('RPC unavailable');
      return { events: [], latestLedger: 102 };
    },
  });

  const listener = new EscrowEventListener('C_TEST', deps, {
    pollIntervalMs: 20,
    backoffBaseMs: 10,
    backoffMaxMs: 30,
  });

  await listener.start();
  await delay(200); // allow several backoff cycles
  listener.stop();

  ok(fetchCalls >= 2, `Expected retry after error, got ${fetchCalls} fetch calls`);
  console.log('  ✓ Listener retries after fetch error with backoff');
}

async function testCursorResetOnOldestLedgerError() {
  let savedCursor = 12345; // simulate a very old cursor
  let resetCalled = false;

  const deps = makeDeps({
    loadCursor: async () => savedCursor,
    saveCursor: async (ledger) => {
      savedCursor = ledger;
      if (ledger === 0) resetCalled = true;
    },
    fetchEvents: async () => {
      throw new Error('start is before oldest ledger');
    },
    currentLedger: async () => 99999,
  });

  const listener = new EscrowEventListener('C_TEST', deps, {
    pollIntervalMs: 50,
    backoffBaseMs: 10,
    backoffMaxMs: 20,
  });

  await listener.start();
  await delay(150);
  listener.stop();

  ok(resetCalled, 'Cursor should be reset to 0 when RPC window exceeded');
  console.log('  ✓ Cursor resets to 0 on oldest-ledger error');
}

// ── EscrowEventListener — deduplication ──────────────────────────────────

async function testDuplicateEventSkipped() {
  const processedIds = new Set<string>();
  let dispatchCount = 0;

  const sameEvent = makeEvent('evt-42', 'released', Buffer.alloc(32));

  const deps = makeDeps({
    fetchEvents: async () => ({
      events: [sameEvent, sameEvent], // same event delivered twice in one batch
      latestLedger: 102,
    }),
    isDuplicate: async (id) => {
      if (processedIds.has(id)) return true;
      processedIds.add(id);
      return false;
    },
    dispatch: async () => { dispatchCount++; },
  });

  const listener = new EscrowEventListener('C_TEST', deps, { pollIntervalMs: 10_000 });
  await listener.start();
  await delay(80);
  listener.stop();

  strictEqual(dispatchCount, 1, 'Duplicate event must be dispatched exactly once');
  console.log('  ✓ Duplicate events in the same batch dispatched only once');
}

async function testDuplicateAcrossPolls() {
  const processedIds = new Set<string>();
  let dispatchCount = 0;
  let pollCount = 0;

  const deps = makeDeps({
    fetchEvents: async () => {
      pollCount++;
      // Return the same event on every poll
      return {
        events: [makeEvent('evt-99', 'released', Buffer.alloc(32))],
        latestLedger: 100 + pollCount,
      };
    },
    isDuplicate: async (id) => {
      if (processedIds.has(id)) return true;
      processedIds.add(id);
      return false;
    },
    dispatch: async () => { dispatchCount++; },
  });

  const listener = new EscrowEventListener('C_TEST', deps, {
    pollIntervalMs: 30,
  });

  await listener.start();
  await delay(200); // allow multiple polls
  listener.stop();

  ok(pollCount >= 2, `Expected multiple polls, got ${pollCount}`);
  strictEqual(dispatchCount, 1, 'Same event across polls must only be dispatched once');
  console.log('  ✓ Same event across multiple polls dispatched only once');
}

// ── parseEscrowEvent ──────────────────────────────────────────────────────

async function testParseReleasedEvent() {
  const tradeId = Buffer.from('a'.repeat(64), 'hex'); // 32 bytes

  // Mock scValToNative: topics are already strings, value is already an array
  const mockParser = (v: unknown) => v;

  const event: RawContractEvent = {
    id: 'evt-parse-1',
    topic: ['released'],
    value: [tradeId, 'GSELLER...', 'GBUYER...'],
    txHash: 'tx_abc',
    ledger: 500,
  };

  const parsed = parseEscrowEvent(event, mockParser);

  ok(parsed !== null, 'Should parse released event');
  strictEqual(parsed!.type, 'released');
  strictEqual(parsed!.contractTradeIdHex, 'a'.repeat(64));
  strictEqual(parsed!.txHash, 'tx_abc');
  strictEqual(parsed!.ledger, 500);
  console.log('  ✓ parseEscrowEvent handles released event');
}

async function testParseRefundedEvent() {
  const tradeId = Buffer.from('b'.repeat(64), 'hex');
  const mockParser = (v: unknown) => v;

  const event: RawContractEvent = {
    id: 'evt-parse-2',
    topic: ['refunded'],
    value: [tradeId, 'GSELLER...'], // refunded only has trade_id + seller
    txHash: 'tx_def',
    ledger: 501,
  };

  const parsed = parseEscrowEvent(event, mockParser);

  ok(parsed !== null);
  strictEqual(parsed!.type, 'refunded');
  strictEqual(parsed!.contractTradeIdHex, 'b'.repeat(64));
  console.log('  ✓ parseEscrowEvent handles refunded event');
}

async function testParseLockedEvent() {
  const tradeId = Buffer.from('c'.repeat(64), 'hex');
  const mockParser = (v: unknown) => v;

  const event: RawContractEvent = {
    id: 'evt-parse-3',
    topic: ['locked'],
    value: [tradeId, 'GSELLER...', 'GBUYER...', BigInt(1000), 9999],
    txHash: 'tx_ghi',
    ledger: 502,
  };

  const parsed = parseEscrowEvent(event, mockParser);

  ok(parsed !== null);
  strictEqual(parsed!.type, 'locked');
  console.log('  ✓ parseEscrowEvent handles locked event');
}

async function testParseUnknownEventReturnsNull() {
  const mockParser = (v: unknown) => v;
  const event: RawContractEvent = {
    id: 'evt-unknown',
    topic: ['transfer'],
    value: [],
    txHash: 'tx_x',
    ledger: 1,
  };
  strictEqual(parseEscrowEvent(event, mockParser), null, 'Unknown topic must return null');
  console.log('  ✓ parseEscrowEvent returns null for unknown topics');
}

async function testParseMalformedValueReturnsNull() {
  const mockParser = (v: unknown) => { throw new Error('bad XDR'); };
  const event: RawContractEvent = {
    id: 'evt-bad',
    topic: ['released'],
    value: 'corrupt',
    txHash: 'tx_y',
    ledger: 1,
  };
  strictEqual(parseEscrowEvent(event, mockParser), null, 'Malformed event must return null');
  console.log('  ✓ parseEscrowEvent returns null when parser throws');
}

async function testParseWrongTradeIdLength() {
  const shortBytes = Buffer.alloc(16); // 16 bytes — should be 32
  const mockParser = (v: unknown) => v;
  const event: RawContractEvent = {
    id: 'evt-short',
    topic: ['released'],
    value: [shortBytes, 'G...'],
    txHash: 'tx_z',
    ledger: 1,
  };
  strictEqual(parseEscrowEvent(event, mockParser), null, '16-byte trade_id must return null');
  console.log('  ✓ parseEscrowEvent rejects trade_id with wrong length');
}

// ── applyEscrowEvent — idempotency ────────────────────────────────────────
//
// These tests use the real in-memory DB (schema.ts fallback) so we exercise
// the actual SQL path without needing PostgreSQL or module patching.

/** Insert a minimal trade row directly into the in-memory store. */
async function insertTestTrade(overrides: {
  id: string;
  status: string;
  contractTradeId: string;
}): Promise<void> {
  // CASH-1: fixtures model a deposit, so the escrow seller is also the
  // provider. Hoisted because provider_id must equal seller_id — two separate
  // randomUUID() calls would violate chk_trades_flow_provider.
  //
  // Los dos participantes se crean de verdad: contra PostgreSQL las llaves
  // foraneas de `trades` rechazan ids inventados, y asi la suite puede probar
  // el SQL real del dispatcher y no solo el store en memoria.
  const suffix = randomUUID().replace(/-/g, '');
  const makeUser = async (label: string) => {
    const row = await db.getOne<{ id: string }>(
      `INSERT INTO users (stellar_address, username) VALUES ($1, $2) RETURNING id`,
      [`G${suffix.slice(0, 32).toUpperCase()}${label}`.padEnd(56, 'A').slice(0, 56), `evt_${label}_${suffix.slice(0, 20)}`],
    );
    if (!row?.id) throw new Error('Failed to seed user');
    return row.id;
  };
  const sellerId = await makeUser('S');
  const buyerId = await makeUser('B');

  await db.execute(
    `INSERT INTO trades
       (id, status, contract_trade_id, seller_id, buyer_id, flow, provider_id,
        amount_mxn, amount_stroops, platform_fee_mxn, secret_hash)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [
      overrides.id,
      overrides.status,
      overrides.contractTradeId,
      sellerId,       // seller_id
      buyerId,        // buyer_id
      'deposit',      // flow
      sellerId,       // provider_id
      100,            // amount_mxn
      '1000000000',   // amount_stroops
      1,              // platform_fee_mxn
      'testhash',     // secret_hash
    ],
  );
}

async function testApplyReleasedIdempotentOnCompleted() {
  const contractTradeId = 'e'.repeat(64);
  const tradeId = randomUUID();

  await insertTestTrade({ id: tradeId, status: 'completed', contractTradeId });

  const parsed: ParsedEscrowEvent = {
    type: 'released',
    contractTradeIdHex: contractTradeId,
    eventId: 'evt-idem-1',
    txHash: 'tx_idem_1',
    ledger: 100,
  };

  await applyEscrowEvent(parsed);

  const after = await db.getOne<{ status: string }>('SELECT status FROM trades WHERE id = $1', [tradeId]);
  strictEqual(after?.status, 'completed', 'Already-completed trade must stay completed');
  console.log('  ✓ applyEscrowEvent(released) is a no-op when trade is already completed');
}

/**
 * H1: cancelar no liquida el contrato. Una operacion cancelada con bloqueo es
 * justo donde llega el refund; antes el evento se ignoraba y la fila quedaba
 * "en garantia" con el dinero ya devuelto.
 */
async function testApplyRefundedSettlesCancelledTrade() {
  const contractTradeId = 'f'.repeat(64);
  const tradeId = randomUUID();

  await insertTestTrade({ id: tradeId, status: 'cancelled', contractTradeId });

  const parsed: ParsedEscrowEvent = {
    type: 'refunded',
    contractTradeIdHex: contractTradeId,
    eventId: 'evt-idem-2',
    txHash: 'tx_idem_2',
    ledger: 200,
  };

  await applyEscrowEvent(parsed);

  const after = await db.getOne<{ status: string; release_tx_hash: string | null }>(
    'SELECT status, release_tx_hash FROM trades WHERE id = $1', [tradeId]);
  strictEqual(after?.status, 'refunded', 'A cancelled trade with funds inside must become refunded');
  strictEqual(after?.release_tx_hash, 'tx_idem_2', 'The refund tx hash must be recorded');
  console.log('  ✓ applyEscrowEvent(refunded) settles a cancelled trade as refunded with its hash');
}

/** H1: un evento tardio no reescribe una operacion que el refund HTTP/sweep ya liquido. */
async function testLateRefundedEventKeepsRefundedTrade() {
  const contractTradeId = '3c'.repeat(32);
  const tradeId = randomUUID();

  await insertTestTrade({ id: tradeId, status: 'refunded', contractTradeId });
  await db.execute('UPDATE trades SET release_tx_hash = $2 WHERE id = $1', [tradeId, 'tx_http_refund']);

  for (const type of ['refunded', 'released'] as const) {
    await applyEscrowEvent({
      type,
      contractTradeIdHex: contractTradeId,
      eventId: `evt-late-${type}`,
      txHash: `tx_late_${type}`,
      ledger: 500,
    });
  }

  const after = await db.getOne<{ status: string; release_tx_hash: string | null }>(
    'SELECT status, release_tx_hash FROM trades WHERE id = $1', [tradeId]);
  strictEqual(after?.status, 'refunded', 'A refunded trade must stay refunded');
  strictEqual(after?.release_tx_hash, 'tx_http_refund', 'The original refund hash must be kept');
  console.log('  ✓ late refunded/released events do not rewrite an already refunded trade');
}

/** H1: repetir el mismo evento de reembolso es idempotente. */
async function testRefundedEventIsIdempotent() {
  const contractTradeId = '4d'.repeat(32);
  const tradeId = randomUUID();

  await insertTestTrade({ id: tradeId, status: 'locked', contractTradeId });
  const ev: ParsedEscrowEvent = {
    type: 'refunded', contractTradeIdHex: contractTradeId, eventId: 'evt-rep', txHash: 'tx_rep_1', ledger: 600,
  };
  await applyEscrowEvent(ev);
  await applyEscrowEvent({ ...ev, txHash: 'tx_rep_2' });

  const after = await db.getOne<{ status: string; release_tx_hash: string | null }>(
    'SELECT status, release_tx_hash FROM trades WHERE id = $1', [tradeId]);
  strictEqual(after?.status, 'refunded');
  strictEqual(after?.release_tx_hash, 'tx_rep_1', 'The first settlement hash wins');
  console.log('  ✓ re-delivering a refunded event is a no-op');
}

async function testApplyReleasedUpdatesActiveTradeToCompleted() {
  const contractTradeId = '1a'.repeat(32);
  const tradeId = randomUUID();

  await insertTestTrade({ id: tradeId, status: 'revealing', contractTradeId });

  const parsed: ParsedEscrowEvent = {
    type: 'released',
    contractTradeIdHex: contractTradeId,
    eventId: 'evt-idem-3',
    txHash: 'tx_idem_3',
    ledger: 300,
  };

  await applyEscrowEvent(parsed);

  const after = await db.getOne<{ status: string }>('SELECT status FROM trades WHERE id = $1', [tradeId]);
  strictEqual(after?.status, 'completed', 'Trade in revealing state must be moved to completed');
  console.log('  ✓ applyEscrowEvent(released) completes an active trade');
}

async function testApplyRefundedUpdatesActiveTradeToRefunded() {
  const contractTradeId = '2b'.repeat(32);
  const tradeId = randomUUID();

  await insertTestTrade({ id: tradeId, status: 'locked', contractTradeId });

  const parsed: ParsedEscrowEvent = {
    type: 'refunded',
    contractTradeIdHex: contractTradeId,
    eventId: 'evt-idem-4',
    txHash: 'tx_idem_4',
    ledger: 400,
  };

  await applyEscrowEvent(parsed);

  const after = await db.getOne<{ status: string; release_tx_hash: string | null }>(
    'SELECT status, release_tx_hash FROM trades WHERE id = $1', [tradeId]);
  strictEqual(after?.status, 'refunded', 'Locked trade must be refunded on on-chain refund');
  strictEqual(after?.release_tx_hash, 'tx_idem_4', 'The refund tx hash must be recorded');
  console.log('  ✓ applyEscrowEvent(refunded) refunds an active trade and records the hash');
}

// ── Runner ────────────────────────────────────────────────────────────────

const SUITES = [
  { name: 'jitteredBackoff', tests: [testBackoffRange, testBackoffGrowth] },
  { name: 'isBeforeOldestLedgerError', tests: [testBeforeOldestLedgerError] },
  { name: 'EscrowEventListener — health', tests: [testHealthWhenStopped, testHealthAfterSuccessfulPoll, testHealthAfterStale] },
  { name: 'EscrowEventListener — reconnect', tests: [testReconnectAfterError, testCursorResetOnOldestLedgerError] },
  { name: 'EscrowEventListener — deduplication', tests: [testDuplicateEventSkipped, testDuplicateAcrossPolls] },
  { name: 'parseEscrowEvent', tests: [testParseReleasedEvent, testParseRefundedEvent, testParseLockedEvent, testParseUnknownEventReturnsNull, testParseMalformedValueReturnsNull, testParseWrongTradeIdLength] },
  { name: 'applyEscrowEvent — idempotency', tests: [testApplyReleasedIdempotentOnCompleted, testApplyRefundedSettlesCancelledTrade, testLateRefundedEventKeepsRefundedTrade, testRefundedEventIsIdempotent, testApplyReleasedUpdatesActiveTradeToCompleted, testApplyRefundedUpdatesActiveTradeToRefunded] },
];

async function runAll() {
  let passed = 0;
  let failed = 0;

  for (const suite of SUITES) {
    console.log(`\n${suite.name}`);
    for (const test of suite.tests) {
      try {
        await test();
        passed++;
      } catch (err: any) {
        console.error(`  ✗ ${test.name}: ${err.message}`);
        failed++;
      }
    }
  }

  console.log(`\n${'─'.repeat(50)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);

  if (failed > 0) process.exit(1);
}

runAll().catch((err) => {
  console.error('Test runner crashed:', err);
  process.exit(1);
});
