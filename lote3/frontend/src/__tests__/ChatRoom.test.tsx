import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import ChatRoom from '../pages/ChatRoom';
import '../i18n';

const mockGetTrade = vi.fn();
const mockUseChatMessages = vi.fn();

vi.mock('../services/api', () => ({
  getTrade: (...args: unknown[]) => mockGetTrade(...args),
}));

vi.mock('../hooks/useChatMessages', () => ({
  useChatMessages: (...args: unknown[]) => mockUseChatMessages(...args),
}));

const defaultChatMessages = {
  messages: [],
  isLoading: false,
  error: null,
  sendMessage: vi.fn(),
  isSending: false,
  sendError: null,
  retryLoad: vi.fn(),
};

function renderChatRoom(overrides: Partial<React.ComponentProps<typeof ChatRoom>> = {}) {
  return render(
    <ChatRoom
      tradeId="trade-123"
      userId="user-1"
      onBack={vi.fn()}
      onViewQR={vi.fn()}
      token="mock-token"
      counterpartyName="Farmacia Guadalupe"
      {...overrides}
    />,
  );
}

describe('ChatRoom — role-specific cash-out banners', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseChatMessages.mockReturnValue(defaultChatMessages);
    mockGetTrade.mockResolvedValue({
      status: 'locked',
      amount_mxn: 1500,
      lock_tx_hash: 'abc123lockhash',
    });
  });

  it('shows the client banner when isProvider is false', async () => {
    renderChatRoom({ isProvider: false });

    await waitFor(() => {
      expect(screen.getByText(/Oferta aceptada · Tu saldo en garantía/i)).toBeInTheDocument();
    });
    expect(screen.getByText(/Bloqueaste tu saldo/i)).toBeInTheDocument();
    expect(screen.getByText(/te entregará el efectivo/i)).toBeInTheDocument();
    expect(screen.queryByText(/El cliente bloqueó/i)).not.toBeInTheDocument();
  });

  it('shows the agent banner when isProvider is true', async () => {
    renderChatRoom({ isProvider: true });

    await waitFor(() => {
      expect(screen.getByText(/Cliente conectado · Saldo en garantía/i)).toBeInTheDocument();
    });
    expect(screen.getByText(/El cliente bloqueó 1,500 MXN en garantía/i)).toBeInTheDocument();
    expect(screen.getByText(/Entrégale el efectivo/i)).toBeInTheDocument();
    expect(screen.queryByText(/Bloqueaste tu saldo/i)).not.toBeInTheDocument();
  });

  it('shows pending copy for the agent while escrow is not locked yet', async () => {
    mockGetTrade.mockResolvedValue({
      status: 'pending',
      amount_mxn: 1500,
      lock_tx_hash: null,
    });

    renderChatRoom({ isProvider: true });

    await waitFor(() => {
      expect(screen.getByText(/Esperando garantía del cliente/i)).toBeInTheDocument();
    });
    expect(screen.getByText(/El cliente está bloqueando su saldo/i)).toBeInTheDocument();
  });

  it('shows the scan-client QR action only for the agent when locked', async () => {
    renderChatRoom({ isProvider: true });

    await waitFor(() => {
      expect(screen.getByText(/Escanear QR del cliente/i)).toBeInTheDocument();
    });
  });
});
