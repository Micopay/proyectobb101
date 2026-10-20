import { deleteAccount } from '../services/account.service.js';
import db from '../db/schema.js';
import { ok, strictEqual, equal } from 'assert';

async function testAccountDeletion() {
  console.log('🚀 Running Account Deletion & PII Minimization Tests...');

  // 1. Setup mock data
  const userId = '11111111-1111-1111-1111-111111111111';
  const buyerId = '22222222-2222-2222-2222-222222222222';
  const username = 'test_user_pii';
  const stellarAddress = 'GB2GP47X7347TNYUXRREQA345GHTYNREQA345GHTYNREQA345GHTYPII';
  const phoneHash = 'mock_phone_hash_value_1234567890abcdef';

  console.log('   Creating mock user and associated data...');
  
  // Clear any potential leftover test data (using our new in-memory/postgres DELETE support!)
  await db.execute("DELETE FROM users WHERE id = $1 OR id = $2", [userId, buyerId]);
  await db.execute("DELETE FROM wallets WHERE user_id = $1", [userId]);
  await db.execute("DELETE FROM user_devices WHERE user_id = $1", [userId]);
  await db.execute("DELETE FROM trade_messages WHERE sender_id = $1", [userId]);
  await db.execute("DELETE FROM trade_disputes WHERE opener_id = $1", [userId]);

  // Insert test users
  await db.execute(
    `INSERT INTO users (id, stellar_address, username, phone_hash, merchant_available)
     VALUES ($1, $2, $3, $4, $5)`,
    [userId, stellarAddress, username, phoneHash, true]
  );
  await db.execute(
    `INSERT INTO users (id, stellar_address, username, phone_hash, merchant_available)
     VALUES ($1, $2, $3, $4, $5)`,
    [buyerId, 'GBUYERaddress1234567890abcdef1234567890abcdef123456789', 'test_buyer', 'buyer_phone', true]
  );

  // Insert wallet record
  await db.execute(
    `INSERT INTO wallets (user_id, stellar_address) VALUES ($1, $2)`,
    [userId, stellarAddress]
  );

  // Insert push token
  await db.execute(
    `INSERT INTO user_devices (user_id, fcm_token, device_platform, device_name)
     VALUES ($1, $2, $3, $4)`,
    [userId, 'mock_fcm_token_xyz_9876543210', 'android', 'Pixel 8']
  );

  // Insert a trade. Let's make it 'completed' so it doesn't block deletion.
  const tradeId = '33333333-3333-3333-3333-333333333333';
  await db.execute(
    `INSERT INTO trades (id, seller_id, buyer_id, flow, provider_id, amount_mxn, amount_stroops, secret_hash, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [tradeId, userId, buyerId, 'deposit', userId, 1500, 150000000n, 'mock_secret_hash', 'completed']
  );

  // Insert chat messages
  await db.execute(
    `INSERT INTO trade_messages (id, trade_id, sender_id, text)
     VALUES ($1, $2, $3, $4)`,
    ['44444444-4444-4444-4444-444444444444', tradeId, userId, 'Hola! Estoy aqui']
  );

  // Insert disputes
  await db.execute(
    `INSERT INTO trade_disputes (id, trade_id, opener_id, reason, evidence_urls)
     VALUES ($1, $2, $3, $4, $5)`,
    ['55555555-5555-5555-5555-555555555555', tradeId, userId, 'El taquero no llego', ['http://evidence.url/pic.jpg']]
  );

  // Insert secret access log
  await db.execute(
    `INSERT INTO secret_access_log (id, trade_id, user_id, ip_address, user_agent)
     VALUES ($1, $2, $3, $4, $5)`,
    ['66666666-6666-6666-6666-666666666666', tradeId, userId, '192.168.1.1', 'Mozilla/5.0']
  );

  // (Antes se sembraba `account_funding_log`. Esa tabla no existe en el
  //  esquema ni la crea ninguna migracion: el shim en memoria la inventaba al
  //  insertar y el test comprobaba su propia invencion. `3590c5e` elimino el
  //  paso correspondiente del servicio por la misma razon.)

  console.log('   Data created successfully. Executing deleteAccount...');

  // 2. Perform deletion
  const result = await deleteAccount(userId, username);
  strictEqual(result.status, 'deleted');

  console.log('   Account deleted successfully. Verifying PII removal & minimization...');

  // 3. Verifications
  // User verification
  const deletedUser = await db.getOne(
    "SELECT * FROM users WHERE id = $1",
    [userId]
  );
  ok(deletedUser);
  strictEqual(deletedUser.username, null);
  strictEqual(deletedUser.stellar_address, null);
  strictEqual(deletedUser.phone_hash, null);
  strictEqual(deletedUser.merchant_available, false);
  ok(deletedUser.deleted_at !== null);

  // Verify deleted_* fields are anonymized and DO NOT contain raw PII
  ok(deletedUser.deleted_username !== username);
  ok(deletedUser.deleted_username.startsWith('deleted_'));
  ok(deletedUser.deleted_stellar_address !== stellarAddress);
  ok(deletedUser.deleted_stellar_address.includes('...'));
  strictEqual(deletedUser.deleted_phone_hash, `anonymized_${userId.substring(0, 8)}`);

  // Wallet verification (must be deleted)
  const wallet = await db.getOne(
    "SELECT * FROM wallets WHERE user_id = $1",
    [userId]
  );
  strictEqual(wallet, null);

  // Push token verification (must be deleted)
  const pushTokens = await db.getMany(
    "SELECT * FROM user_devices WHERE user_id = $1",
    [userId]
  );
  strictEqual(pushTokens.length, 0);

  // Chat message verification (must be deleted).
  // El test apuntaba a `chat_messages` y a `dispute_events.reported_by`,
  // tablas y columnas que no existen. Mientras el servicio tenia el mismo
  // error los dos coincidian y el test pasaba sin probar nada: insertaba en
  // una tabla fantasma y comprobaba que esa tabla fantasma quedaba vacia.
  // `3590c5e` corrigio el servicio a las tablas reales; estas aserciones se
  // alinean con el esquema, no con el error.
  const messages = await db.getMany(
    "SELECT * FROM trade_messages WHERE sender_id = $1",
    [userId]
  );
  strictEqual(messages.length, 0);

  // Dispute verification (anonymized PII)
  const dispute = await db.getOne(
    "SELECT * FROM trade_disputes WHERE opener_id = $1",
    [userId]
  );
  ok(dispute);
  strictEqual(dispute.reason, 'Anonymized due to account deletion');

  // Secret access log verification (anonymized PII)
  const accessLog = await db.getOne(
    "SELECT * FROM secret_access_log WHERE user_id = $1",
    [userId]
  );
  ok(accessLog);
  strictEqual(accessLog.ip_address, '0.0.0.0');
  strictEqual(accessLog.user_agent, 'Anonymized');

  // Trade verification (must still exist to retain financial integrity!)
  const trade = await db.getOne(
    "SELECT * FROM trades WHERE id = $1",
    [tradeId]
  );
  ok(trade);
  strictEqual(trade.amount_mxn, 1500);
  strictEqual(trade.status, 'completed');
  strictEqual(trade.seller_id, userId);

  console.log('🎉 All Account Deletion & PII Minimization Tests Passed! 🍄');
}

testAccountDeletion().catch(err => {
  console.error('❌ Tests failed:', err);
  process.exit(1);
});
