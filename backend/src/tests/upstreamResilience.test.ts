/**
 * F1 wiring: Didit, Etherfuse and Stellar RPC go through their breakers with
 * the money rules intact:
 *   - POSTs (Didit session, Etherfuse quote/order) are never retried.
 *   - Etherfuse reads are retried on 5xx and recover.
 *   - An uncertain Stellar submission is looked up by hash before resending,
 *     and a resend is the same signed envelope.
 *   - An open circuit rejects without calling the upstream.
 *
 * fetch and the RPC server are stubbed; no network access.
 */

import { ok, strictEqual } from 'assert';
import { CircuitBreaker, CircuitOpenError } from '../lib/circuitBreaker.js';
import { setBreakersForTests, UPSTREAM_LABELS } from '../lib/breakers.js';
import {
  setRpcServerFactoryForTests,
  submitSignedTx,
  StellarSubmitUncertainError,
  type RpcServerLike,
} from '../lib/stellarRpc.js';
import { createDiditSession } from '../services/didit.service.js';
import { getCETESRate, createQuote } from '../services/etherfuse.service.js';

process.env.DIDIT_API_KEY = 'test-key';
process.env.DIDIT_WORKFLOW_ID = 'wf';
process.env.ETHERFUSE_API_KEY = 'test-key';

function fastBreaker(name: keyof typeof UPSTREAM_LABELS) {
  return new CircuitBreaker(name, {
    timeout: 1000,
    errorThresholdPercentage: 50,
    volumeThreshold: 5,
    resetTimeout: 60_000,
    rollingCountTimeout: 10_000,
    maxRetries: 2,
    baseDelayMs: 1,
    maxDelayMs: 2,
  }, UPSTREAM_LABELS[name]);
}

function freshBreakers() {
  setBreakersForTests({
    didit: fastBreaker('didit'),
    etherfuse: fastBreaker('etherfuse'),
    stellarRpc: fastBreaker('stellarRpc'),
  });
}

const realFetch = globalThis.fetch;
function stubFetch(responses: Array<() => Response | Promise<Response>>) {
  const calls: { url: string; method: string }[] = [];
  globalThis.fetch = (async (url: any, init: any = {}) => {
    calls.push({ url: String(url), method: init.method ?? 'GET' });
    const next = responses.shift();
    if (!next) throw new Error('unexpected extra fetch');
    return next();
  }) as typeof fetch;
  return calls;
}

const json = (status: number, body: unknown) => () =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const netFail = () => () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } }); };

const HASH = 'ab'.repeat(32);
const signedTx = { hash: () => Buffer.from(HASH, 'hex') };

function stubRpc(opts: {
  send: Array<() => any>;
  lookup?: Array<() => any>;
}) {
  const sent: unknown[] = [];
  const lookedUp: string[] = [];
  const server: Partial<RpcServerLike> = {
    sendTransaction: async (tx: unknown) => {
      sent.push(tx);
      const next = opts.send.shift();
      if (!next) throw new Error('unexpected extra send');
      return next();
    },
    getTransaction: async (hash: string) => {
      lookedUp.push(hash);
      const next = opts.lookup?.shift();
      if (!next) throw new Error('unexpected extra lookup');
      return next();
    },
  };
  setRpcServerFactoryForTests(async () => server as RpcServerLike);
  return { sent, lookedUp };
}

const rpcNetFail = () => { throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }); };

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
  freshBreakers();
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    console.error(`  ✗ ${name}\n    ${(err as Error).stack}`);
  } finally {
    globalThis.fetch = realFetch;
    setRpcServerFactoryForTests(null);
  }
}

console.log('Didit');

await test('a lost response on session creation is not retried', async () => {
  const calls = stubFetch([netFail()]);
  await rejects(createDiditSession({ vendorData: 'u:1' }));
  strictEqual(calls.length, 1, 'one POST only: no second session behind the user');
  strictEqual(calls[0].method, 'POST');
});

await test('a 5xx on session creation is not retried and keeps its error', async () => {
  const calls = stubFetch([json(502, { error: 'bad gateway' })]);
  const err = await rejects(createDiditSession({ vendorData: 'u:1' }));
  ok(/Didit API error: 502/.test(err.message));
  strictEqual(calls.length, 1);
});

await test('after repeated outages the circuit opens and Didit is not called', async () => {
  stubFetch([netFail(), netFail(), netFail(), netFail(), netFail()]);
  for (let i = 0; i < 5; i++) await rejects(createDiditSession({ vendorData: 'u:1' }));
  const calls = stubFetch([json(201, { session_id: 's', url: 'u' })]);
  const err = await rejects(createDiditSession({ vendorData: 'u:1' }));
  ok(err instanceof CircuitOpenError);
  strictEqual(err.code, 'DIDIT_UNAVAILABLE');
  strictEqual(calls.length, 0);
});

console.log('Etherfuse');

await test('a rate read recovers after transient 5xx', async () => {
  const calls = stubFetch([
    json(503, {}),
    json(503, {}),
    json(200, { bond_symbol: 'CETES', current_basis_points: 1000 }),
  ]);
  const rate = await getCETESRate();
  strictEqual((rate as any).bond_symbol, 'CETES');
  strictEqual(calls.length, 3);
});

await test('a quote (POST) is not retried on 5xx', async () => {
  const calls = stubFetch([json(503, {})]);
  await rejects(createQuote({} as any));
  strictEqual(calls.length, 1);
  strictEqual(calls[0].method, 'POST');
});

await test('a 4xx answer is not retried and does not count against the circuit', async () => {
  const calls = stubFetch(Array.from({ length: 6 }, () => json(404, {})));
  for (let i = 0; i < 6; i++) await rejects(getCETESRate());
  strictEqual(calls.length, 6, 'one call per request, all reached Etherfuse');
});

console.log('Stellar submission');

await test('uncertain send found on-chain by hash: no resend', async () => {
  const { sent, lookedUp } = stubRpc({ send: [rpcNetFail], lookup: [() => ({ status: 'SUCCESS' })] });
  const res = await submitSignedTx('rpc', signedTx);
  strictEqual(res.status, 'PENDING');
  strictEqual(res.hash, HASH);
  strictEqual(sent.length, 1);
  strictEqual(lookedUp[0], HASH);
});

await test('uncertain send not found: resends the same signed envelope', async () => {
  const { sent } = stubRpc({
    send: [rpcNetFail, () => ({ status: 'DUPLICATE', hash: HASH })],
    lookup: [() => ({ status: 'NOT_FOUND' })],
  });
  const res = await submitSignedTx('rpc', signedTx);
  strictEqual(res.status, 'DUPLICATE');
  strictEqual(sent.length, 2);
  strictEqual(sent[0], sent[1], 'identical envelope, so it cannot apply twice');
});

await test('uncertain send that cannot be looked up is reported as uncertain, not retried', async () => {
  const { sent } = stubRpc({ send: [rpcNetFail], lookup: [rpcNetFail, rpcNetFail, rpcNetFail] });
  const err = await rejects(submitSignedTx('rpc', signedTx));
  ok(err instanceof StellarSubmitUncertainError);
  strictEqual(err.httpStatus, 504);
  strictEqual(sent.length, 1);
});

await test('a rejection after an uncertain send is checked by hash before failing', async () => {
  const { sent } = stubRpc({
    send: [rpcNetFail, () => ({ status: 'ERROR', hash: HASH, errorResult: 'txBadSeq' })],
    lookup: [() => ({ status: 'NOT_FOUND' }), () => ({ status: 'SUCCESS' })],
  });
  const res = await submitSignedTx('rpc', signedTx);
  strictEqual(res.status, 'PENDING', 'the first attempt had landed');
  strictEqual(sent.length, 2);
});

await test('a plain rejection is returned unchanged for the caller to handle', async () => {
  const { sent, lookedUp } = stubRpc({ send: [() => ({ status: 'ERROR', hash: HASH, errorResult: 'txFailed' })] });
  const res = await submitSignedTx('rpc', signedTx);
  strictEqual(res.status, 'ERROR');
  strictEqual(sent.length, 1);
  strictEqual(lookedUp.length, 0);
});

await test('TRY_AGAIN_LATER resends the same envelope', async () => {
  const { sent } = stubRpc({
    send: [() => ({ status: 'TRY_AGAIN_LATER', hash: HASH }), () => ({ status: 'PENDING', hash: HASH })],
  });
  const res = await submitSignedTx('rpc', signedTx);
  strictEqual(res.status, 'PENDING');
  strictEqual(sent.length, 2);
  strictEqual(sent[0], sent[1]);
});

await test('an open circuit rejects the submission without sending', async () => {
  const breaker = fastBreaker('stellarRpc');
  for (let i = 0; i < 5; i++) await rejects(breaker.run(async () => { throw rpcNetFail(); }));
  setBreakersForTests({ stellarRpc: breaker });
  const { sent } = stubRpc({ send: [() => ({ status: 'PENDING', hash: HASH })] });
  const err = await rejects(submitSignedTx('rpc', signedTx));
  ok(err instanceof CircuitOpenError);
  strictEqual(err.code, 'STELLAR_UNAVAILABLE');
  strictEqual(sent.length, 0);
});

setBreakersForTests(null);
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
