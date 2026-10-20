import { randomBytes } from 'crypto';
import { config } from '../config.js';
import { AuthError } from '../utils/errors.js';

/**
 * In-memory challenge store for SEP-10-style proof-of-key-possession.
 * Shared by /auth/token (login) and /users/register (signup) so that
 * registering a stellar_address always requires proving you hold its
 * private key — see docs/AUDIT_MOBILE_MAINNET.md, "Registro sin prueba de
 * posesión de llave". MVP-scale: single-process Map, not shared across
 * instances — move to Redis before scaling horizontally.
 */
const challenges = new Map<string, { challenge: string; expiresAt: number }>();

const CHALLENGE_TTL_MS = 5 * 60 * 1000;

/**
 * Maximum number of pending challenges kept in memory at once.
 *
 * Ported from the in-route store that used to live in routes/auth.ts, together
 * with the pruning interval below. Both come from the memory-leak fix in #341
 * (SEC-16): without them, an attacker rotating IPs can grow this Map without
 * bound. They must stay here now that the store is shared by /auth/token and
 * /users/register — moving the store without moving its bounds would have
 * silently reintroduced the leak.
 */
const CHALLENGES_MAX_SIZE = 10_000;

/**
 * Prune expired challenges every 60 seconds so the Map stays bounded in
 * long-running processes or under an IP-rotation attack.
 */
const _challengePruneInterval = setInterval(() => {
  const now = Date.now();
  for (const [address, entry] of challenges) {
    if (entry.expiresAt <= now) {
      challenges.delete(address);
    }
  }
}, 60_000);
// Allow the Node.js process to exit cleanly even if this interval is running.
_challengePruneInterval.unref();

export function issueChallenge(stellarAddress: string): { challenge: string; expiresAt: number } {
  const challenge = `micopay-auth-${randomBytes(16).toString('hex')}-${Date.now()}`;
  const expiresAt = Date.now() + CHALLENGE_TTL_MS;

  // Enforce maximum store size: evict the oldest entry when the cap is reached.
  if (challenges.size >= CHALLENGES_MAX_SIZE) {
    const oldestKey = challenges.keys().next().value;
    if (oldestKey !== undefined) {
      challenges.delete(oldestKey);
    }
  }

  challenges.set(stellarAddress, { challenge, expiresAt });
  return { challenge, expiresAt };
}

/**
 * Verifies a previously issued challenge was signed by the holder of
 * `stellarAddress`'s private key, then consumes it (single-use). Throws
 * AuthError on any failure. Signature verification itself is skipped when
 * `MOCK_STELLAR=true` (matches the existing /auth/token behavior), but the
 * challenge must still exist and not be expired even in mock mode.
 */
export async function verifyAndConsumeChallenge(
  stellarAddress: string,
  challenge: string,
  signature: string,
): Promise<void> {
  const stored = challenges.get(stellarAddress);
  if (!stored || stored.challenge !== challenge) {
    throw new AuthError(
      'AUTH_INVALID_CHALLENGE',
      'El código de verificación no es válido o ha expirado. Por favor, intenta de nuevo.',
      'Invalid or mismatched challenge provided',
    );
  }
  if (Date.now() > stored.expiresAt) {
    challenges.delete(stellarAddress);
    throw new AuthError(
      'AUTH_CHALLENGE_EXPIRED',
      'El código de verificación ha expirado. Por favor, solicita uno nuevo.',
      'Challenge expired',
    );
  }

  if (!config.mockStellar) {
    try {
      const { Keypair } = await import('@stellar/stellar-sdk');
      const keypair = Keypair.fromPublicKey(stellarAddress);
      const verified = keypair.verify(
        Buffer.from(challenge, 'utf8'),
        Buffer.from(signature, 'base64'),
      );
      if (!verified) {
        throw new AuthError(
          'AUTH_INVALID_CREDENTIALS',
          'La firma no es válida. Por favor, intenta de nuevo.',
          'Invalid signature',
        );
      }
    } catch (err: any) {
      if (err instanceof AuthError) throw err;
      throw new AuthError(
        'AUTH_INVALID_CREDENTIALS',
        'La firma no es válida. Por favor, intenta de nuevo.',
        `Signature verification failed: ${err.message}`,
      );
    }
  }

  challenges.delete(stellarAddress);
}
