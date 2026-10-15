/**
 * Depósito · el agente confirma que recibió el efectivo.
 *
 * Antes el depósito con un agente real se quedaba en `locked`: el agente no
 * tenía ningún botón para `POST /trades/:id/reveal` y el QR del cliente no lo
 * reconocía nadie. Ahora el agente confirma escaneando ese QR o desde la
 * pantalla de la operación, y el cliente solo puede liberar después.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

const { mockGetTrade, mockRevealTrade, mockGetTradeApi, mockCompleteTrade } = vi.hoisted(() => ({
  mockGetTrade: vi.fn(),
  mockRevealTrade: vi.fn(),
  mockGetTradeApi: vi.fn(),
  mockCompleteTrade: vi.fn(),
}));

vi.mock('../services/api', () => ({
  fetchTradeDetail: vi.fn(async (id: string, token: string) => {
    const trade = await mockGetTrade(id, token);
    return { trade, merchant_unavailable: false, seller_username: 'agente', buyer_username: 'cliente' };
  }),
  fetchRefundEligibility: vi.fn(async () => ({ eligible: false })),
  completeTrade: (...a: unknown[]) => mockCompleteTrade(...a),
  cancelTradeRequest: vi.fn(),
  refundTradeRequest: vi.fn(),
  lockTrade: vi.fn(),
  revealTrade: (...a: unknown[]) => mockRevealTrade(...a),
  getTrade: (...a: unknown[]) => mockGetTradeApi(...a),
}));
vi.mock('../services/payment', () => ({ ensureTrustline: vi.fn() }));
vi.mock('../services/secureStorage', () => ({ readJSON: vi.fn().mockResolvedValue(null) }));

import TradeDetail from '../pages/TradeDetail';
import DepositQR from '../pages/DepositQR';
import { canConfirmCashReceived, confirmCashReceived, cashConfirmErrorMessage } from '../utils/cashConfirm';
import { resolveTradeActor } from '../utils/tradeActor';

const CLIENT = 'user-client';
const PROVIDER = 'user-provider';

function trade(flow: 'cashout' | 'deposit', status = 'locked') {
  const cashout = flow === 'cashout';
  return {
    id: 'trade-123',
    status,
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

function axiosError(status: number) {
  return Object.assign(new Error(`HTTP ${status}`), { isAxiosError: true, response: { status, data: {} } });
}

function renderDetailAs(userId: string, flow: 'cashout' | 'deposit') {
  mockGetTrade.mockResolvedValue(trade(flow));
  return render(
    <MemoryRouter initialEntries={['/trade/trade-123']}>
      <Routes>
        <Route path="/trade/:id" element={<TradeDetail token="tok" userId={userId} onBack={() => {}} />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('canConfirmCashReceived', () => {
  it('only the provider of a locked deposit can confirm', () => {
    expect(canConfirmCashReceived(resolveTradeActor(PROVIDER, trade('deposit')), 'locked')).toBe(true);
    expect(canConfirmCashReceived(resolveTradeActor(CLIENT, trade('deposit')), 'locked')).toBe(false);
    expect(canConfirmCashReceived(resolveTradeActor(PROVIDER, trade('cashout')), 'locked')).toBe(false);
    expect(canConfirmCashReceived(resolveTradeActor(CLIENT, trade('cashout')), 'locked')).toBe(false);
    expect(canConfirmCashReceived(resolveTradeActor(PROVIDER, trade('deposit')), 'revealing')).toBe(false);
    expect(canConfirmCashReceived(resolveTradeActor('stranger', trade('deposit')), 'locked')).toBe(false);
  });
});

describe('confirmCashReceived', () => {
  it('calls reveal once on success', async () => {
    mockRevealTrade.mockResolvedValue(undefined);
    await confirmCashReceived('trade-123', 'tok');
    expect(mockRevealTrade).toHaveBeenCalledTimes(1);
    expect(mockRevealTrade).toHaveBeenCalledWith('trade-123', 'tok');
  });

  it('treats a 409 as success when the trade is already revealing', async () => {
    mockRevealTrade.mockRejectedValue(axiosError(409));
    mockGetTradeApi.mockResolvedValue({ status: 'revealing' });
    await expect(confirmCashReceived('trade-123', 'tok')).resolves.toBeUndefined();
  });

  it('keeps the 409 when the trade moved to another state', async () => {
    mockRevealTrade.mockRejectedValue(axiosError(409));
    mockGetTradeApi.mockResolvedValue({ status: 'cancelled' });
    await expect(confirmCashReceived('trade-123', 'tok')).rejects.toThrow('HTTP 409');
  });

  it('maps server refusals to Spanish copy', () => {
    expect(cashConfirmErrorMessage(axiosError(403))).toMatch(/no te toca confirmar/);
    expect(cashConfirmErrorMessage(axiosError(409))).toMatch(/ya no está esperando/);
  });
});

describe('TradeDetail · locked deposit', () => {
  it('the provider confirms in two steps and reveal is sent once', async () => {
    let resolveReveal: () => void = () => {};
    mockRevealTrade.mockImplementation(() => new Promise<void>((r) => { resolveReveal = r; }));
    renderDetailAs(PROVIDER, 'deposit');

    fireEvent.click(await screen.findByRole('button', { name: 'Recibí el efectivo' }));
    expect(mockRevealTrade).not.toHaveBeenCalled();
    expect(screen.getByText('¿Ya tienes el efectivo en la mano?')).toBeInTheDocument();

    const yes = screen.getByRole('button', { name: 'Sí, lo recibí' });
    fireEvent.click(yes);
    fireEvent.click(yes);
    await waitFor(() => expect(mockRevealTrade).toHaveBeenCalledTimes(1));
    expect(mockRevealTrade).toHaveBeenCalledWith('trade-123', 'tok');
    resolveReveal();
  });

  it('"Todavía no" goes back without calling reveal', async () => {
    renderDetailAs(PROVIDER, 'deposit');
    fireEvent.click(await screen.findByRole('button', { name: 'Recibí el efectivo' }));
    fireEvent.click(screen.getByRole('button', { name: 'Todavía no' }));
    expect(screen.getByRole('button', { name: 'Recibí el efectivo' })).toBeInTheDocument();
    expect(mockRevealTrade).not.toHaveBeenCalled();
  });

  it('shows the server refusal', async () => {
    mockRevealTrade.mockRejectedValue(axiosError(403));
    renderDetailAs(PROVIDER, 'deposit');
    fireEvent.click(await screen.findByRole('button', { name: 'Recibí el efectivo' }));
    fireEvent.click(screen.getByRole('button', { name: 'Sí, lo recibí' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/no te toca confirmar/);
  });

  it('the client of the deposit does not get the button', async () => {
    renderDetailAs(CLIENT, 'deposit');
    await screen.findByText(/fondos bloqueados/i);
    expect(screen.queryByRole('button', { name: 'Recibí el efectivo' })).toBeNull();
  });

  it('the provider of a cash-out does not get the button', async () => {
    renderDetailAs(PROVIDER, 'cashout');
    await screen.findByText(/fondos bloqueados/i);
    expect(screen.queryByRole('button', { name: 'Recibí el efectivo' })).toBeNull();
  });
});

describe('DepositQR · the client releases only after the agent confirms', () => {
  const renderQR = () =>
    render(
      <DepositQR
        activeTrade={trade('deposit', 'pending') as any}
        buyerToken="tok"
        viewerId={CLIENT}
        onBack={() => {}}
        onChat={() => {}}
        onSuccess={() => {}}
      />,
    );

  it('keeps the QR and disables release while the trade is locked', async () => {
    mockGetTradeApi.mockResolvedValue(trade('deposit', 'locked'));
    renderQR();
    const button = await screen.findByRole('button', { name: /esperando que el agente confirme/i });
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(mockCompleteTrade).not.toHaveBeenCalled();
    expect(document.querySelector('svg')).not.toBeNull();
  });

  it('enables release once the agent confirmed (revealing)', async () => {
    mockGetTradeApi.mockResolvedValue(trade('deposit', 'revealing'));
    mockCompleteTrade.mockResolvedValue({ release_tx_hash: 'tx' });
    renderQR();
    const button = await screen.findByRole('button', { name: /recibir mis activos/i });
    expect(button).toBeEnabled();
    fireEvent.click(button);
    await waitFor(() => expect(mockCompleteTrade).toHaveBeenCalledWith('trade-123', 'tok'));
  });
});
