/**
 * JWT Revocation Tests — #213
 *
 * Tests the tokenRevocation service and the auth middleware integration.
 * Runs in-process without a real DB: the service falls back to in-memory.
 */

import Fastify from 'fastify';
import fastifyJwt from '@fastify/jwt';
import { strictEqual, ok } from 'node:assert';
import { revokeToken, isRevoked, _resetMemBlacklist } from '../services/tokenRevocation.service.js';

const JWT_SECRET = 'test_jwt_secret_revocation';

async function createApp() {
  const app = Fastify({ logger: false });
  app.register(fastifyJwt, { secret: JWT_SECRET });

  // Minimal auth-protected route
  app.get('/protected', async (request, reply) => {
    try {
      await request.jwtVerify();
      const { jti } = request.user as { id: string; jti?: string };
      if (jti && await isRevoked(jti)) {
        return reply.status(401).send({ error: 'Token has been revoked' });
      }
      return { ok: true };
    } catch {
      return reply.status(401).send({ error: 'Unauthorized' });
    }
  });

  await app.ready();
  return app;
}

function makeToken(app: ReturnType<typeof Fastify>, payload: object, expiresSecs = 3600) {
  return (app as any).jwt.sign(payload, { expiresIn: expiresSecs });
}

async function runTests() {
  console.log('Running JWT Revocation Tests...\n');

  // ── 1. Valid JWT succeeds ────────────────────────────────────────────────
  console.log('1. Valid JWT succeeds');
  _resetMemBlacklist();
  const app1 = await createApp();
  const jti1 = 'jti-valid-1';
  const token1 = makeToken(app1, { id: 'user-1', stellar_address: 'G...', jti: jti1 });
  const res1 = await app1.inject({ method: 'GET', url: '/protected', headers: { authorization: `Bearer ${token1}` } });
  strictEqual(res1.statusCode, 200, 'Valid token must return 200');
  console.log('   ✓ 200 OK\n');
  await app1.close();

  // ── 2. Revoked JWT is rejected ──────────────────────────────────────────
  console.log('2. Revoked JWT is rejected');
  _resetMemBlacklist();
  const app2 = await createApp();
  const jti2 = 'jti-revoked-1';
  const token2 = makeToken(app2, { id: 'user-2', stellar_address: 'G...', jti: jti2 });
  const expiry2 = new Date(Date.now() + 3600 * 1000);
  await revokeToken(jti2, 'user-2', expiry2);
  const res2 = await app2.inject({ method: 'GET', url: '/protected', headers: { authorization: `Bearer ${token2}` } });
  strictEqual(res2.statusCode, 401, 'Revoked token must return 401');
  console.log('   ✓ 401 Unauthorized\n');
  await app2.close();

  // ── 3. Logout revokes the current JWT ───────────────────────────────────
  console.log('3. Logout revokes the current JWT');
  _resetMemBlacklist();
  const jti3 = 'jti-logout-1';
  const expiry3 = new Date(Date.now() + 3600 * 1000);
  const revoked3Before = await isRevoked(jti3);
  strictEqual(revoked3Before, false, 'Token not revoked before logout');
  await revokeToken(jti3, 'user-3', expiry3);
  const revoked3After = await isRevoked(jti3);
  strictEqual(revoked3After, true, 'Token revoked after logout call');
  console.log('   ✓ isRevoked transitions false → true after revokeToken\n');

  // ── 4. Reusing a revoked token fails ────────────────────────────────────
  console.log('4. Reusing a revoked token fails on every subsequent request');
  _resetMemBlacklist();
  const app4 = await createApp();
  const jti4 = 'jti-reuse-1';
  const token4 = makeToken(app4, { id: 'user-4', stellar_address: 'G...', jti: jti4 });
  const expiry4 = new Date(Date.now() + 3600 * 1000);

  // First request — should succeed
  const first4 = await app4.inject({ method: 'GET', url: '/protected', headers: { authorization: `Bearer ${token4}` } });
  strictEqual(first4.statusCode, 200, 'First use must succeed');

  // Revoke
  await revokeToken(jti4, 'user-4', expiry4);

  // Retry 1
  const retry4a = await app4.inject({ method: 'GET', url: '/protected', headers: { authorization: `Bearer ${token4}` } });
  strictEqual(retry4a.statusCode, 401, 'Reuse after revocation must fail');

  // Retry 2 — same token again
  const retry4b = await app4.inject({ method: 'GET', url: '/protected', headers: { authorization: `Bearer ${token4}` } });
  strictEqual(retry4b.statusCode, 401, 'Second reuse must also fail');
  console.log('   ✓ 200 → revoke → 401 → 401\n');
  await app4.close();

  // ── 5. Expired tokens continue to be rejected by jwtVerify ──────────────
  console.log('5. Expired token is rejected (independent of revocation)');
  _resetMemBlacklist();
  const app5 = await createApp();
  // Sign with 1-second expiry, then advance time
  const jti5 = 'jti-expired-1';
  const token5 = makeToken(app5, { id: 'user-5', stellar_address: 'G...', jti: jti5 }, 1);

  // Wait for expiry
  await new Promise(resolve => setTimeout(resolve, 1100));

  const res5 = await app5.inject({ method: 'GET', url: '/protected', headers: { authorization: `Bearer ${token5}` } });
  strictEqual(res5.statusCode, 401, 'Expired token must be rejected');
  console.log('   ✓ 401 for expired token\n');
  await app5.close();

  // ── 6. Multiple logout calls do not break behavior ───────────────────────
  console.log('6. Multiple logout calls (duplicate revokeToken) do not throw');
  _resetMemBlacklist();
  const jti6 = 'jti-multi-logout-1';
  const expiry6 = new Date(Date.now() + 3600 * 1000);
  await revokeToken(jti6, 'user-6', expiry6);
  await revokeToken(jti6, 'user-6', expiry6); // second call — must not throw
  await revokeToken(jti6, 'user-6', expiry6); // third call
  const revoked6 = await isRevoked(jti6);
  strictEqual(revoked6, true, 'Token still revoked after duplicate calls');
  console.log('   ✓ No error; token remains revoked\n');

  // ── 7. Non-JTI tokens (legacy) still pass without revocation check ───────
  console.log('7. Token without JTI field is not falsely rejected');
  _resetMemBlacklist();
  const app7 = await createApp();
  // Omit jti from payload (legacy token shape)
  const token7 = makeToken(app7, { id: 'user-7', stellar_address: 'G...' });
  const res7 = await app7.inject({ method: 'GET', url: '/protected', headers: { authorization: `Bearer ${token7}` } });
  // The protected route only calls isRevoked when jti is present, so this should succeed
  strictEqual(res7.statusCode, 200, 'Token without JTI must not be falsely revoked');
  console.log('   ✓ 200 OK (no JTI → no revocation check)\n');
  await app7.close();

  console.log('✅ All JWT Revocation Tests Passed!');
}

runTests().catch(err => {
  console.error('❌ Tests failed:', err);
  process.exit(1);
});
