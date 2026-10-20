/**
 * Idempotent SQL migration runner.
 *
 * Applies `micopay/sql/init.sql` first, then every file in `micopay/sql/migrations/`
 * EXCEPT the `*.down.sql` rollbacks, in lexicographic order. Each file is applied at most
 * once — tracked in a `schema_migrations` table — so the runner is safe to re-run and works
 * even though the migration set is heterogeneous (some files are not `IF NOT EXISTS`).
 *
 * Usage: `npm run migrate` (needs DATABASE_URL). Intended as Render's preDeploy step so the
 * schema exists before the backend boots (otherwise seedData crashes on a missing `trades`).
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const { Pool } = pg;

// src/db/migrate.ts and dist/db/migrate.js are both 3 levels under micopay/ → ../../../sql.
const SQL_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../../sql');
const MIGRATIONS_DIR = join(SQL_DIR, 'migrations');

interface SqlFile {
  name: string;
  path: string;
}

function orderedFiles(): SqlFile[] {
  const migrations = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
    .sort();

  return [
    { name: 'init.sql', path: join(SQL_DIR, 'init.sql') },
    ...migrations.map((f) => ({ name: `migrations/${f}`, path: join(MIGRATIONS_DIR, f) })),
  ];
}

/**
 * Apply all pending migrations. Idempotent and safe to call on every boot.
 * Throws on failure (caller decides whether to exit).
 */
export async function runMigrations(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is not set — cannot run migrations.');
  }

  const pool = new Pool({ connectionString: databaseUrl, connectionTimeoutMillis: 15_000 });

  try {
    await pool.query(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
         filename   TEXT PRIMARY KEY,
         applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
       )`,
    );

    let applied = 0;
    for (const file of orderedFiles()) {
      const seen = await pool.query('SELECT 1 FROM schema_migrations WHERE filename = $1', [file.name]);
      if (seen.rowCount && seen.rowCount > 0) {
        console.log(`⏭️  skip   ${file.name} (already applied)`);
        continue;
      }

      const sql = readFileSync(file.path, 'utf-8');
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [file.name]);
        await client.query('COMMIT');
        console.log(`✅ apply  ${file.name}`);
        applied++;
      } catch (err) {
        await client.query('ROLLBACK');
        console.error(`❌ failed ${file.name}:`, err instanceof Error ? err.message : err);
        throw err;
      } finally {
        client.release();
      }
    }

    console.log(`🎉 Migrations complete (${applied} applied this run).`);
  } finally {
    await pool.end();
  }
}

// CLI entrypoint: only run + exit when invoked directly (e.g. `npm run migrate`),
// not when imported by the server for boot-time migrations.
const invokedDirectly =
  process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);

if (invokedDirectly) {
  runMigrations()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
