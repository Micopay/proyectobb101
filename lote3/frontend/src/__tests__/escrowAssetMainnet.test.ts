/**
 * Build de mainnet: la instancia del escrow bloquea USDC. El catalogo habilita
 * solo ese activo y el guard del bloqueo lo deja pasar sin preparar nada.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

describe('VITE_ESCROW_ASSET_CODE=USDC', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv('VITE_ESCROW_ASSET_CODE', 'USDC');
  });
  afterEach(() => vi.unstubAllEnvs());

  it('habilita solo USDC en Stellar y lo usa como default', async () => {
    const m = await import('../constants/escrowAssets');
    expect(m.ESCROW_ASSET_OPTIONS.filter((o) => o.enabled).map((o) => o.key)).toEqual(['stellar:USDC']);
    expect(m.getDefaultEscrowAsset().code).toBe('USDC');
  });

  it('el guard deja bloquear USDC y detiene XLM', async () => {
    const { assertNoClientPreparationForLock, EscrowAssetNotLockableError } = await import('../utils/escrowLock');
    expect(() => assertNoClientPreparationForLock('USDC')).not.toThrow();
    expect(() => assertNoClientPreparationForLock('XLM')).toThrow(EscrowAssetNotLockableError);
  });
});

describe('VITE_ESCROW_ASSETS=USDC,XLM', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv('VITE_ESCROW_ASSETS', 'USDC,XLM');
    vi.stubEnv('VITE_ESCROW_ASSET_CODE', 'USDC');
  });
  afterEach(() => vi.unstubAllEnvs());

  it('habilita los dos en Stellar, con USDC por defecto', async () => {
    const m = await import('../constants/escrowAssets');
    expect(m.ESCROW_ASSET_OPTIONS.filter((o) => o.enabled).map((o) => o.key)).toEqual(['stellar:XLM', 'stellar:USDC']);
    expect(m.DEFAULT_ESCROW_ASSET_KEY).toBe('stellar:USDC');
  });

  it('el guard deja bloquear ambos y detiene MXNe', async () => {
    const { assertNoClientPreparationForLock, EscrowAssetNotLockableError } = await import('../utils/escrowLock');
    expect(() => assertNoClientPreparationForLock('USDC')).not.toThrow();
    expect(() => assertNoClientPreparationForLock('XLM')).not.toThrow();
    expect(() => assertNoClientPreparationForLock('MXNe')).toThrow(EscrowAssetNotLockableError);
  });

  it('el default fuera de la lista cae al primero desplegado', async () => {
    vi.stubEnv('VITE_ESCROW_ASSET_CODE', 'MXNE');
    const m = await import('../constants/escrowAssets');
    expect(m.DEFAULT_ESCROW_ASSET_KEY).toBe('stellar:USDC');
  });
});
