/**
 * Per-key async mutex: concurrent calls made with the same key run strictly
 * one after another (read-then-write critical sections become race-safe);
 * calls with different keys are unaffected by each other.
 *
 * Scope note: this only serializes concurrent calls within THIS process. It
 * does not protect against races across multiple horizontally-scaled app
 * instances sharing one Postgres database — that would additionally need a
 * DB-level guard (e.g. a single guarded `UPDATE ... WHERE` or
 * `SELECT ... FOR UPDATE`). Acceptable here: this backend runs as a single
 * instance today, and db/schema.ts's in-memory fallback (used in tests) has
 * the same single-instance assumption already.
 */
const locks = new Map<string, Promise<unknown>>();

export function withKeyedLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prior = locks.get(key) ?? Promise.resolve();
  // Chain onto `prior` regardless of whether it resolved or rejected, so one
  // failed operation never wedges the lock for everyone after it.
  const run = prior.then(fn, fn);
  // Store a version that never rejects — an unhandled rejection here would
  // otherwise surface as a process-level warning unrelated to the caller
  // that actually triggered the failure (they already get `run`'s rejection).
  locks.set(key, run.catch(() => {}));
  return run;
}
