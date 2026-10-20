import db, { pool } from './schema.js';

/**
 * Retrieve the last successfully processed ledger for a given contract.
 * Returns 0 when no cursor has been persisted (first run).
 */
export async function getEventCursor(contractId: string): Promise<number> {
  const row = await db.getOne<{ last_ledger: string | number }>(
    'SELECT last_ledger FROM event_cursor WHERE contract_id = $1',
    [contractId],
  );
  return row ? Number(row.last_ledger) : 0;
}

/**
 * Persist the latest processed ledger for a given contract.
 *
 * PostgreSQL path: atomic UPSERT (safe under concurrent restarts).
 * In-memory path: check-then-set (single-process, no concurrency risk).
 */
export async function setEventCursor(contractId: string, ledger: number): Promise<void> {
  if (pool) {
    await db.execute(
      `INSERT INTO event_cursor (contract_id, last_ledger, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (contract_id) DO UPDATE
         SET last_ledger = EXCLUDED.last_ledger,
             updated_at  = NOW()`,
      [contractId, ledger],
    );
    return;
  }

  // In-memory fallback: check then insert-or-update
  const existing = await db.getOne(
    'SELECT contract_id FROM event_cursor WHERE contract_id = $1',
    [contractId],
  );

  if (existing) {
    await db.execute(
      'UPDATE event_cursor SET last_ledger = $2, updated_at = NOW() WHERE contract_id = $1',
      [contractId, ledger],
    );
  } else {
    await db.execute(
      'INSERT INTO event_cursor (contract_id, last_ledger) VALUES ($1, $2)',
      [contractId, ledger],
    );
  }
}
