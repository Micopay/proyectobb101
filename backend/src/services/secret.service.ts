import { randomBytes, createHash, createCipheriv, createDecipheriv } from 'crypto';
import { config } from '../config.js';

const ENCRYPTION_KEY = Buffer.from(config.secretEncryptionKey, 'hex');

/**
 * Generate a random 32-byte HTLC secret and its SHA-256 hash.
 * - secret: 64-char hex string (the preimage)
 * - secretHash: 64-char hex string (goes to the smart contract)
 */
export function generateTradeSecret(): { secret: string; secretHash: string } {
  const secretBytes = randomBytes(32);
  const secret = secretBytes.toString('hex');
  const secretHash = createHash('sha256').update(secretBytes).digest('hex');
  return { secret, secretHash };
}

/**
 * Encrypt the secret with AES-256-GCM for storage in the database.
 * Returns the ciphertext (with appended auth tag) and the nonce.
 */
export function encryptSecret(secret: string): { encrypted: Buffer; nonce: Buffer } {
  const nonce = randomBytes(12); // 96-bit nonce for GCM
  const cipher = createCipheriv('aes-256-gcm', ENCRYPTION_KEY, nonce);
  const encrypted = Buffer.concat([
    cipher.update(secret, 'utf8'),
    cipher.final(),
    cipher.getAuthTag(), // 16 bytes of authentication
  ]);
  return { encrypted, nonce };
}

/**
 * Decrypt the secret from the database.
 * Expects the ciphertext with the 16-byte auth tag appended.
 */
export function decryptSecret(encrypted: Buffer, nonce: Buffer): string {
  const authTag = encrypted.subarray(-16);
  const ciphertext = encrypted.subarray(0, -16);
  const decipher = createDecipheriv('aes-256-gcm', ENCRYPTION_KEY, nonce);
  decipher.setAuthTag(authTag);
  return decipher.update(ciphertext).toString('utf8') + decipher.final('utf8');
}
