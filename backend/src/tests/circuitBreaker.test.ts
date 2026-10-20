/**
 * Circuit breaker (F1): opening, rejection without touching the network,
 * half-open recovery, timeout, and which failures are retried or counted.
 *
 * Uses a fake clock and instant sleeps; only the timeout test waits for real
 * (a few tens of milliseconds). No network access.
 */

import { ok, strictEqual } from 'assert';
import {
  CircuitBreaker,
  CircuitOpenError,
  UpstreamTimeoutError,
  isTransientError,
  type CircuitBreakerConfig,
  type RetryConfig,
} from '../lib/circuitBreaker.js';
import { BadRequestError } from '../utils/errors.js';

const LABELS = { code: 'TEST', unavailableMessage: 'no disponible', timeoutMessage: 'tarda' };

function makeBreaker(overrides: Partial<CircuitBreakerConfig & RetryConfig> = {}) {
  let now = 1_000_000;
  const sleeps: number[] = [];
  const transitions: string[] = [];
  const breaker = new CircuitBreaker('test', {
    timeout: 1000,
    errorThresholdPercentage: 50,
    volumeThreshold: 5,
    resetTimeout: 30_000,
    rollingCountTimeout: 10_000,
    maxRetries: 3,
    baseDelayMs: 100,
    maxDelayMs: 1000,
    ...overrides,
  }, LABELS, {
    now: () => now,
    sleep: async (ms) => { sleeps.push(ms); },
    random: () => 0.5,
    onStateChange: (_n, from, to) => transitions.push(`${from}->${to}`),
  });
  return { breaker, sleeps, transitions, advance: (ms: number) => { now += ms; } };
}

const networkError = () => Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });

async function rejects(p: Promise<unknown>): Promise<any> {
  try {
    await p;
  } catch (err) {
    return err;
  }
  throw new Error('expected a rejection');
}

let passed = 0;
let failed = 0;
async function test(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    console.error(`  ✗ ${name}\n    ${(err as Error).stack}`);
  }
}

console.log('circuit breaker');

await test('opens after the failure threshold is reached within the window', async () => {
  const { breaker, transitions } = makeBreaker();
  for (let i = 0; i < 4; i++) await rejects(breaker.run(async () => { throw networkError(); }));
  strictEqual(breaker.state, 'closed', 'below volumeThreshold it stays closed');
  await rejects(breaker.run(async () => { throw networkError(); }));
  strictEqual(breaker.state, 'open');
  strictEqual(transitions.join(','), 'closed->open');
});

await test('does not open while failures stay under the percentage', async () => {
  const { breaker } = makeBreaker();
  for (let i = 0; i < 6; i++) await breaker.run(async () => 'ok');
  for (let i = 0; i < 5; i++) await rejects(breaker.run(async () => { throw networkError(); }));
  strictEqual(breaker.state, 'closed', '5 of 11 is under 50%');
});

await test('forgets failures older than the rolling window', async () => {
  const { breaker, advance } = makeBreaker();
  for (let i = 0; i < 4; i++) await rejects(breaker.run(async () => { throw networkError(); }));
  advance(10_001);
  await rejects(breaker.run(async () => { throw networkError(); }));
  strictEqual(breaker.state, 'closed', 'only one failure is inside the window');
});

await test('an open circuit rejects without calling the upstream', async () => {
  const { breaker } = makeBreaker();
  for (let i = 0; i < 5; i++) await rejects(breaker.run(async () => { throw networkError(); }));
  let calls = 0;
  const err = await rejects(breaker.run(async () => { calls++; return 'ok'; }));
  ok(err instanceof CircuitOpenError);
  strictEqual(err.httpStatus, 503);
  strictEqual(err.code, 'TEST_UNAVAILABLE');
  strictEqual(calls, 0, 'the network was never touched');
  strictEqual(breaker.metrics.rejected, 1);
});

await test('half-open lets exactly one probe through and closes on success', async () => {
  const { breaker, advance, transitions } = makeBreaker();
  for (let i = 0; i < 5; i++) await rejects(breaker.run(async () => { throw networkError(); }));
  advance(29_999);
  ok(await rejects(breaker.run(async () => 'ok')) instanceof CircuitOpenError, 'still open before resetTimeout');
  advance(1);

  let release!: (v: string) => void;
  const probe = breaker.run(() => new Promise<string>((r) => { release = r; }));
  strictEqual(breaker.state, 'half_open');
  let second = 0;
  const err = await rejects(breaker.run(async () => { second++; return 'ok'; }));
  ok(err instanceof CircuitOpenError, 'a concurrent call is rejected while the probe runs');
  strictEqual(second, 0);

  release('ok');
  strictEqual(await probe, 'ok');
  strictEqual(breaker.state, 'closed');
  strictEqual(transitions.join(','), 'closed->open,open->half_open,half_open->closed');
  strictEqual(await breaker.run(async () => 'again'), 'again');
});

await test('a failed probe reopens the circuit for another resetTimeout', async () => {
  const { breaker, advance } = makeBreaker();
  for (let i = 0; i < 5; i++) await rejects(breaker.run(async () => { throw networkError(); }));
  advance(30_000);
  await rejects(breaker.run(async () => { throw networkError(); }));
  strictEqual(breaker.state, 'open');
  advance(29_999);
  ok(await rejects(breaker.run(async () => 'ok')) instanceof CircuitOpenError);
});

await test('a probe answered with a client error proves the upstream is up', async () => {
  const { breaker, advance } = makeBreaker();
  for (let i = 0; i < 5; i++) await rejects(breaker.run(async () => { throw networkError(); }));
  advance(30_000);
  const err = await rejects(breaker.run(async () => { throw new BadRequestError('bad input'); }));
  ok(err instanceof BadRequestError, 'the answer is surfaced unchanged');
  strictEqual(breaker.state, 'closed');
});

await test('times out, aborts the signal and counts the timeout as a failure', async () => {
  const { breaker } = makeBreaker({ timeout: 30, volumeThreshold: 1 });
  let signal!: AbortSignal;
  const started = Date.now();
  const err = await rejects(breaker.run((s) => { signal = s; return new Promise(() => {}); }));
  ok(err instanceof UpstreamTimeoutError);
  strictEqual(err.httpStatus, 504);
  strictEqual(err.code, 'TEST_TIMEOUT');
  ok(signal.aborted, 'the signal was aborted so fetch can cancel');
  ok(Date.now() - started < 1000, 'it did not wait for the upstream');
  strictEqual(breaker.metrics.timeouts, 1);
  strictEqual(breaker.state, 'open');
});

await test('retries transient failures only when asked, with capped backoff', async () => {
  const { breaker, sleeps } = makeBreaker({ volumeThreshold: 100 });
  let calls = 0;
  const result = await breaker.run(async () => {
    calls++;
    if (calls < 3) throw networkError();
    return 'ok';
  }, { retry: true });
  strictEqual(result, 'ok');
  strictEqual(calls, 3);
  strictEqual(breaker.metrics.retries, 2);
  // base 100, ×2 per attempt, jitter in the upper half (random = 0.5 → 75%).
  strictEqual(sleeps.join(','), '75,150');

  let once = 0;
  await rejects(breaker.run(async () => { once++; throw networkError(); }));
  strictEqual(once, 1, 'without retry: a single attempt');
});

await test('gives up after maxRetries and surfaces the last error', async () => {
  const { breaker } = makeBreaker({ volumeThreshold: 100, maxRetries: 2 });
  let calls = 0;
  const err = await rejects(breaker.run(async () => { calls++; throw networkError(); }, { retry: true }));
  ok(err instanceof TypeError);
  strictEqual(calls, 3);
});

await test('never retries or counts an answer that is not a failure of the upstream', async () => {
  const { breaker } = makeBreaker({ volumeThreshold: 1 });
  let calls = 0;
  await rejects(breaker.run(async () => { calls++; throw new Error('Simulation failed: contract panicked'); }, { retry: true }));
  strictEqual(calls, 1);
  strictEqual(breaker.state, 'closed');
  strictEqual(breaker.metrics.failures, 0);
});

await test('classifies transient errors', async () => {
  ok(isTransientError(networkError()));
  ok(isTransientError({ code: 'ETIMEDOUT' }));
  ok(isTransientError({ code: 'ERR_NETWORK' }), 'axios network error (Stellar SDK)');
  ok(isTransientError({ response: { status: 503 } }));
  ok(isTransientError({ response: { status: 429 } }));
  ok(!isTransientError({ response: { status: 404 } }));
  ok(!isTransientError(new Error('Simulation failed')));
  ok(!isTransientError(new BadRequestError('nope')));
  ok(!isTransientError(undefined));
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
