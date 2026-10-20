import { randomBytes, createHash } from 'crypto';
import db from '../db/schema.js';

export interface IssuedDeviceKey {
  id: string;
  name: string;
  token: string;
}

/**
 * Issue a new device key for an external client application (e.g., Coffee Payments).
 * Generates a Bearer token (`mp_dev_...`), hashes it with SHA-256 for storage,
 * and returns the plaintext token ONCE to the caller.
 */
export async function issueDeviceKey(deviceName: string): Promise<IssuedDeviceKey> {
  if (!deviceName || !deviceName.trim()) {
    throw new Error('Device name is required');
  }

  const token = `mp_dev_${randomBytes(24).toString('hex')}`;
  const keyHash = createHash('sha256').update(token).digest('hex');

  const row = await db.getOne<{ id: string }>(
    `INSERT INTO device_keys (name, key_hash, is_active, created_at)
     VALUES ($1, $2, true, NOW())
     RETURNING id`,
    [deviceName.trim(), keyHash]
  );

  return {
    id: row?.id ?? 'generated-id',
    name: deviceName.trim(),
    token,
  };
}
