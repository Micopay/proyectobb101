/**
 * RED-2 · Las dos incorporaciones, y por que no son la misma.
 *
 * MicoPay tiene dos: la de PERSONA es de comprension y no cambia nada en el
 * servidor; la de AGENTE es un alta y publica a alguien en un mapa. Confundirlas
 * fue el defecto de origen — `merchant_available` nacia en true, asi que abrir
 * una cuenta te convertia en proveedora de efectivo sin decidirlo — y la barra
 * inferior lo repetia mostrando la superficie de agente a `!!sessionUser`, o sea
 * "hay sesion" disfrazado de "es proveedora".
 *
 * Lo que se fija aqui:
 *   1. La pestana de agente depende de la pertenencia REAL, nunca de la sesion.
 *   2. Unirse ≠ activarse ≠ estar disponible: tres decisiones separadas.
 *   3. La elegibilidad la decide el servidor; la app no la deduce.
 *   4. La incorporacion de persona explica el producto, no solo la wallet.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import i18n from '../i18n';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import BottomNav from '../components/BottomNav';
import Welcome from '../pages/Welcome';
import ProviderOnboarding from '../pages/ProviderOnboarding';
import type { ProviderReadiness } from '../services/api';

const mockEnroll = vi.fn();
const mockReadiness = vi.fn();
const mockActivate = vi.fn();

vi.mock('../services/api', () => ({
  enrollAsProvider: (...a: unknown[]) => mockEnroll(...a),
  fetchProviderReadiness: (...a: unknown[]) => mockReadiness(...a),
  activateProvider: (...a: unknown[]) => mockActivate(...a),
}));

function readiness(over: Partial<ProviderReadiness> = {}): ProviderReadiness {
  return {
    status: 'pending_verification',
    can_activate: false,
    items: [
      { key: 'kyc', done: false, detail: 'Se necesita verificacion nivel 1 (actual: 0).' },
      { key: 'location', done: false, detail: 'Falta la zona.' },
      { key: 'limits', done: false, detail: 'Revisa y confirma tus montos.' },
    ],
    availability: 'paused',
    merchant_available: false,
    required_kyc_level: 1,
    kyc_level: 0,
    kyc_provider: null,
    ...over,
  };
}

const complete = readiness({
  can_activate: true,
  items: [
    { key: 'kyc', done: true, detail: null },
    { key: 'location', done: true, detail: null },
    { key: 'limits', done: true, detail: null },
  ],
});

beforeEach(async () => {
  await i18n.changeLanguage('es');
  vi.clearAllMocks();
  mockEnroll.mockResolvedValue(readiness());
  mockReadiness.mockResolvedValue(readiness());
  mockActivate.mockResolvedValue(readiness({ status: 'active', can_activate: false }));
});

// ── 1. La barra inferior no confunde sesion con pertenencia ────────────────

describe('la pestaña de agente', () => {
  const nav = (show: boolean) =>
    render(<BottomNav currentPage="home" onNavigate={() => {}} showProviderTab={show} />);

  it('no se muestra a quien no es agente', () => {
    const { container } = nav(false);
    // La pestaña de bandeja es la superficie de agente.
    expect(container.querySelectorAll('button').length).toBeGreaterThan(0);
    expect(screen.queryByLabelText(/nav\.inbox|bandeja/i)).toBeNull();
  });

  it('se muestra a un agente activo', () => {
    nav(true);
    expect(screen.getByLabelText(/nav\.inbox|bandeja/i)).toBeInTheDocument();
  });
});

/**
 * Los dos casos de arriba prueban el COMPONENTE con una prop, y eso no basta:
 * el defecto real vivia en el cableado — `showProviderTab={!!sessionUser}`, o
 * sea "hay sesion" disfrazado de "es proveedora". Comprobado inyectando esa
 * linea de vuelta: los dos casos anteriores seguian en verde.
 *
 * Asi que este lee la fuente. No es elegante, pero montar App entero para una
 * linea lo es menos, y vitest no comprueba tipos: una asercion de tipos aqui
 * pasaria con el defecto puesto.
 */
describe('el cableado de la pestaña de agente en App.tsx', () => {
  const source = readFileSync(join(process.cwd(), 'src/App.tsx'), 'utf8');

  it('no alimenta la pestaña desde la sesión', () => {
    expect(source).not.toMatch(/showProviderTab=\{!!\s*sessionUser\}/);
  });

  it('la alimenta desde la pertenencia real a Red MicoPay', () => {
    expect(source).toMatch(/showProviderTab=\{providerStatus === 'active'\}/);
  });
});

// ── 2. Unirse, activarse y estar disponible son decisiones distintas ───────

describe('el alta como agente', () => {
  const renderFlow = () =>
    render(
      <ProviderOnboarding
        token="tok"
        onExit={() => {}}
        onOpenKyc={() => {}}
        onOpenSettings={() => {}}
      />,
    );

  it('renderiza el copy de onboarding en inglés', async () => {
    await i18n.changeLanguage('en');
    renderFlow();

    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'Join the MicoPay Network' })).toBeInTheDocument(),
    );
    expect(screen.getByText(/Give cash to people who need it/i)).toBeInTheDocument();
  });

  it('no da de alta a nadie por abrir la pantalla', async () => {
    renderFlow();
    await waitFor(() => expect(mockReadiness).toHaveBeenCalled());
    // Leer la invitación no puede inscribirte: eso es exactamente el defecto
    // que RED-1 vino a arreglar, un paso más arriba.
    expect(mockEnroll).not.toHaveBeenCalled();
  });

  it('se da de alta solo cuando la persona avanza explícitamente', async () => {
    mockReadiness.mockResolvedValue(readiness({ status: 'not_enrolled' }));
    renderFlow();

    await waitFor(() => expect(screen.getByText(/Únete a Red MicoPay/i)).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /quiero unirme/i }));

    await waitFor(() => expect(mockEnroll).toHaveBeenCalledWith('tok'));
  });

  it('no deja activarse mientras el servidor diga que falta algo', async () => {
    renderFlow();
    await waitFor(() => expect(mockReadiness).toHaveBeenCalled());

    // Avanzar hasta la lista.
    fireEvent.click(screen.getByRole('button', { name: /continuar|quiero unirme/i }));
    await waitFor(() => expect(screen.getByText(/Lo que implica/i)).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /continuar/i }));

    await waitFor(() => expect(screen.getByText(/Lo que falta/i)).toBeInTheDocument());
    const activar = screen.getByRole('button', { name: /activarme como agente/i });
    expect(activar).toBeDisabled();
    expect(mockActivate).not.toHaveBeenCalled();
  });

  it('deja activarse cuando el servidor dice que sí, y no antes', async () => {
    mockReadiness.mockResolvedValue(complete);
    renderFlow();
    await waitFor(() => expect(mockReadiness).toHaveBeenCalled());

    fireEvent.click(screen.getByRole('button', { name: /continuar|quiero unirme/i }));
    await waitFor(() => expect(screen.getByText(/Lo que implica/i)).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /continuar/i }));

    const activar = await screen.findByRole('button', { name: /activarme como agente/i });
    expect(activar).not.toBeDisabled();
    fireEvent.click(activar);
    await waitFor(() => expect(mockActivate).toHaveBeenCalledWith('tok'));
  });

  /**
   * Activarse no es publicarse. El servidor deja al agente en pausa a
   * proposito, y la ultima pantalla tiene que decirlo: si la persona cree que
   * ya esta recibiendo solicitudes y no lo esta, la app le mintio.
   */
  it('dice que todavía no aparece en el mapa tras activarse', async () => {
    mockReadiness.mockResolvedValue(complete);
    renderFlow();
    await waitFor(() => expect(mockReadiness).toHaveBeenCalled());

    fireEvent.click(screen.getByRole('button', { name: /continuar|quiero unirme/i }));
    await waitFor(() => expect(screen.getByText(/Lo que implica/i)).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /continuar/i }));
    fireEvent.click(await screen.findByRole('button', { name: /activarme como agente/i }));

    await waitFor(() => expect(screen.getByText(/ya eres agente/i)).toBeInTheDocument());
    expect(screen.getByText(/todavía no apareces en el mapa/i)).toBeInTheDocument();
  });

  it('la lista de pendientes la redacta el servidor, no la app', async () => {
    mockReadiness.mockResolvedValue(
      readiness({
        items: [
          { key: 'kyc', done: false, detail: 'La verificacion de etherfuse no habilita Red MicoPay.' },
          { key: 'location', done: true, detail: null },
          { key: 'limits', done: true, detail: null },
        ],
      }),
    );
    renderFlow();
    await waitFor(() => expect(mockReadiness).toHaveBeenCalled());

    fireEvent.click(screen.getByRole('button', { name: /continuar|quiero unirme/i }));
    await waitFor(() => expect(screen.getByText(/Lo que implica/i)).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /continuar/i }));

    // El motivo exacto llega del servidor: es quien sabe por qué falta.
    expect(await screen.findByText(/etherfuse no habilita/i)).toBeInTheDocument();
  });
});

// ── 3. La incorporación de persona explica el producto ─────────────────────

describe('la bienvenida a una persona', () => {
  const renderWelcome = () => {
    const onDone = vi.fn();
    render(<Welcome username="erick" onDone={onDone} />);
    return onDone;
  };

  const advanceThroughAll = async () => {
    // Cinco pasos; se recorren todos para comprobar el contenido de cada uno.
    for (let i = 0; i < 4; i++) {
      fireEvent.click(screen.getByRole('button', { name: /continuar|entendido/i }));
      await waitFor(() => {});
    }
  };

  it('advierte de que la llave se puede perder para siempre', () => {
    renderWelcome();
    expect(screen.getByText(/nadie puede devolverte tus fondos/i)).toBeInTheDocument();
  });

  it('explica el escrow y el encuentro presencial, no solo la wallet', async () => {
    renderWelcome();
    await advanceThroughAll();

    // Este es el hueco que P0-5 dejó abierto: sus seis criterios hablaban solo
    // de la llave. Nadie explicaba qué es un cash-out ni que hay un encuentro.
    expect(screen.getByText(/código QR/i)).toBeInTheDocument();
    expect(screen.getByText(/lugar público/i)).toBeInTheDocument();
  });

  it('se puede saltar: no es una trampa', () => {
    const onDone = renderWelcome();
    fireEvent.click(screen.getByRole('button', { name: /saltar/i }));
    expect(onDone).toHaveBeenCalled();
  });

  it('anuncia el progreso para lectores de pantalla', () => {
    renderWelcome();
    expect(screen.getByText(/paso 1 de 5/i)).toBeInTheDocument();
  });
});
