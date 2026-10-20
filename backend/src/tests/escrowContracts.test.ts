/**
 * Escrow multiactivo: una instancia del contrato por activo (`ESCROW_CONTRACTS`)
 * y el contrato congelado en cada operacion (`escrow_contract_id`).
 *
 * Fija que:
 *   - `ESCROW_CONTRACTS` habilita exactamente sus activos, y el default es
 *     `ESCROW_ASSET` si tiene contrato;
 *   - sin `ESCROW_CONTRACTS`, la forma anterior (`ESCROW_ASSET` +
 *     `ESCROW_CONTRACT_ID`) sigue funcionando igual;
 *   - lock/release/refund usan el contrato congelado en la operacion antes que
 *     el del activo, y el del activo para operaciones anteriores a la columna.
 *
 * Cada caso corre en un proceso aparte porque la configuracion se lee al cargar.
 */
import { execFileSync } from 'node:child_process';
import { strictEqual, deepStrictEqual, ok } from 'assert';

const XLM_C = 'C' + 'A'.repeat(55);
const USDC_C = 'C' + 'B'.repeat(55);
const OLD_C = 'C' + 'D'.repeat(55);

function probe(env: Record<string, string>, code: string): any {
  const out = execFileSync(process.execPath, ['--import', 'tsx', '-e', code], {
    env: { ...process.env, NODE_ENV: 'production', DATABASE_URL: '', ESCROW_CONTRACTS: '', ESCROW_CONTRACT_ID: '', ESCROW_ASSET: '', ESCROW_LEGACY_CONTRACT_ID: '', ...env },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return JSON.parse(out.trim().split('\n').pop()!);
}

const POLICY = `import('./src/services/assetRate.service.ts').then(m => console.log(JSON.stringify({ enabled: m.ENABLED_ESCROW_ASSETS, def: m.DEFAULT_ASSET })))`;

function testMapEnablesItsAssets() {
  const r = probe({ ESCROW_CONTRACTS: `USDC=${USDC_C},XLM=${XLM_C}`, ESCROW_ASSET: 'USDC' }, POLICY);
  deepStrictEqual(r.enabled, ['USDC', 'XLM']);
  strictEqual(r.def, 'USDC');
  console.log('  ✓ ESCROW_CONTRACTS habilita sus activos y respeta ESCROW_ASSET');
}

function testDefaultFallsBackToFirstDeployed() {
  const r = probe({ ESCROW_CONTRACTS: `USDC=${USDC_C}`, ESCROW_ASSET: 'XLM' }, POLICY);
  deepStrictEqual(r.enabled, ['USDC']);
  strictEqual(r.def, 'USDC', 'un default sin contrato no se puede bloquear');
  console.log('  ✓ el default cae al primer activo con contrato');
}

function testLegacyEnv() {
  const r = probe({ ESCROW_CONTRACT_ID: XLM_C }, POLICY);
  deepStrictEqual(r.enabled, ['XLM']);
  strictEqual(r.def, 'XLM');
  console.log('  ✓ ESCROW_CONTRACT_ID solo sigue significando XLM');
}

function testContractForTrade() {
  const code = `import('./src/services/escrowContract.ts').then(m => console.log(JSON.stringify({
    frozen: m.escrowContractForTrade({ escrow_contract_id: '${OLD_C}', asset_code: 'USDC' }),
    byAsset: m.escrowContractForTrade({ escrow_contract_id: null, asset_code: 'usdc' }),
    xlm: m.escrowContractForTrade({ asset_code: 'XLM' }),
  })))`;
  const r = probe({ ESCROW_CONTRACTS: `USDC=${USDC_C},XLM=${XLM_C}`, ESCROW_ASSET: 'XLM' }, code);
  strictEqual(r.frozen, OLD_C, 'el contrato congelado manda aunque cambie la configuracion');
  strictEqual(r.byAsset, USDC_C);
  strictEqual(r.xlm, XLM_C);
  console.log('  ✓ lock/release/refund van al contrato de la operacion');
}

function testLegacyContractForOldTrades() {
  const code = `import('./src/services/escrowContract.ts').then(m => console.log(JSON.stringify({
    old: m.escrowContractForTrade({ escrow_contract_id: null, asset_code: 'XLM' }),
    nuevo: m.escrowContractForTrade({ escrow_contract_id: '${XLM_C}', asset_code: 'XLM' }),
  })))`;
  const r = probe({ ESCROW_CONTRACTS: `XLM=${XLM_C}`, ESCROW_LEGACY_CONTRACT_ID: OLD_C }, code);
  strictEqual(r.old, OLD_C, 'una operacion sin contrato congelado va al contrato anterior');
  strictEqual(r.nuevo, XLM_C);
  console.log('  ✓ las operaciones viejas van a ESCROW_LEGACY_CONTRACT_ID');
}

function testBadMapFailsBoot() {
  let failed = false;
  try {
    probe({ ESCROW_CONTRACTS: `BTC=${XLM_C}` }, POLICY);
  } catch {
    failed = true;
  }
  ok(failed, 'un activo desconocido debe tumbar el arranque');
  console.log('  ✓ un activo desconocido tumba el arranque');
}

console.log('Escrow multiactivo');
testMapEnablesItsAssets();
testDefaultFallsBackToFirstDeployed();
testLegacyEnv();
testContractForTrade();
testLegacyContractForOldTrades();
testBadMapFailsBoot();
console.log('\nAll escrow contract tests passed.\n');
