/**
 * WP-B · catalogo de activos del escrow, tasa y envio de `asset_code`.
 *
 * Fija las invariantes de las que dependen el selector (WP-C) y el backend
 * (WP-A): un solo default, habilitado y aceptado por el servidor; claves unicas;
 * una tasa invalida no se convierte en un equivalente con apariencia de dato; y
 * `createTrade` solo envia `asset_code` cuando se le pasa, para que un llamador
 * sin activo siga obteniendo XLM del servidor.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { post, get } = vi.hoisted(() => ({ post: vi.fn(), get: vi.fn() }));

vi.mock('axios', () => ({
  default: {
    create: () => ({
      post,
      get,
      interceptors: { response: { use: vi.fn() }, request: { use: vi.fn() } },
    }),
  },
}));

import {
  DEFAULT_ESCROW_ASSET_KEY,
  ESCROW_ASSET_OPTIONS,
  getDefaultEscrowAsset,
  getEscrowAssetOption,
} from '../constants/escrowAssets';
import { createTrade, getEscrowAssetRate, parseEscrowAssetRate } from '../services/api';

describe('ESCROW_ASSET_OPTIONS', () => {
  it('has unique keys', () => {
    const keys = ESCROW_ASSET_OPTIONS.map((o) => o.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('key is always <network>:<CODE>', () => {
    for (const o of ESCROW_ASSET_OPTIONS) {
      expect(o.key).toBe(`${o.network}:${o.code.toUpperCase()}`);
    }
  });

  it('has exactly one default, and it is enabled', () => {
    const matches = ESCROW_ASSET_OPTIONS.filter((o) => o.key === DEFAULT_ESCROW_ASSET_KEY);
    expect(matches).toHaveLength(1);
    expect(getDefaultEscrowAsset().enabled).toBe(true);
  });

  it('only XLM on Stellar is enabled (mirrors backend ENABLED_ESCROW_ASSETS)', () => {
    expect(ESCROW_ASSET_OPTIONS.filter((o) => o.enabled).map((o) => o.key)).toEqual(['stellar:XLM']);
  });

  it('keeps the same code on different networks as distinct options', () => {
    expect(getEscrowAssetOption('stellar:USDC')?.networkLabel).toBe('Stellar');
    expect(getEscrowAssetOption('solana:USDC')?.networkLabel).toBe('Solana');
  });

  it('does not offer CETES: it is an investment, not an escrow asset', () => {
    expect(ESCROW_ASSET_OPTIONS.some((o) => o.code.toUpperCase() === 'CETES')).toBe(false);
  });

  it('every enabled option has a rate source', async () => {
    get.mockResolvedValue({ data: { rate: 3.26, source: 't', fetchedAt: 'now' } });
    for (const o of ESCROW_ASSET_OPTIONS.filter((x) => x.enabled)) {
      await expect(getEscrowAssetRate(o.code)).resolves.toMatchObject({ rate: 3.26 });
    }
  });
});

describe('escrow asset rate', () => {
  beforeEach(() => get.mockReset());

  it('accepts a finite positive rate, numeric or string', () => {
    expect(parseEscrowAssetRate(3.263255)).toBe(3.263255);
    expect(parseEscrowAssetRate('3.2632550')).toBe(3.263255);
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, '', 'abc', null, undefined, {}])(
    'rejects %p',
    (raw) => {
      expect(() => parseEscrowAssetRate(raw)).toThrow(/Invalid escrow asset rate/);
    },
  );

  it('reads XLM from /rate/xlm-mxn', async () => {
    get.mockResolvedValue({ data: { rate: 3.263255, source: 'coinbase+erapi', fetchedAt: 'x' } });
    const r = await getEscrowAssetRate('XLM');
    expect(get).toHaveBeenCalledWith('/rate/xlm-mxn');
    expect(r.rate).toBe(3.263255);
  });

  it('fails when the server returns an invalid rate', async () => {
    get.mockResolvedValue({ data: { rate: 0, source: 'x', fetchedAt: 'x' } });
    await expect(getEscrowAssetRate('XLM')).rejects.toThrow(/Invalid escrow asset rate/);
  });

  it('has no rate source for assets without escrow (MXNe)', async () => {
    await expect(getEscrowAssetRate('MXNe')).rejects.toThrow(/No rate source/);
    expect(get).not.toHaveBeenCalled();
  });
});

describe('createTrade asset_code', () => {
  beforeEach(() => {
    post.mockReset();
    post.mockResolvedValue({ data: { trade: { id: 't1' } } });
  });

  it('sends asset_code when given', async () => {
    await createTrade('cp', 500, 'tok', 'cashout', 'XLM');
    expect(post).toHaveBeenCalledWith(
      '/trades',
      { counterparty_id: 'cp', amount_mxn: 500, flow: 'cashout', asset_code: 'XLM' },
      expect.anything(),
    );
  });

  it('omits asset_code when not given, so the server default applies', async () => {
    await createTrade('cp', 500, 'tok', 'deposit');
    const body = post.mock.calls[0][1];
    expect(body).toEqual({ counterparty_id: 'cp', amount_mxn: 500, flow: 'deposit' });
    expect('asset_code' in body).toBe(false);
  });
});
