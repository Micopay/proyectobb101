/**
 * H4 (docs/AUDITORIA_IMPLEMENTACION_SELECTOR_ACTIVO_2026-09-14.md) · el QR que
 * abre el cliente de deposito muestra lo que va a recibir.
 *
 * Desde DepositChat, "ver QR" navega a /qr-deposit, que renderiza DepositQR y
 * no QRReveal. Esa pantalla no mostraba ni el activo ni la cantidad: el XLM
 * elegido en el monto y visto en la confirmacion desaparecia justo al ir a
 * entregar el efectivo.
 */

import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import i18n from '../i18n';

const { getTrade } = vi.hoisted(() => ({ getTrade: vi.fn() }));
vi.mock('../services/api', () => ({ getTrade, completeTrade: vi.fn() }));

import DepositQR from '../pages/DepositQR';

const CLIENT = 'client-1';
const AGENT = 'agent-1';

const depositTrade = (patch: Record<string, unknown> = {}) => ({
  id: 'trade-dep',
  secret_hash: 'h',
  amount_mxn: 500,
  status: 'locked',
  seller_id: AGENT,
  buyer_id: CLIENT,
  lock_tx_hash: 'tx',
  release_tx_hash: null,
  asset_code: 'XLM',
  rate_mxn: '3.2632550',
  amount_stroops: '1532267000',
  platform_fee_stroops: '12257700',
  total_locked_stroops: '1544524700',
  ...patch,
});

beforeAll(async () => {
  await i18n.changeLanguage('es');
});

beforeEach(() => {
  getTrade.mockReset();
});

describe('DepositQR', () => {
  it('shows the amount and the units the client will receive, from the server', async () => {
    getTrade.mockResolvedValue(depositTrade());
    // La operacion recien creada aun no trae el bloqueo del agente.
    const created = depositTrade({ status: 'pending', lock_tx_hash: null }) as any;
    render(
      <DepositQR activeTrade={created} buyerToken="tok" viewerId={CLIENT} onBack={() => {}} onChat={() => {}} onSuccess={() => {}} />,
    );
    expect(await screen.findByText('Vas a recibir 153.2267 XLM.')).toBeInTheDocument();
    expect(screen.getByText('$500 MXN')).toBeInTheDocument();
    expect(getTrade).toHaveBeenCalledWith('trade-dep', 'tok');
    // El cliente no ve el total que bloquea el agente.
    expect(screen.queryByText(/154\.45247/)).toBeNull();
  });

  it('shows no asset for an old response without metadata', async () => {
    getTrade.mockResolvedValue(depositTrade({ asset_code: undefined }));
    render(
      <DepositQR activeTrade={depositTrade({ asset_code: undefined }) as any} buyerToken="tok" viewerId={CLIENT} onBack={() => {}} onChat={() => {}} onSuccess={() => {}} />,
    );
    await waitFor(() => expect(getTrade).toHaveBeenCalled());
    expect(screen.queryByTestId('trade-escrow-summary')).toBeNull();
  });
});

describe('ruta real del cliente de deposito', () => {
  const dir = dirname(fileURLToPath(import.meta.url));
  const app = readFileSync(resolve(dir, '../App.tsx'), 'utf8');
  const route = (name: string) => {
    const start = app.indexOf(`function ${name}`);
    return app.slice(start, app.indexOf('\nfunction ', start + 10));
  };

  it('DepositChat abre /qr-deposit, que renderiza DepositQR con quien mira', () => {
    expect(route('ChatDepositRoute')).toContain("onViewQR={() => navigate('/qr-deposit')}");
    const qr = route('QRDepositRoute');
    expect(qr).toContain('<DepositQR');
    expect(qr).toContain('viewerId={sessionUser?.id ?? null}');
  });
});
