import type { preHandlerHookHandler } from 'fastify';
import { RateLimitError } from '../utils/errors.js';

export interface RateLimitStore {
  increment(key: string, windowMs: number): Promise<{ current: number; resetTime: number }>;
}

export class InMemoryStore implements RateLimitStore {
  private hits = new Map<string, { count: number; expiresAt: number }>();

  /** Maximum number of keys tracked at once. Oldest entry is evicted when the cap is hit. */
  private readonly maxSize: number;

  constructor(maxSize = 50_000) {
    this.maxSize = maxSize;

    /**
     * Prune expired entries every 60 seconds so the map stays bounded in
     * long-running processes even when a window has expired and the key was
     * never accessed again (e.g., single-hit IPs that never come back).
     */
    const pruneInterval = setInterval(() => {
      const now = Date.now();
      for (const [key, record] of this.hits) {
        if (record.expiresAt <= now) {
          this.hits.delete(key);
        }
      }
    }, 60_000);
    // Allow the Node.js process to exit cleanly even if this interval is running.
    pruneInterval.unref();
  }

  async increment(key: string, windowMs: number): Promise<{ current: number; resetTime: number }> {
    const now = Date.now();
    const record = this.hits.get(key);

    if (!record || record.expiresAt <= now) {
      // Enforce maximum store size: evict the oldest entry when the cap is reached.
      if (this.hits.size >= this.maxSize) {
        const oldestKey = this.hits.keys().next().value;
        if (oldestKey !== undefined) {
          this.hits.delete(oldestKey);
        }
      }
      const expiresAt = now + windowMs;
      this.hits.set(key, { count: 1, expiresAt });
      return { current: 1, resetTime: expiresAt };
    }

    record.count += 1;
    return { current: record.count, resetTime: record.expiresAt };
  }
}

const defaultStore = new InMemoryStore();

export interface RateLimitOptions {
  windowMs: number;
  max: number;
  keyGenerator?: (request: any) => string;
  store?: RateLimitStore;
}

export function createRateLimiter(options: RateLimitOptions): preHandlerHookHandler {
  const {
    windowMs,
    max,
    keyGenerator = (req) => req.ip,
    store = defaultStore,
  } = options;

  return async (request, reply) => {
    const key = keyGenerator(request);
    const { current, resetTime } = await store.increment(key, windowMs);

    if (current > max) {
      const retryAfter = Math.ceil((resetTime - Date.now()) / 1000);
      reply.header('Retry-After', retryAfter);
      throw new RateLimitError(`Too many requests. Please try again in ${retryAfter} seconds.`, retryAfter);
    }
  };
}
