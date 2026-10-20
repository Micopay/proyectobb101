import Fastify from 'fastify';
import fastifyJwt from '@fastify/jwt';
import { strictEqual, ok, deepStrictEqual } from 'node:assert';
import { config } from '../config.js';
import db from '../db/schema.js';
import { issueDeviceKey } from '../utils/issueDeviceKey.js';
import { signRequestsRoutes } from '../routes/sign-requests.js';
import { randomUUID } from 'node:crypto';

async function createApp() {
  const app = Fastify({ logger: false });
  await app.register(fastifyJwt, { secret: config.jwtSecret || 'test_jwt_secret' });
  await app.register(signRequestsRoutes, { prefix: '' });
  await app.ready();
  return app;
}

function makeWalletToken(app: any, payload: { id: string; stellar_address: string }) {
  return app.jwt.sign(payload, { expiresIn: '1h' });
}

async function runTests() {
  console.log('Running Delegated Sign Requests Tests [SIGN-01]...\n');

  // Setup test user in database
  const userId = randomUUID();
  const stellarAddress = 'G' + 'A'.repeat(55);
  await db.execute(
    `INSERT INTO users (id, username, stellar_address) VALUES ($1, $2, $3)`,
    [userId, 'coffee_tester', stellarAddress]
  );

  // Issue valid device key for Coffee Payments
  const deviceKeyInfo = await issueDeviceKey('Coffee Payments POS Test');
  const validDeviceToken = deviceKeyInfo.token;

  const app = await createApp();
  const walletJwt = makeWalletToken(app, { id: userId, stellar_address: stellarAddress });

  try {
    // ── 1. Creation without auth header returns 401 ─────────────────────────
    console.log('1. Unauthenticated device request is rejected (401)');
    const res1 = await app.inject({
      method: 'POST',
      url: '/sign-requests',
      payload: { txxdr: 'AAAAAG...' },
    });
    strictEqual(res1.statusCode, 401, 'Unauthenticated request must return 401');
    console.log('   ✓ 401 Unauthorized\n');

    // ── 2. Creation with invalid device token returns 401 ───────────────────
    console.log('2. Invalid device token is rejected (401)');
    const res2 = await app.inject({
      method: 'POST',
      url: '/sign-requests',
      headers: { authorization: 'Bearer mp_dev_invalid_token_12345' },
      payload: { txxdr: 'AAAAAG...' },
    });
    strictEqual(res2.statusCode, 401, 'Invalid device token must return 401');
    console.log('   ✓ 401 Unauthorized\n');

    // ── 3. Valid device token creates sign request ─────────────────────────
    console.log('3. Valid device token creates sign request (200)');
    const res3 = await app.inject({
      method: 'POST',
      url: '/sign-requests',
      headers: { authorization: `Bearer ${validDeviceToken}` },
      payload: {
        txxdr: 'AAAAAGTestTxXDRBase64Payload==',
        identifier: stellarAddress,
        instruction: 'Pagar $50 MXN en Café Allende',
        kind: 'payment',
        expire_minutes: 5,
      },
    });
    strictEqual(res3.statusCode, 200, 'Valid creation request must return 200');
    const body3 = JSON.parse(res3.payload);
    ok(body3.id, 'Response must include request ID');
    ok(body3.qr, 'Response must include QR payload');
    ok(body3.deeplink, 'Response must include deeplink');
    strictEqual(typeof body3.pushed, 'boolean', 'Response must include pushed boolean');
    const requestId = body3.id;
    console.log(`   ✓ 200 OK (id: ${requestId})\n`);

    // ── 4. Polling pending request shape (Xaman byte-identical) ────────────
    console.log('4. GET /sign-requests/:id returns pending status (Xaman response shape)');
    const res4 = await app.inject({
      method: 'GET',
      url: `/sign-requests/${requestId}`,
      headers: { authorization: `Bearer ${validDeviceToken}` },
    });
    strictEqual(res4.statusCode, 200, 'Polling pending request must return 200');
    const body4 = JSON.parse(res4.payload);
    deepStrictEqual(
      body4,
      {
        resolved: false,
        signed: false,
        cancelled: false,
        expired: false,
        txid: null,
        account: null,
      },
      'Pending response shape must be byte-identical in key names to Xaman payload API'
    );
    console.log('   ✓ Xaman byte-identical pending payload verified\n');

    // ── 5. Resolving sign request by wallet user ───────────────────────────
    console.log('5. Wallet user resolves sign request (POST /sign-requests/:id/resolve)');
    const res5 = await app.inject({
      method: 'POST',
      url: `/sign-requests/${requestId}/resolve`,
      headers: { authorization: `Bearer ${walletJwt}` },
      payload: {
        signed_xdr: 'AAAAAGSignedTxXDRBase64Payload==',
      },
    });
    strictEqual(res5.statusCode, 200, 'Resolving sign request must return 200');
    const body5 = JSON.parse(res5.payload);
    strictEqual(body5.success, true);
    strictEqual(body5.status, 'signed');
    ok(body5.txid, 'Response must include txid');
    console.log('   ✓ 200 OK (signed)\n');

    // ── 6. Polling signed request returns resolved state ────────────────────
    console.log('6. GET /sign-requests/:id returns signed status payload');
    const res6 = await app.inject({
      method: 'GET',
      url: `/sign-requests/${requestId}`,
      headers: { authorization: `Bearer ${validDeviceToken}` },
    });
    strictEqual(res6.statusCode, 200);
    const body6 = JSON.parse(res6.payload);
    strictEqual(body6.resolved, true);
    strictEqual(body6.signed, true);
    strictEqual(body6.cancelled, false);
    strictEqual(body6.expired, false);
    ok(body6.txid, 'txid must be present on signed payload');
    console.log('   ✓ Xaman byte-identical signed payload verified\n');

    // ── 7. Polling non-existent request returns 404 ─────────────────────────
    console.log('7. GET /sign-requests/:id with unknown ID returns 404');
    const fakeId = randomUUID();
    const res7 = await app.inject({
      method: 'GET',
      url: `/sign-requests/${fakeId}`,
      headers: { authorization: `Bearer ${validDeviceToken}` },
    });
    strictEqual(res7.statusCode, 404, 'Unknown request ID must return 404');
    console.log('   ✓ 404 Not Found\n');

    // ── 8. Expired sign request returns expired status ─────────────────────
    console.log('8. Expired request returns resolved: true, expired: true');
    const expiredId = randomUUID();
    const pastDate = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    await db.execute(
      `INSERT INTO sign_requests
         (id, device_id, txxdr, identifier, instruction, kind, status, pushed, expires_at, created_at)
       VALUES ($1, $2, $3, null, null, 'transaction', 'pending', false, $4, NOW())`,
      [expiredId, deviceKeyInfo.id, 'AAAAAGExpired...', pastDate]
    );

    const res8 = await app.inject({
      method: 'GET',
      url: `/sign-requests/${expiredId}`,
      headers: { authorization: `Bearer ${validDeviceToken}` },
    });
    strictEqual(res8.statusCode, 200);
    const body8 = JSON.parse(res8.payload);
    deepStrictEqual(body8, {
      resolved: true,
      signed: false,
      cancelled: false,
      expired: true,
      txid: null,
      account: null,
    });
    console.log('   ✓ Expired status verified\n');

    console.log('🎉 All Delegated Sign Request Tests Passed Successfully!\n');
  } finally {
    await app.close();
  }
}

runTests().catch((err) => {
  console.error('❌ Sign Request Tests Failed:', err);
  process.exit(1);
});
