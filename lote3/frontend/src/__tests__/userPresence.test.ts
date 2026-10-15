/**
 * Nada que mueva dinero se firma sin que la persona lo confirme.
 *
 * EL HUECO
 * --------
 * La llave vivia en el almacenamiento seguro del sistema, pero
 * `signTransactionXdr` la leia y firmaba **sin preguntar nada**. Con la app
 * abierta, cualquier camino que llegara ahi movia dinero: un telefono
 * desbloqueado en manos ajenas bastaba, y no habia ningun momento en el que la
 * persona dijera "esta operacion la autorizo yo".
 *
 * LO QUE ESTA SUITE FIJA, Y LO QUE NO
 * -----------------------------------
 * Fija la compuerta de INTENCION: que se pregunta antes de firmar, que un "no"
 * cancela de verdad, y que no se pregunta donde no hay dinero de por medio.
 *
 * NO prueba que la llave este protegida criptograficamente por la biometria:
 * no lo esta. La llave Ed25519 sigue siendo legible por el codigo de la app.
 * Para eso hace falta envolverla con una clave del keystore que exija
 * autenticacion del sistema, que es el paso siguiente. Decirlo aqui evita que
 * alguien lea estos tests como una garantia que no dan.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockAuthenticate = vi.fn();
const mockCheckBiometry = vi.fn();
let isNative = true;

vi.mock('@capacitor/core', () => ({
  Capacitor: { isNativePlatform: () => isNative },
}));
vi.mock('@aparajita/capacitor-biometric-auth', () => ({
  BiometricAuth: {
    authenticate: (...a: unknown[]) => mockAuthenticate(...a),
    checkBiometry: (...a: unknown[]) => mockCheckBiometry(...a),
  },
}));

async function freshModule() {
  vi.resetModules();
  return import('../lib/userPresence');
}

beforeEach(() => {
  vi.clearAllMocks();
  isNative = true;
  mockCheckBiometry.mockResolvedValue({ isAvailable: true, deviceIsSecure: true });
  mockAuthenticate.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('la compuerta antes de firmar', () => {
  it('pregunta antes de una operación con dinero', async () => {
    const { requireUserPresence } = await freshModule();
    await requireUserPresence('lock');
    expect(mockAuthenticate).toHaveBeenCalledTimes(1);
  });

  it('dice QUÉ se va a autorizar, no un mensaje genérico', async () => {
    const { requireUserPresence } = await freshModule();
    await requireUserPresence('release');
    const opts = mockAuthenticate.mock.calls[0][0] as { reason: string };
    expect(opts.reason).toMatch(/liberar/i);

    await requireUserPresence('reveal_key', true);
    const opts2 = mockAuthenticate.mock.calls[1][0] as { reason: string };
    expect(opts2.reason).toMatch(/llave/i);
    // Un diálogo que solo dice "confirma" enseña a confirmar sin leer.
    expect(opts.reason).not.toBe(opts2.reason);
  });

  it('una negativa CANCELA: no se firma igual', async () => {
    const { requireUserPresence, PresenceDeniedError } = await freshModule();
    mockAuthenticate.mockRejectedValue(new Error('user cancelled'));
    await expect(requireUserPresence('payment')).rejects.toBeInstanceOf(PresenceDeniedError);
  });

  /**
   * Si un error del sistema se interpretara como "adelante", la compuerta seria
   * decorativa: bastaria provocar un fallo para saltarsela.
   */
  it('un fallo del sistema se trata como negativa, nunca como permiso', async () => {
    const { requireUserPresence, PresenceDeniedError } = await freshModule();
    mockAuthenticate.mockRejectedValue(new Error('hardware unavailable'));
    await expect(requireUserPresence('lock')).rejects.toBeInstanceOf(PresenceDeniedError);
  });

  it('acepta PIN o patrón, no solo huella', async () => {
    const { requireUserPresence } = await freshModule();
    await requireUserPresence('lock');
    const opts = mockAuthenticate.mock.calls[0][0] as { allowDeviceCredential: boolean };
    // Lo que se busca es presencia de la persona, no un biométrico concreto:
    // exigir huella dejaría fuera a quien no la tiene configurada.
    expect(opts.allowDeviceCredential).toBe(true);
  });
});

describe('cuándo NO se pregunta', () => {
  /**
   * Estos fondos son de la persona. Dejarla fuera de su propio dinero por no
   * tener bloqueo de pantalla configurado seria un fallo peor que el que la
   * compuerta intenta evitar.
   */
  it('un teléfono sin biometría ni PIN no bloquea a su dueño', async () => {
    const { requireUserPresence } = await freshModule();
    mockCheckBiometry.mockResolvedValue({ isAvailable: false, deviceIsSecure: false });
    await expect(requireUserPresence('payment')).resolves.toBeUndefined();
    expect(mockAuthenticate).not.toHaveBeenCalled();
  });

  it('en web no se simula una protección que no existe', async () => {
    isNative = false;
    const { requireUserPresence } = await freshModule();
    await requireUserPresence('lock');
    expect(mockAuthenticate).not.toHaveBeenCalled();
  });
});

describe('la ventana de gracia', () => {
  /**
   * Un solo gesto —"enviar pago"— puede encadenar varias firmas (crear la
   * trustline y luego pagar). Preguntar dos veces por la misma accion enseña a
   * confirmar sin leer, que es lo contrario de lo que se busca.
   */
  it('un gesto que encadena firmas pregunta una sola vez', async () => {
    const { requireUserPresence } = await freshModule();
    await requireUserPresence('payment');
    await requireUserPresence('payment');
    expect(mockAuthenticate).toHaveBeenCalledTimes(1);
  });

  it('pero caduca: no cubre una sesión entera', async () => {
    vi.useFakeTimers();
    const { requireUserPresence } = await freshModule();
    await requireUserPresence('payment');
    vi.advanceTimersByTime(61_000);
    await requireUserPresence('payment');
    expect(mockAuthenticate).toHaveBeenCalledTimes(2);
  });

  it('ver la llave secreta SIEMPRE pregunta, aunque acabes de confirmar', async () => {
    const { requireUserPresence } = await freshModule();
    await requireUserPresence('payment');
    await requireUserPresence('reveal_key', true);
    // Es el secreto de mayor valor: quien lo ve puede vaciar la cuenta desde
    // otro dispositivo, y eso no se hereda de haber pagado hace un momento.
    expect(mockAuthenticate).toHaveBeenCalledTimes(2);
  });

  it('salir de la app invalida la confirmación', async () => {
    const { requireUserPresence, resetPresence } = await freshModule();
    await requireUserPresence('payment');
    // Volver a primer plano es un contexto nuevo: puede que quien vuelve no sea
    // quien se fue.
    resetPresence();
    await requireUserPresence('payment');
    expect(mockAuthenticate).toHaveBeenCalledTimes(2);
  });
});
