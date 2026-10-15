/**
 * CASH-5B · Qué ve y qué puede hacer cada actor en `revealing`.
 *
 * Complementa `tradeActor.test.ts`, que fija la derivación del papel. Aquí se
 * comprueba lo que el issue pide de verdad: que las cuatro combinaciones
 * rendericen pasos distintos y ciertos, que **toda acción visible tenga un
 * handler que funcione**, y que **nadie pueda invocar la acción de su
 * contraparte** desde esta pantalla.
 *
 * Antes de CASH-5B esta vista tenía dos botones sin `onClick` y un texto único
 * que no era cierto para nadie, mientras la única acción de completar vivía en
 * una vista atada a `revealed`, un estado que ningún backend emite.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import TradeDetail from '../pages/TradeDetail';

const mockGetTrade = vi.fn();
const mockCompleteTrade = vi.fn();

vi.mock('../services/api', () => ({
  fetchTradeDetail: vi.fn(async (id: string, token: string) => {
    const trade = await mockGetTrade(id, token);
    return { trade, merchant_unavailable: false, seller_username: 'agente', buyer_username: 'cliente' };
  }),
  completeTrade: (...a: unknown[]) => mockCompleteTrade(...a),
  cancelTradeRequest: vi.fn(),
  refundTradeRequest: vi.fn(),
  lockTrade: vi.fn(),
}));
vi.mock('../services/payment', () => ({ ensureTrustline: vi.fn() }));
vi.mock('../services/secureStorage', () => ({ readJSON: vi.fn().mockResolvedValue(null) }));
vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-i18next')>();
  return { ...actual, useTranslation: () => ({ t: (k: string) => k }) };
});

const CLIENT = 'user-client';
const PROVIDER = 'user-provider';

/** `revealing` es el estado en que estas cuatro vistas ocurren. */
function revealingTrade(flow: 'cashout' | 'deposit') {
  const cashout = flow === 'cashout';
  return {
    id: 'trade-123',
    status: 'revealing',
    secret_hash: 'abc',
    amount_mxn: 500,
    platform_fee_mxn: 4,
    lock_tx_hash: 'mock_lock',
    release_tx_hash: null,
    created_at: '2026-01-01T10:00:00Z',
    completed_at: null,
    expires_at: '2099-01-01T12:00:00Z',
    flow,
    // Cash-out: el cliente entrega cripto (vendedor). Depósito: al revés.
    seller_id: cashout ? CLIENT : PROVIDER,
    buyer_id: cashout ? PROVIDER : CLIENT,
    provider_id: PROVIDER,
  };
}

function renderAs(userId: string, flow: 'cashout' | 'deposit') {
  mockGetTrade.mockResolvedValue(revealingTrade(flow));
  return render(
    <MemoryRouter initialEntries={['/trade/trade-123']}>
      <Routes>
        <Route path="/trade/:id" element={<TradeDetail token="tok" userId={userId} onBack={() => {}} />} />
        <Route path="/qr-reveal" element={<div>RUTA_QR</div>} />
        <Route path="/chat" element={<div>RUTA_CHAT</div>} />
        <Route path="/inbox" element={<div>RUTA_INBOX</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockCompleteTrade.mockResolvedValue({ status: 'completed', release_tx_hash: 'tx' });
});

describe('CASH-5B · cash-out', () => {
  it('el cliente muestra su código y no puede liberar', async () => {
    renderAs(CLIENT, 'cashout');
    await waitFor(() => expect(screen.getByText(/muestra tu código/i)).toBeInTheDocument());

    // Su acción: enseñar el QR. Con handler real.
    fireEvent.click(screen.getByRole('button', { name: /ver mi código/i }));
    await waitFor(() => expect(screen.getByText('RUTA_QR')).toBeInTheDocument());
  });

  it('el cliente NO ve la acción del proveedor', async () => {
    renderAs(CLIENT, 'cashout');
    await waitFor(() => expect(screen.getByText(/muestra tu código/i)).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: /escanear/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /entregaste el efectivo|confirmar/i })).toBeNull();
  });

  it('el proveedor va a escanear, no a liberar a ciegas', async () => {
    renderAs(PROVIDER, 'cashout');
    await waitFor(() => expect(screen.getByText(/escanea el código del cliente/i)).toBeInTheDocument());

    // CASH-4 exige la constancia de entrega antes de liberar: ofrecerle
    // "liberar" aquí produciría un 409. La acción honesta es el escáner.
    expect(screen.queryByRole('button', { name: /ya recibí|ya entregué/i })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /ir a escanear/i }));
    await waitFor(() => expect(screen.getByText('RUTA_INBOX')).toBeInTheDocument());
    expect(mockCompleteTrade).not.toHaveBeenCalled();
  });
});

describe('CASH-5B · depósito', () => {
  it('el cliente confirma la entrega y eso libera de verdad', async () => {
    renderAs(CLIENT, 'deposit');
    await waitFor(() => expect(screen.getByText(/confirmar la entrega/i)).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /ya entregaste|ya entregué|confirmar/i }));
    await waitFor(() => expect(mockCompleteTrade).toHaveBeenCalledWith('trade-123', 'tok'));
  });

  it('el proveedor espera y no tiene acción de liberar', async () => {
    renderAs(PROVIDER, 'deposit');
    await waitFor(() => expect(screen.getByText(/esperando al cliente/i)).toBeInTheDocument());

    expect(screen.queryByRole('button', { name: /ya entregué|confirmar|escanear/i })).toBeNull();
    expect(mockCompleteTrade).not.toHaveBeenCalled();
  });
});

describe('CASH-5B · honestidad sobre los fondos', () => {
  it('no declara liberado lo que el release rechazó', async () => {
    mockCompleteTrade.mockRejectedValue(new Error('on-chain release failed'));
    renderAs(CLIENT, 'deposit');
    await waitFor(() => expect(screen.getByText(/confirmar la entrega/i)).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /ya entregaste|ya entregué|confirmar/i }));

    // El guard existía desde antes, pero vivía en una vista inalcanzable.
    await waitFor(() => expect(screen.getByText(/no se pudo confirmar/i)).toBeInTheDocument());
    expect(screen.getByText(/sigue retenido en la garantía/i)).toBeInTheDocument();
  });

  it('las cuatro vistas ofrecen chat, que siempre es seguro', async () => {
    for (const [user, flow] of [
      [CLIENT, 'cashout'],
      [PROVIDER, 'cashout'],
      [CLIENT, 'deposit'],
      [PROVIDER, 'deposit'],
    ] as const) {
      const { unmount } = renderAs(user, flow);
      await waitFor(() =>
        expect(screen.getByRole('button', { name: /abrir chat/i })).toBeInTheDocument(),
      );
      unmount();
    }
  });
});
