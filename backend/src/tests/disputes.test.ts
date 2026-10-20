import Fastify from 'fastify';
import fastifyJwt from '@fastify/jwt';
import { strictEqual, ok } from 'assert';
import db from '../db/schema.js';
import { config } from '../config.js';
import { authRoutes } from '../routes/auth.js';
import { tradeRoutes } from '../routes/trades.js';
import { tradeSafetyRoutes } from '../routes/trade-safety.js';
import { adminRoutes } from '../routes/admin.js';
import { AppError } from '../utils/errors.js';

async function buildTestApp() {
  const app = Fastify({ logger: false });

  app.register(fastifyJwt, { secret: config.jwtSecret });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof AppError) {
      reply.status(error.httpStatus).send({ code: error.code, message: error.userMessage });
      return;
    }
    reply.status(500).send({ code: 'INTERNAL_ERROR', message: error.message });
  });

  app.register(authRoutes);
  app.register(tradeRoutes);
  app.register(tradeSafetyRoutes);
  app.register(adminRoutes);

  await app.ready();
  return app;
}

async function runDisputeTests() {
  console.log('🧪 Starting Dispute Resolution Tests...');
  const app = await buildTestApp();

  // 1. Seed test users
  const buyer = await db.getOne<{ id: string }>(
    `INSERT INTO users (username, stellar_address, is_admin) VALUES ('dispute_buyer', 'GBUYERDISPUTETEST1234567890123456789012345678901234567890', false) RETURNING id`,
  );
  const seller = await db.getOne<{ id: string }>(
    `INSERT INTO users (username, stellar_address, is_admin) VALUES ('dispute_seller', 'GSELLERDISPUTETEST1234567890123456789012345678901234567890', false) RETURNING id`,
  );
  const thirdParty = await db.getOne<{ id: string }>(
    `INSERT INTO users (username, stellar_address, is_admin) VALUES ('dispute_other', 'GOTHERDISPUTETEST1234567890123456789012345678901234567890', false) RETURNING id`,
  );
  const admin = await db.getOne<{ id: string }>(
    `INSERT INTO users (username, stellar_address, is_admin) VALUES ('dispute_admin', 'GADMINDISPUTETEST1234567890123456789012345678901234567890', true) RETURNING id`,
  );

  ok(buyer && seller && thirdParty && admin, 'Users created');

  const buyerToken = app.jwt.sign({ id: buyer.id, stellar_address: 'GBUYER...' });
  const sellerToken = app.jwt.sign({ id: seller.id, stellar_address: 'GSELLER...' });
  const thirdPartyToken = app.jwt.sign({ id: thirdParty.id, stellar_address: 'GOTHER...' });
  const adminToken = app.jwt.sign({ id: admin.id, stellar_address: 'GADMIN...', is_admin: true });

  // 2. Create test trades
  const trade1 = await db.getOne<{ id: string }>(
    `INSERT INTO trades (seller_id, buyer_id, flow, provider_id, amount_mxn, amount_stroops, platform_fee_mxn, secret_hash, status, expires_at)
     VALUES ($1, $2, 'deposit', $3, 1000, 10000000000, 8, 'hash_test_1', 'locked', NOW() + INTERVAL '1 hour')
     RETURNING id`,
    [seller.id, buyer.id, seller.id],
  );

  const trade2 = await db.getOne<{ id: string }>(
    `INSERT INTO trades (seller_id, buyer_id, flow, provider_id, amount_mxn, amount_stroops, platform_fee_mxn, secret_hash, status, expires_at)
     VALUES ($1, $2, 'deposit', $3, 500, 5000000000, 4, 'hash_test_2', 'revealing', NOW() + INTERVAL '1 hour')
     RETURNING id`,
    [seller.id, buyer.id, seller.id],
  );

  const trade3 = await db.getOne<{ id: string }>(
    `INSERT INTO trades (seller_id, buyer_id, flow, provider_id, amount_mxn, amount_stroops, platform_fee_mxn, secret_hash, status, expires_at)
     VALUES ($1, $2, 'deposit', $3, 2000, 20000000000, 16, 'hash_test_3', 'locked', NOW() + INTERVAL '1 hour')
     RETURNING id`,
    [seller.id, buyer.id, seller.id],
  );

  ok(trade1 && trade2 && trade3, 'Test trades created');

  // --- TEST A: Open Dispute (POST /trades/:id/dispute) ---
  console.log('Testing dispute creation...');

  // Third party cannot dispute
  const resForbidden = await app.inject({
    method: 'POST',
    url: `/trades/${trade1.id}/dispute`,
    headers: { authorization: `Bearer ${thirdPartyToken}` },
    payload: { reason: 'I want to dispute' },
  });
  strictEqual(resForbidden.statusCode, 403, 'Non-participant forbidden from disputing');

  // Buyer disputes trade1
  const resDispute1 = await app.inject({
    method: 'POST',
    url: `/trades/${trade1.id}/dispute`,
    headers: { authorization: `Bearer ${buyerToken}` },
    payload: {
      reason: 'Merchant did not provide cash',
      evidence_urls: ['https://storage.micopay.app/evidence/pic1.png'],
    },
  });
  strictEqual(resDispute1.statusCode, 201, 'Dispute created successfully');
  const dispute1Data = resDispute1.json();
  ok(dispute1Data.dispute, 'Dispute returned');
  strictEqual(dispute1Data.dispute.status, 'open');
  strictEqual(dispute1Data.dispute.reported_by, buyer.id);

  // Check trade1 status updated to 'disputed'
  const updatedTrade1 = await db.getOne<{ status: string }>('SELECT status FROM trades WHERE id = $1', [trade1.id]);
  strictEqual(updatedTrade1?.status, 'disputed', 'Trade status updated to disputed');

  // Seller disputes trade2
  const resDispute2 = await app.inject({
    method: 'POST',
    url: `/trades/${trade2.id}/dispute`,
    headers: { authorization: `Bearer ${sellerToken}` },
    payload: {
      reason: 'Buyer gave fake money',
      evidence_urls: ['https://storage.micopay.app/evidence/pic2.png'],
    },
  });
  strictEqual(resDispute2.statusCode, 201, 'Dispute 2 created');
  const dispute2Data = resDispute2.json();

  // Buyer disputes trade3
  const resDispute3 = await app.inject({
    method: 'POST',
    url: `/trades/${trade3.id}/dispute`,
    headers: { authorization: `Bearer ${buyerToken}` },
    payload: { reason: 'Unresponsive merchant' },
  });
  strictEqual(resDispute3.statusCode, 201, 'Dispute 3 created');
  const dispute3Data = resDispute3.json();

  console.log('✅ Dispute creation tests passed.');

  // --- TEST B: List Admin Disputes (GET /admin/disputes) ---
  console.log('Testing GET /admin/disputes...');

  // Non-admin forbidden
  const resAdminForbidden = await app.inject({
    method: 'GET',
    url: '/admin/disputes',
    headers: { authorization: `Bearer ${buyerToken}` },
  });
  ok([401, 403].includes(resAdminForbidden.statusCode), 'Non-admin blocked from GET /admin/disputes');

  // Admin lists open disputes
  const resAdminList = await app.inject({
    method: 'GET',
    url: '/admin/disputes?status=open',
    headers: { authorization: `Bearer ${adminToken}` },
  });
  strictEqual(resAdminList.statusCode, 200, 'Admin can list disputes');
  const listData = resAdminList.json();
  ok(Array.isArray(listData.disputes), 'Disputes array returned');
  ok(listData.disputes.length >= 3, 'Open disputes returned');

  const item1 = listData.disputes.find((d: any) => d.id === dispute1Data.dispute.id);
  ok(item1, 'Dispute 1 present in admin list');
  ok(item1.trade, 'Trade context included');
  strictEqual(item1.trade.amount_mxn, 1000);
  ok(item1.parties.buyer && item1.parties.seller, 'Buyer and seller parties included');
  strictEqual(item1.parties.buyer.id, buyer.id);
  strictEqual(item1.parties.seller.id, seller.id);
  ok(Array.isArray(item1.evidence_and_messages.audit_trail), 'Audit trail included');
  ok(item1.evidence_urls.includes('https://storage.micopay.app/evidence/pic1.png'), 'Evidence URLs present');

  console.log('✅ GET /admin/disputes tests passed.');

  // --- TEST C: Resolve Dispute - Refund Buyer (POST /admin/disputes/:id/resolve) ---
  console.log('Testing resolution: refund_buyer...');

  const resResolve1 = await app.inject({
    method: 'POST',
    url: `/admin/disputes/${dispute1Data.dispute.id}/resolve`,
    headers: { authorization: `Bearer ${adminToken}` },
    payload: {
      resolution: 'refund_buyer',
      note: 'Buyer verified evidence of no cash handoff',
    },
  });
  strictEqual(resResolve1.statusCode, 200, 'Resolution 1 successful');
  const resolve1Data = resResolve1.json();
  strictEqual(resolve1Data.dispute.status, 'resolved');
  strictEqual(resolve1Data.dispute.resolution, 'refund_buyer');
  strictEqual(resolve1Data.trade.status, 'refunded');

  // Verify audit log entry
  const auditLogs1 = await db.getMany('SELECT * FROM audit_log WHERE entity_id = $1 OR trade_id = $2', [
    dispute1Data.dispute.id,
    trade1.id,
  ]);
  ok(auditLogs1.length > 0, 'Audit log entries recorded');

  // Re-resolving should fail with Conflict
  const resReResolve = await app.inject({
    method: 'POST',
    url: `/admin/disputes/${dispute1Data.dispute.id}/resolve`,
    headers: { authorization: `Bearer ${adminToken}` },
    payload: { resolution: 'release_seller' },
  });
  strictEqual(resReResolve.statusCode, 409, 'Cannot re-resolve an already resolved dispute');

  console.log('✅ Refund buyer resolution tests passed.');

  // --- TEST D: Resolve Dispute - Release to Seller ---
  console.log('Testing resolution: release_seller...');

  const resResolve2 = await app.inject({
    method: 'POST',
    url: `/admin/disputes/${dispute2Data.dispute.id}/resolve`,
    headers: { authorization: `Bearer ${adminToken}` },
    payload: {
      resolution: 'release_seller',
      note: 'Seller demonstrated completed handoff',
    },
  });
  strictEqual(resResolve2.statusCode, 200, 'Resolution 2 successful');
  const resolve2Data = resResolve2.json();
  strictEqual(resolve2Data.dispute.status, 'resolved');
  strictEqual(resolve2Data.dispute.resolution, 'release_seller');
  strictEqual(resolve2Data.trade.status, 'completed');

  console.log('✅ Release seller resolution tests passed.');

  // --- TEST E: Resolve Dispute - Ban Party ---
  console.log('Testing resolution: ban_party (ban seller)...');

  const resResolve3 = await app.inject({
    method: 'POST',
    url: `/admin/disputes/${dispute3Data.dispute.id}/resolve`,
    headers: { authorization: `Bearer ${adminToken}` },
    payload: {
      resolution: 'ban_party',
      ban_target: 'seller',
      note: 'Banning fraudulent merchant',
    },
  });
  strictEqual(resResolve3.statusCode, 200, 'Resolution 3 successful');
  const resolve3Data = resResolve3.json();
  strictEqual(resolve3Data.banned_user_id, seller.id, 'Seller banned');
  strictEqual(resolve3Data.trade.status, 'refunded', 'Buyer refunded when seller banned');

  // Verify seller is now banned in DB
  const sellerDb = await db.getOne<{ is_banned: boolean }>('SELECT is_banned FROM users WHERE id = $1', [seller.id]);
  strictEqual(sellerDb?.is_banned, true, 'Seller is_banned flag set');

  // Banned seller cannot make authenticated requests
  const resBannedReq = await app.inject({
    method: 'GET',
    url: '/trades/active',
    headers: { authorization: `Bearer ${sellerToken}` },
  });
  strictEqual(resBannedReq.statusCode, 403, 'Banned seller blocked by auth middleware');

  console.log('✅ Ban party resolution tests passed.');

  console.log('🎉 All Dispute Resolution Tests Passed Successfully!');
}

runDisputeTests().catch((err) => {
  console.error('❌ Dispute tests failed:', err);
  process.exit(1);
});
