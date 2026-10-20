/**
 * WP-F · el historial demo no se hace pasar por operaciones reales convertidas.
 *
 * Los seeds de index.ts (`seedData`, `seedDemoMerchants`) insertaban trades con
 * `amount_mxn * 10^7` (1 MXN = 1 XLM), sin activo ni tasa. Estos tests fijan:
 *   - las columnas de escrow sinteticas: tasa fija, activo habilitado y
 *     `rate_source = 'demo_seed_synthetic'`;
 *   - que index.ts ya no multiplica por 10^7 y que sus dos INSERT de trades
 *     escriben las cuatro columnas desde `demoSeedEscrowColumns`.
 *
 * index.ts arranca el servidor al importarse, asi que la parte estructural se
 * lee como texto. La insercion real se comprobo arrancando el backend con
 * SEED_DEMO_DATA=true contra PostgreSQL (ver el commit de WP-F).
 */

import { strictEqual, ok } from 'assert';
import { readFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import {
  DEMO_SEED_RATE_MXN,
  DEMO_SEED_RATE_SOURCE,
  demoSeedEscrowColumns,
} from '../db/demoSeedTrades.js';
import { ENABLED_ESCROW_ASSETS, stroopsAtFrozenRate } from '../services/assetRate.service.js';

function testColumns() {
  const cols = demoSeedEscrowColumns(300);
  // 300 MXN a 3 MXN/XLM = 100 XLM = 1 000 000 000 stroops.
  strictEqual(cols.amount_stroops, '1000000000');
  strictEqual(cols.asset_code, 'XLM');
  ok(ENABLED_ESCROW_ASSETS.includes(cols.asset_code as any), 'seed asset must be an enabled escrow asset');
  strictEqual(cols.rate_mxn, DEMO_SEED_RATE_MXN);
  strictEqual(cols.rate_source, DEMO_SEED_RATE_SOURCE);
  strictEqual(DEMO_SEED_RATE_SOURCE, 'demo_seed_synthetic');

  // Coherente con la tasa guardada: lo que un lector recalcularia con
  // `rate_mxn` es exactamente lo que se guardo.
  for (const amount of [150, 225, 1000, 50000]) {
    const c = demoSeedEscrowColumns(amount);
    strictEqual(c.amount_stroops, stroopsAtFrozenRate(amount, c.rate_mxn).toString(), `amount ${amount}`);
    ok(BigInt(c.amount_stroops) !== BigInt(amount) * 10_000_000n, `amount ${amount}: must not be 1:1`);
  }
  console.log('  ✓ demoSeedEscrowColumns: synthetic rate, enabled asset, stroops match the stored rate, not 1:1');
}

function testIndexUsesSyntheticColumns() {
  const dir = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(resolve(dir, '../index.ts'), 'utf8');

  ok(!/\*\s*10000000|\*\s*10_000_000|\*\s*1e7/.test(src), 'index.ts must not convert MXN to stroops 1:1');

  const inserts = src.split('INSERT INTO trades').slice(1).map((chunk) => chunk.slice(0, 1200));
  strictEqual(inserts.length, 2, 'expected the two demo seed INSERTs into trades');
  for (const [i, sql] of inserts.entries()) {
    for (const col of ['asset_code', 'rate_mxn', 'rate_source']) {
      ok(sql.includes(col), `INSERT #${i + 1} must write ${col}`);
    }
    for (const field of ['escrow.amount_stroops', 'escrow.asset_code', 'escrow.rate_mxn', 'escrow.rate_source']) {
      ok(sql.includes(field), `INSERT #${i + 1} must take ${field} from demoSeedEscrowColumns`);
    }
  }
  console.log('  ✓ index.ts: both demo trade INSERTs write asset, rate and synthetic source');
}

console.log('\nWP-F · demo seed trades\n');
testColumns();
testIndexUsesSyntheticColumns();
console.log('\nAll WP-F demo seed tests passed.\n');
