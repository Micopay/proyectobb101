import db from '../db/schema.js';

/**
 * In-memory blacklist used as fast first-layer check.
 * Entries are pruned when they expire to prevent unbounded growth.
 */
const memBlacklist = new Map<string, number>(); // jti → expiresAt (ms)

function pruneExpired(): void {
  const now = Date.now();
  for (const [jti, exp] of memBlacklist) {
    if (exp <= now) memBlacklist.delete(jti);
  }
}

/**
 * Revoke a token by its JTI.
 * Persists to the DB (when PostgreSQL is available) and updates the in-memory cache.
 *
 * @param jti      JWT ID claim
 * @param userId   Subject of the token
 * @param expiresAt Token expiry (Date) — used to know when the blacklist entry can be pruned
 */
export async function revokeToken(
  jti: string,
  userId: string,
  expiresAt: Date,
): Promise<void> {
  const expiresMs = expiresAt.getTime();
  memBlacklist.set(jti, expiresMs);

  // Best-effort DB persist; failure is non-fatal because in-memory check still works
  // for the lifetime of the current process. On restart the DB is the source of truth.
  await db
    .execute(
      `INSERT INTO revoked_tokens (jti, user_id, expires_at)
       VALUES ($1, $2, $3)
       ON CONFLICT (jti) DO NOTHING`,
      [jti, userId, expiresAt.toISOString()],
    )
    .catch(() => {
      /* table may not exist in dev without migrations — in-memory is the fallback */
    });
}

/**
 * Check whether a JTI has been revoked.
 * Checks in-memory first; falls back to DB on a cache miss (e.g. after a server restart).
 */
export async function isRevoked(jti: string): Promise<boolean> {
  pruneExpired();

  const cached = memBlacklist.get(jti);
  if (cached !== undefined) {
    // Already in cache — expired entries were pruned above so this is still valid
    return true;
  }

  // DB fallback (handles post-restart scenario)
  const row = await db
    .getOne<{ jti: string; expires_at: string }>(
      `SELECT jti, expires_at FROM revoked_tokens WHERE jti = $1`,
      [jti],
    )
    .catch(() => null);

  if (!row) return false;

  const expiresMs = new Date(row.expires_at).getTime();
  if (expiresMs <= Date.now()) {
    // Already past — treat as not-revoked (no functional token anyway)
    return false;
  }

  // Warm the cache
  memBlacklist.set(jti, expiresMs);
  return true;
}

/** Exposed for testing only — resets the in-memory blacklist. */
export function _resetMemBlacklist(): void {
  memBlacklist.clear();
}
