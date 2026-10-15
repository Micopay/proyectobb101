/**
 * Recibir USDC exige trustline, y la app no tenia donde crearla. La pantalla de
 * Recibir ofrece activarlo cuando falta, y solo para los activos del escrow.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const { hasTrustline, ensureTrustline } = vi.hoisted(() => ({ hasTrustline: vi.fn(), ensureTrustline: vi.fn() }));
vi.mock('../services/payment', () => ({ hasTrustline, ensureTrustline }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string, o?: Record<string, string>) => (o?.code ? `${k}:${o.code}` : k) }),
}));
vi.mock('../constants/assets', () => {
  const ASSETS = [
    { code: 'USDC', label: 'USD Coin', native: false, issuer: 'GUSDC', decimals: 2 },
    { code: 'CETES', label: 'CETES', native: false, issuer: 'GCETES', decimals: 2 },
    { code: 'XLM', label: 'XLM', native: true, decimals: 4 },
  ];
  return { ASSETS, SENDABLE_ASSETS: ASSETS };
});
vi.mock('../constants/escrowAssets', () => ({
  ESCROW_ASSET_OPTIONS: [
    { code: 'USDC', enabled: true },
    { code: 'XLM', enabled: true },
  ],
}));

import ReceivePayment from '../pages/ReceivePayment';

describe('ReceivePayment · activar USDC', () => {
  beforeEach(() => {
    hasTrustline.mockReset();
    ensureTrustline.mockReset();
  });

  it('ofrece activar USDC si falta la trustline, y no CETES', async () => {
    hasTrustline.mockResolvedValue(false);
    render(<ReceivePayment address="GABC" onBack={() => {}} />);
    expect(await screen.findByText('receive.activate:USDC')).toBeTruthy();
    expect(screen.queryByText('receive.activate:CETES')).toBeNull();
    expect(hasTrustline).toHaveBeenCalledWith('USDC');
    expect(hasTrustline).not.toHaveBeenCalledWith('CETES');
  });

  it('crea la trustline al tocar el boton y lo quita', async () => {
    hasTrustline.mockResolvedValue(false);
    ensureTrustline.mockResolvedValue({ hash: 'h' });
    render(<ReceivePayment address="GABC" onBack={() => {}} />);
    fireEvent.click(await screen.findByText('receive.activate:USDC'));
    await waitFor(() => expect(ensureTrustline).toHaveBeenCalledWith('USDC'));
    await waitFor(() => expect(screen.queryByText('receive.activate:USDC')).toBeNull());
  });

  it('no muestra nada si ya esta activo', async () => {
    hasTrustline.mockResolvedValue(true);
    render(<ReceivePayment address="GABC" onBack={() => {}} />);
    await waitFor(() => expect(hasTrustline).toHaveBeenCalled());
    expect(screen.queryByText('receive.activate:USDC')).toBeNull();
  });
});
