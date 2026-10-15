/**
 * CASH-6 · La salida de emergencia tiene que estar visible.
 *
 * Seguimiento correctivo del issue cerrado #71.
 *
 * El backend permitía reembolsar tras `expires_at` con fondos bloqueados,
 * pero la app ofrecía la acción SOLO cuando el estado era `expired`, y ese
 * estado nunca se persiste. Una operación `locked` vencida se quedaba
 * mostrando "esperando" para siempre, sin ninguna forma de recuperar el
 * dinero — justo cuando el reembolso por vencimiento es la última garantía.
 *
 * Lo que se fija aquí: la elegibilidad la manda el servidor, el CTA aparece
 * con ella, y el estado se refresca al terminar.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import TradeDetail from '../pages/TradeDetail';

const mockGetTrade = vi.fn();
const mockEligibility = vi.fn();
const mockRefund = vi.fn();

vi.mock('../services/api', () => ({
  fetchTradeDetail: vi.fn(async (id: string, token: string) => ({
    trade: await mockGetTrade(id, token),
    merchant_unavailable: false,
    seller_username: 'cliente',
    buyer_username: 'agente',
  })),
  fetchRefundEligibility: (...a: unknown[]) => mockEligibility(...a),
  refundTradeRequest: (...a: unknown[]) => mockRefund(...a),
  completeTrade: vi.fn(),
  cancelTradeRequest: vi.fn(),
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

/** Una operación con fondos dentro y sin liberar. */
function lockedTrade(status = 'locked') {
  return {
    id: 'trade-123',
    status,
    secret_hash: 'abc',
    amount_mxn: 500,
    platform_fee_mxn: 4,
    lock_tx_hash: 'mock_lock_hash',
    release_tx_hash: null,
    created_at: '2026-01-01T10:00:00Z',
    completed_at: null,
    expires_at: '2026-01-01T12:00:00Z',
    flow: 'cashout' as const,
    seller_id: CLIENT,
    buyer_id: PROVIDER,
    provider_id: PROVIDER,
  };
}

const eligible = {
  trade_id: 'trade-123',
  eligible: true,
  reason: 'eligible' as const,
  expires_at: '2026-01-01T12:00:00Z',
  server_time: '2026-01-01T13:00:00Z',
  seconds_remaining: 0,
};

const notYet = { ...eligible, eligible: false, reason: 'not_expired_yet' as const, seconds_remaining: 1800 };

function renderDetail() {
  return render(
    <MemoryRouter initialEntries={['/trade/trade-123']}>
      <Routes>
        <Route path="/trade/:id" element={<TradeDetail token="tok" userId={CLIENT} onBack={() => {}} />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetTrade.mockResolvedValue(lockedTrade());
  mockRefund.mockResolvedValue({ status: 'refunded', refund_tx_hash: 'tx' });
});

describe('CASH-6 · el CTA de recuperación', () => {
  it('aparece en una operación `locked` vencida, sin estado `expired`', async () => {
    mockEligibility.mockResolvedValue(eligible);
    renderDetail();

    // El estado sigue siendo `locked` — este es el caso que estaba muerto.
    await waitFor(() => expect(screen.getByText(/se agotó el tiempo/i)).toBeInTheDocument());
    expect(screen.getByRole('button', { name: /recuperar fondos/i })).toBeInTheDocument();
  });

  it('también en `revealing`', async () => {
    mockGetTrade.mockResolvedValue(lockedTrade('revealing'));
    mockEligibility.mockResolvedValue(eligible);
    renderDetail();

    await waitFor(() => expect(screen.getByText(/se agotó el tiempo/i)).toBeInTheDocument());
  });

  it('NO aparece antes de que venza', async () => {
    mockEligibility.mockResolvedValue(notYet);
    renderDetail();

    await waitFor(() => expect(mockEligibility).toHaveBeenCalled());
    expect(screen.queryByText(/se agotó el tiempo/i)).toBeNull();
    expect(screen.queryByRole('button', { name: /recuperar fondos/i })).toBeNull();
  });

  it('si el servidor no responde, no se inventa el CTA', async () => {
    mockEligibility.mockRejectedValue(new Error('network'));
    renderDetail();

    await waitFor(() => expect(mockEligibility).toHaveBeenCalled());
    expect(screen.queryByRole('button', { name: /recuperar fondos/i })).toBeNull();
  });
});

describe('CASH-6 · ejecución y estado final', () => {
  it('reembolsa y refresca el estado al terminar', async () => {
    mockEligibility.mockResolvedValue(eligible);
    renderDetail();

    await waitFor(() => expect(screen.getByRole('button', { name: /recuperar fondos/i })).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /recuperar fondos/i }));

    // El diálogo de confirmación y su botón de ejecutar.
    const execute = await screen.findByRole('button', { name: /sí, recuperar fondos/i });
    // Tras confirmar, la operación pasa a reembolsada.
    mockGetTrade.mockResolvedValue({ ...lockedTrade('refunded'), release_tx_hash: 'tx' });
    fireEvent.click(execute);

    await waitFor(() => expect(mockRefund).toHaveBeenCalledWith('trade-123', 'tok'));
    // Se vuelve a pedir el detalle: el estado final es el del servidor, no
    // una suposición optimista de la pantalla.
    await waitFor(() => expect(mockGetTrade.mock.calls.length).toBeGreaterThan(1));
  });

  it('un doble toque no reembolsa dos veces', async () => {
    mockEligibility.mockResolvedValue(eligible);
    // El reembolso tarda: es la ventana en la que un segundo toque colaría
    // otra petición.
    let resolveRefund!: (v: unknown) => void;
    mockRefund.mockReturnValue(new Promise((r) => { resolveRefund = r; }));

    renderDetail();
    await waitFor(() => expect(screen.getByRole('button', { name: /recuperar fondos/i })).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /recuperar fondos/i }));

    const execute = await screen.findByRole('button', { name: /sí, recuperar fondos/i });
    fireEvent.click(execute);

    // Lo que de verdad protege al usuario es que el botón quede inhabilitado
    // mientras la petición viaja. (El `if (isRefunding) return;` del handler
    // es defensa adicional para llamadas que no pasan por el botón; este test
    // no puede aislarla, y decirlo es más honesto que fingir que sí.)
    // Son dos: el del diálogo y el de la vista. Los dos deben quedar
    // inhabilitados, no solo el que se pulsó.
    await waitFor(() => {
      const busy = screen.getAllByRole('button', { name: /procesando/i });
      expect(busy.length).toBeGreaterThan(0);
      busy.forEach((b) => expect(b).toBeDisabled());
    });

    screen.getAllByRole('button', { name: /procesando/i }).forEach((b) => {
      fireEvent.click(b);
      fireEvent.click(b);
    });

    expect(mockRefund).toHaveBeenCalledTimes(1);
    resolveRefund({ status: 'refunded', refund_tx_hash: 'tx' });
  });
});
