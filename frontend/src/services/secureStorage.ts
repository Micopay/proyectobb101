import { Capacitor } from '@capacitor/core';

// We keep the original key name (`micopay_users`) so legacy sync readers in
// the codebase (e.g. TradeDetail.getToken on web) continue to work unchanged.
// On native, the SecureStorage plugin namespaces values per-app already.

interface KvStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}

// ── WebCrypto encrypted storage (web/PWA) ──

const DB_NAME = 'micopay-crypto-store';
const DB_VERSION = 1;
const KEY_STORE = 'crypto-keys';
const KEY_ID = 'aes-gcm-key';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(KEY_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/**
 * Get or create the non-extractable AES-GCM key stored in IndexedDB.
 * The key is created with `extractable: false`, so the key material can
 * never be exported — it can only be used via `crypto.subtle.encrypt()` /
 * `crypto.subtle.decrypt()`. This prevents XSS from reading the key.
 */
async function getCryptoKey(): Promise<CryptoKey> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(KEY_STORE, 'readonly');
    const store = tx.objectStore(KEY_STORE);
    const req = store.get(KEY_ID);
    req.onsuccess = async () => {
      if (req.result) {
        resolve(req.result as CryptoKey);
      } else {
        // Generate a new AES-GCM key — non-extractable
        const key = await crypto.subtle.generateKey(
          { name: 'AES-GCM', length: 256 },
          false, // non-extractable
          ['encrypt', 'decrypt'],
        );
        // Persist in IndexedDB (CryptoKey is structured-cloneable)
        const writeTx = db.transaction(KEY_STORE, 'readwrite');
        await new Promise<void>((res, rej) => {
          const putReq = writeTx.objectStore(KEY_STORE).put(key, KEY_ID);
          putReq.onsuccess = () => res();
          putReq.onerror = () => rej(putReq.error);
        });
        resolve(key);
      }
    };
    req.onerror = () => reject(req.error);
  });
}

/** Uint8Array → base64 */
function bufToBase64(buf: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < buf.byteLength; i++) binary += String.fromCharCode(buf[i]);
  return btoa(binary);
}

/** base64 → Uint8Array */
function base64ToBuf(b64: string): Uint8Array {
  const binary = atob(b64);
  const buf = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) buf[i] = binary.charCodeAt(i);
  return buf;
}

/**
 * Encrypt a string value using AES-GCM.
 * Returns base64(IV || ciphertext) — the IV is random and prepended.
 */
async function encrypt(value: string): Promise<string> {
  const key = await getCryptoKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(value);
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    encoded,
  );
  // Prepend the 12-byte IV to the ciphertext (which includes the 16-byte GCM tag)
  const combined = new Uint8Array(iv.length + ciphertext.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(ciphertext), iv.length);
  return bufToBase64(combined);
}

/**
 * Decrypt a base64(IV || ciphertext) string back to plaintext.
 */
async function decrypt(encoded: string): Promise<string> {
  const key = await getCryptoKey();
  const combined = base64ToBuf(encoded);
  const iv = combined.slice(0, 12);
  const ciphertext = combined.slice(12);
  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv },
    key,
    ciphertext,
  );
  return new TextDecoder().decode(decrypted);
}

// ── Migration: detect and re-encrypt legacy plaintext data ──

const LEGACY_MIGRATED_KEY = '__micopay_crypto_migrated';

/** Keys that may contain sensitive data and should be re-encrypted. */
const SENSITIVE_KEYS = ['stellar_keypair', 'micopay_users'];

async function maybeMigrateLegacyData(): Promise<void> {
  if (localStorage.getItem(LEGACY_MIGRATED_KEY)) return;

  for (const key of SENSITIVE_KEYS) {
    const raw = localStorage.getItem(key);
    if (!raw) continue;
    // If the value is valid JSON, it's likely plaintext that needs migration
    try {
      JSON.parse(raw);
      // Re-encrypt it
      const encrypted = await encrypt(raw);
      localStorage.setItem(key, encrypted);
    } catch {
      // Already encrypted or not valid JSON — skip
    }
  }
  localStorage.setItem(LEGACY_MIGRATED_KEY, 'true');
}

const webCryptoStore: KvStore = {
  async get(key) {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    // Try to decrypt — if it fails, fall back to plaintext (legacy data)
    try {
      return await decrypt(raw);
    } catch {
      // Legacy plaintext or non-encrypted data
      return raw;
    }
  },
  async set(key, value) {
    const encrypted = await encrypt(value);
    localStorage.setItem(key, encrypted);
  },
  async remove(key) {
    localStorage.removeItem(key);
  },
};

// ── Native (Capacitor Secure Storage) ──

let nativeStorePromise: Promise<KvStore> | null = null;

async function getStore(): Promise<KvStore> {
  if (!Capacitor.isNativePlatform()) {
    await maybeMigrateLegacyData();
    return webCryptoStore;
  }
  if (!nativeStorePromise) {
    nativeStorePromise = import('@aparajita/capacitor-secure-storage').then(({ SecureStorage }) => ({
      async get(key) {
        const v = await SecureStorage.get(key);
        return typeof v === 'string' ? v : null;
      },
      async set(key, value) {
        await SecureStorage.set(key, value);
      },
      async remove(key) {
        await SecureStorage.remove(key);
      },
    }));
  }
  return nativeStorePromise;
}

// ── Public API ──

export async function readJSON<T>(key: string): Promise<T | null> {
  const store = await getStore();
  const raw = await store.get(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export async function writeJSON(key: string, value: unknown): Promise<void> {
  const store = await getStore();
  await store.set(key, JSON.stringify(value));
}

export async function removeKey(key: string): Promise<void> {
  const store = await getStore();
  await store.remove(key);
}

const BACKUP_CONFIRMED_KEY = 'backup_confirmed';

export async function setBackupConfirmed(): Promise<void> {
  await writeJSON(BACKUP_CONFIRMED_KEY, true);
}

export async function isBackupConfirmed(): Promise<boolean> {
  const confirmed = await readJSON<boolean>(BACKUP_CONFIRMED_KEY);
  return !!confirmed;
}