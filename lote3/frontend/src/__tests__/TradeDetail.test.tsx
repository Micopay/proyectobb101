import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import TradeDetail from '../pages/TradeDetail';

const mockGetTrade = vi.fn();
const mockCompleteTrade = vi.fn();

// Mock the API module
vi.mock('../services/api', () => ({
  fetchTradeDetail: vi.fn(async (id, token) => {
    const trade = await mockGetTrade(id, token);
    return { trade, merchant_unavailable: false, seller_username: 'seller-username' };
  }),
  completeTrade: (...args: unknown[]) => mockCompleteTrade(...args),
  cancelTradeRequest: vi.fn(),
  refundTradeRequest: vi.fn(),
  lockTrade: vi.fn(),
}));

vi.mock('../services/payment', () => ({
  ensureTrustline: vi.fn(),
}));

// La sesión vive en secure storage (Keychain/Keystore en nativo) bajo la clave
// `micopay_user` con shape plano — no en `localStorage.micopay_users`, que era
// el artefacto de doble identidad del demo (SEC-22, SEC-26 y el fix del
// interceptor 401 en docs/AUDIT_MOBILE_MAINNET.md §2).
const mockReadJSON = vi.fn(async () => ({ id: 'buyer-1', token: 'mock-token' }));

vi.mock('../services/secureStorage', () => ({
  readJSON: (...args: unknown[]) => mockReadJSON(...(args as [])),
  writeJSON: vi.fn(),
  removeKey: vi.fn(),
}));

// Robust localStorage mock for tests
const store: Record<string, string> = {};
const mockLocalStorage = {
  getItem: vi.fn((key: string) => store[key] || null),
  setItem: vi.fn((key: string, value: string) => { store[key] = value.toString(); }),
  removeItem: vi.fn((key: string) => { delete store[key]; }),
  clear: vi.fn(() => { for (const k in store) { delete store[k]; } }),
  key: vi.fn((index: number) => Object.keys(store)[index] || null),
  length: 0,
};
Object.defineProperty(mockLocalStorage, 'length', {
  get: () => Object.keys(store).length,
});
global.localStorage = mockLocalStorage as any;
if (global.window) {
  Object.defineProperty(global.window, 'localStorage', {
    value: mockLocalStorage,
    writable: true,
  });
}


const createMockTrade = (status: string) => ({
  id: 'trade-123',
  status,
  secret_hash: 'abc123',
  amount_mxn: 500,
  platform_fee_mxn: 4,
  lock_tx_hash: status !== 'pending' ? 'mock_lock_hash' : null,
  release_tx_hash: status === 'completed' ? 'mock_release_hash' : null,
  created_at: '2024-01-01T10:00:00Z',
  completed_at: status === 'completed' ? '2024-01-01T10:30:00Z' : null,
  expires_at: '2024-01-01T12:00:00Z',
  seller_id: 'seller-1',
  buyer_id: 'buyer-1',
});

const renderWithRouter = (route: string = '/trade/trade-123') => {
  return render(
    <MemoryRouter initialEntries={[route]}>
      <Routes>
        <Route path="/trade/:id" element={<TradeDetail />} />
        <Route path="/login" element={<div>Login Page</div>} />
        <Route path="/" element={<div>Home Page</div>} />
      </Routes>
    </MemoryRouter>
  );
};

describe('TradeDetail', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });

  describe('Route registration', () => {
    it('should render TradeDetail when navigating to /trade/:id', async () => {
        mockGetTrade.mockResolvedValue(createMockTrade('pending'));

      renderWithRouter('/trade/test-trade-id');

      await waitFor(() => {
        expect(screen.getByText(/cargando operación/i)).toBeInTheDocument();
      });

      await waitFor(() => {
        expect(screen.getByText(/detalle de operación/i)).toBeInTheDocument();
      });
    });

    it('should correctly read trade ID from URL params', async () => {
        mockGetTrade.mockResolvedValue(createMockTrade('pending'));

      renderWithRouter('/trade/unique-trade-456');

      await waitFor(() => {
        expect(mockGetTrade).toHaveBeenCalledWith('unique-trade-456', 'mock-token');
      });
    });
  });

  describe('State rendering', () => {
    it('should render pending state with cancel button', async () => {
      mockGetTrade.mockResolvedValue(createMockTrade('pending'));

      renderWithRouter();

      await waitFor(() => {
        expect(screen.getByText('Pendiente')).toBeInTheDocument();
        expect(screen.getByText(/esperando al vendedor/i)).toBeInTheDocument();
        expect(screen.getByText(/cancelar operación/i)).toBeInTheDocument();
      });
    });

    it('should render locked state with chat button', async () => {
      mockGetTrade.mockResolvedValue(createMockTrade('locked'));

      renderWithRouter();

      await waitFor(() => {
        expect(screen.getByText('Bloqueado')).toBeInTheDocument();
        expect(screen.getByText(/fondos bloqueados/i)).toBeInTheDocument();
        expect(screen.getByText(/abrir chat con el vendedor/i)).toBeInTheDocument();
      });
    });

    /**
     * CASH-5B: `revealing` ya no tiene una vista unica. El paso siguiente
     * depende del flujo y de quien mira, asi que este caso solo comprueba
     * que la pantalla identifica el estado; las cuatro combinaciones y sus
     * acciones viven en `revealingActions.test.tsx`.
     *
     * Este trade de prueba no trae `flow` ni `provider_id` y se renderiza sin
     * sesion, asi que el actor es un observador: la vista correcta es la de
     * espera, sin ninguna accion de liberar. Que sea justamente esa es la
     * comprobacion valiosa aqui.
     */
    it('should render revealing state without exposing an action to an observer', async () => {
      mockGetTrade.mockResolvedValue(createMockTrade('revealing'));

      renderWithRouter();

      await waitFor(() => {
        expect(screen.getByText('Revelando')).toBeInTheDocument();
      });
      expect(screen.queryByRole('button', { name: /ya entregué|escanear|ver mi código/i })).toBeNull();
    });


    it('should render completed state with summary', async () => {
      mockGetTrade.mockResolvedValue(createMockTrade('completed'));

      renderWithRouter();

      await waitFor(() => {
        expect(screen.getByText('Completado')).toBeInTheDocument();
        expect(screen.getByText(/operación completada/i)).toBeInTheDocument();
        expect(screen.getByText(/volver al inicio/i)).toBeInTheDocument();
      });
    });

    it('should render cancelled state when no funds were ever locked', async () => {
      mockGetTrade.mockResolvedValue({
        ...createMockTrade('cancelled'),
        lock_tx_hash: null,
      });

      renderWithRouter();

      await waitFor(() => {
        expect(screen.getByText('Cancelado')).toBeInTheDocument();
        expect(screen.getByText(/operación cancelada/i)).toBeInTheDocument();
        expect(screen.getByText(/volver al inicio/i)).toBeInTheDocument();
      });
    });

    // Finding B3 de docs/AUDIT_MOBILE_MAINNET.md: cancelar un trade ya
    // bloqueado dejaba los fondos atrapados sin ruta de recuperación. Ahora esa
    // combinación (lock sin release) ofrece el refund a cualquiera de los dos
    // participantes.
    it('should offer refund for a cancelled trade with funds still locked', async () => {
      mockGetTrade.mockResolvedValue(createMockTrade('cancelled'));

      renderWithRouter();

      await waitFor(() => {
        expect(screen.getByText(/reembolso pendiente/i)).toBeInTheDocument();
        expect(screen.getByText(/recuperarlos ahora/i)).toBeInTheDocument();
        expect(screen.getByText(/recuperar fondos/i)).toBeInTheDocument();
      });
    });

    it('should render expired state', async () => {
      mockGetTrade.mockResolvedValue(createMockTrade('expired'));

      renderWithRouter();

      await waitFor(() => {
        expect(screen.getByText('Expirado')).toBeInTheDocument();
        expect(screen.getByText(/expirada/i)).toBeInTheDocument();
        expect(screen.getByText(/volver al inicio/i)).toBeInTheDocument();
      });
    });
  });

  // docs/AUDIT_MOBILE_MAINNET.md §4: "RevealedView muestra éxito aunque
  // completeTrade falle". La pantalla no debe declarar liberados unos fondos
  // que siguen en el contrato.
  // CASH-5B: aqui vivia `describe('Confirmación de recepción')`. Sus casos
  // montaban el estado inventado `revealed`, asi que probaban una vista
  // inalcanzable en produccion. La accion existe y ahora se prueba con el
  // actor correcto en `revealingActions.test.tsx`, para las cuatro
  // combinaciones de flujo y participante.


  /**
   * H2 (docs/AUDITORIA_IMPLEMENTACION_SELECTOR_ACTIVO_2026-09-14.md): el
   * polling se apagaba al pasar a `cancelled`. Una cancelada con bloqueo espera
   * el reembolso, y la pantalla seguia diciendo "Reembolso pendiente" despues
   * de que el servidor ya lo habia registrado.
   */
  describe('Polling hasta que se liquide', () => {
    it('refreshes a cancelled trade with funds locked until the refund lands', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      try {
        mockGetTrade
          .mockResolvedValueOnce(createMockTrade('cancelled'))
          .mockResolvedValue({ ...createMockTrade('refunded'), release_tx_hash: 'refund_tx' });

        renderWithRouter();
        await waitFor(() => expect(screen.getByText(/reembolso pendiente/i)).toBeInTheDocument());

        await vi.advanceTimersByTimeAsync(5000);
        await waitFor(() => expect(screen.queryByText(/reembolso pendiente/i)).toBeNull());
        expect(screen.getByText('Reembolsado')).toBeInTheDocument();

        // Ya liquidada: no sigue consultando.
        const calls = mockGetTrade.mock.calls.length;
        await vi.advanceTimersByTimeAsync(15000);
        expect(mockGetTrade.mock.calls.length).toBe(calls);
      } finally {
        vi.useRealTimers();
      }
    });

    it('does not poll a cancelled trade that never locked funds', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      try {
        mockGetTrade.mockResolvedValue({ ...createMockTrade('cancelled'), lock_tx_hash: null });
        renderWithRouter();
        await waitFor(() => expect(screen.getByText(/operación cancelada/i)).toBeInTheDocument());
        const calls = mockGetTrade.mock.calls.length;
        await vi.advanceTimersByTimeAsync(15000);
        expect(mockGetTrade.mock.calls.length).toBe(calls);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  /**
   * H3: el bloqueo no envia ninguna transaccion previa del cliente y toma el
   * activo de la operacion, no de VITE_ESCROW_ASSET_CODE.
   */
  describe('Bloqueo y activo de la operación', () => {
    // La sesion de vendedor no debe filtrarse a otras pruebas aunque una falle.
    afterEach(() => {
      mockReadJSON.mockResolvedValue({ id: 'buyer-1', token: 'mock-token' });
    });

    const renderAsSeller = async (assetCode: string | undefined) => {
      mockReadJSON.mockResolvedValue({ id: 'seller-1', token: 'mock-token' });
      mockGetTrade.mockResolvedValue({ ...createMockTrade('pending'), asset_code: assetCode });
      renderWithRouter();
      const button = await screen.findByRole('button', { name: /bloquear fondos/i });
      fireEvent.click(button);
    };

    it('XLM: pide el bloqueo sin crear trustline', async () => {
      const api = await import('../services/api');
      const payment = await import('../services/payment');
      await renderAsSeller('XLM');
      await waitFor(() => expect(api.lockTrade).toHaveBeenCalledWith('trade-123', 'mock-token'));
      expect(payment.ensureTrustline).not.toHaveBeenCalled();
    });

    it('otro activo: se detiene antes de firmar o pedir el bloqueo', async () => {
      const api = await import('../services/api');
      const payment = await import('../services/payment');
      await renderAsSeller('USDC');
      await waitFor(() =>
        expect(screen.getByText(/activo que la app todavía no puede bloquear/i)).toBeInTheDocument(),
      );
      expect(api.lockTrade).not.toHaveBeenCalled();
      expect(payment.ensureTrustline).not.toHaveBeenCalled();
    });

    it('respuesta sin asset_code: no inventa el activo y deja decidir al servidor', async () => {
      const api = await import('../services/api');
      await renderAsSeller(undefined);
      await waitFor(() => expect(api.lockTrade).toHaveBeenCalled());
    });
  });

  describe('Error handling', () => {
    it('should show 404 screen when trade is not found', async () => {
      const error = new Error('Not found');
      (error as any).response = { status: 404 };
      mockGetTrade.mockRejectedValue(error);

      renderWithRouter();

      await waitFor(() => {
        expect(screen.getByText(/Algo salió mal/i)).toBeInTheDocument();
        expect(screen.getByText(/La operación que buscas no existe o fue eliminada/i)).toBeInTheDocument();
        expect(screen.getByText(/volver al inicio/i)).toBeInTheDocument();
      });
    });

    it('should show 403 screen when user is not a participant', async () => {
      const error = new Error('Forbidden');
      (error as any).response = { status: 403 };
      mockGetTrade.mockRejectedValue(error);

      renderWithRouter();

      await waitFor(() => {
        expect(screen.getByText(/no tienes acceso/i)).toBeInTheDocument();
        expect(screen.getByText(/no tienes permiso para ver esta operación/i)).toBeInTheDocument();
        expect(screen.getByText(/volver al inicio/i)).toBeInTheDocument();
      });
    });

    it('should show network error with retry button on connection failure', async () => {
      const error = new Error('Network error');
      (error as any).response = { status: 500 };
      mockGetTrade.mockRejectedValue(error);

      renderWithRouter();

      await waitFor(() => {
        expect(screen.getByText(/sin conexión/i)).toBeInTheDocument();
        expect(screen.getByText(/reintentar/i)).toBeInTheDocument();
      });
    });
  });

  describe('Auth recovery', () => {
    it('should redirect to home when not authenticated', async () => {
      mockReadJSON.mockResolvedValueOnce(null as never);

      renderWithRouter('/trade/trade-123');

      await waitFor(() => {
        expect(screen.getByText('Home Page')).toBeInTheDocument();
      });
    });

    it('should not redirect when user is authenticated', async () => {
        mockGetTrade.mockResolvedValue(createMockTrade('pending'));

      renderWithRouter('/trade/trade-123');

      await waitFor(() => {
        expect(screen.getByText(/detalle de operación/i)).toBeInTheDocument();
        expect(screen.queryByText('Home Page')).not.toBeInTheDocument();
      });
    });
  });

  describe('Support link visibility', () => {
    const states = ['pending', 'locked', 'revealing'];

    states.forEach((state) => {
      it(`should show support link in ${state} state`, async () => {
        mockGetTrade.mockResolvedValue(createMockTrade(state));

        renderWithRouter();

        await waitFor(() => {
          expect(screen.getByText(/¿necesitas ayuda\?/i)).toBeInTheDocument();
          expect(screen.getByText(/contactar soporte/i)).toBeInTheDocument();
        });
      });
    });

    it('should not show support link in completed state', async () => {
      mockGetTrade.mockResolvedValue(createMockTrade('completed'));

      renderWithRouter();

      await waitFor(() => {
        expect(screen.getByText(/operación completada/i)).toBeInTheDocument();
        expect(screen.queryByText(/¿necesitas ayuda\?/i)).not.toBeInTheDocument();
      });
    });

    it('should show support link in 404 error state', async () => {
      const error = new Error('Not found');
      (error as any).response = { status: 404 };
      mockGetTrade.mockRejectedValue(error);

      renderWithRouter();

      await waitFor(() => {
        expect(screen.getByText(/contactar soporte/i)).toBeInTheDocument();
      });
    });

    it('should show support link in 403 error state', async () => {
      const error = new Error('Forbidden');
      (error as any).response = { status: 403 };
      mockGetTrade.mockRejectedValue(error);

      renderWithRouter();

      await waitFor(() => {
        expect(screen.getByText(/contactar soporte/i)).toBeInTheDocument();
      });
    });
  });
});
