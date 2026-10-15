/**
 * Confirmacion de la persona antes de firmar.
 *
 * EL HUECO QUE CIERRA
 * -------------------
 * La llave vive en el almacenamiento seguro del sistema, pero `signTransactionXdr`
 * la leia y firmaba **sin preguntar nada**. Con la app abierta, cualquier toque
 * que llegara a esa ruta movia dinero: un telefono desbloqueado en manos ajenas
 * bastaba para vaciar la cuenta, y no habia ningun momento en el que la persona
 * dijera "si, esta operacion la autorizo yo".
 *
 * LO QUE ESTO ES, Y LO QUE NO
 * ---------------------------
 * Esto es una **compuerta de intencion**, no custodia de la llave. La llave
 * Ed25519 sigue siendo legible por el codigo de la app; la biometria protege el
 * camino de la interfaz, no el material criptografico.
 *
 * Decirlo importa: vender esto como "tu llave esta protegida con tu huella"
 * seria exagerar. Para eso hace falta envolver la llave con una clave del
 * keystore creada con `setUserAuthenticationRequired(true)`, de modo que
 * descifrarla exija autenticacion a nivel del sistema operativo. Es el
 * siguiente paso, y necesita un plugin nativo propio.
 *
 * (La tercera via —passkeys y smart accounts, donde la llave nunca existe en
 * memoria— esta descartada para retail: una direccion `C…` no puede recibir un
 * retiro de Bitso, y en Mexico eso deja al usuario con fondos que no puede
 * sacar. Ver la nota en el commit del 2026-09-05.)
 *
 * POR QUE NO SE BLOQUEA A QUIEN NO TIENE BIOMETRIA
 * ------------------------------------------------
 * Si el telefono no tiene huella ni PIN configurados, se permite firmar. Estos
 * fondos son de la persona: dejarla fuera de su propio dinero por no haber
 * configurado un bloqueo de pantalla seria un fallo peor que el que se intenta
 * evitar. Se registra el caso y se sigue.
 */

import { Capacitor } from '@capacitor/core';

/** Motivo que se le muestra a la persona. Concreto, nunca generico. */
export type PresenceReason =
  | 'lock'
  | 'release'
  | 'payment'
  | 'reveal_key'
  | 'sign_request';

const PROMPTS: Record<PresenceReason, string> = {
  lock: 'Confirma para bloquear tu dinero en garantía',
  release: 'Confirma para liberar el dinero',
  payment: 'Confirma para enviar el pago',
  reveal_key: 'Confirma para ver tu llave secreta',
  sign_request: 'Confirma para autorizar esta operación',
};

export class PresenceDeniedError extends Error {
  constructor() {
    super('El usuario canceló la confirmación');
    this.name = 'PresenceDeniedError';
  }
}

/**
 * Ventana de gracia. Un solo gesto de la persona —"enviar pago"— puede pasar por
 * varias firmas encadenadas (crear la trustline y luego pagar, por ejemplo).
 * Pedir huella dos veces seguidas por la misma accion enseña a la gente a
 * confirmar sin leer, que es justo lo contrario de lo que se busca.
 *
 * 60 segundos: cubre un encadenamiento, no una sesion.
 */
const GRACE_MS = 60_000;
let lastConfirmedAt = 0;

/** Se invalida al salir a segundo plano: volver a la app es un contexto nuevo. */
export function resetPresence(): void {
  lastConfirmedAt = 0;
}

/**
 * Pide confirmacion. Lanza `PresenceDeniedError` si la persona cancela.
 *
 * @param reason que se va a hacer, para que el dialogo lo diga
 * @param force ignora la ventana de gracia (revelar la llave siempre pregunta)
 */
export async function requireUserPresence(
  reason: PresenceReason,
  force = false,
): Promise<void> {
  // En web no hay biometria del sistema. No se simula ni se bloquea: la
  // compuerta es una defensa del dispositivo, y fingirla en web daria una
  // falsa sensacion de proteccion.
  if (!Capacitor.isNativePlatform()) return;

  if (!force && Date.now() - lastConfirmedAt < GRACE_MS) return;

  const { BiometricAuth } = await import('@aparajita/capacitor-biometric-auth');

  const info = await BiometricAuth.checkBiometry().catch(() => null);
  // Ni biometria ni credencial de dispositivo: se permite seguir. Ver el
  // encabezado — dejar a alguien fuera de su propio dinero es peor.
  if (!info?.isAvailable && !info?.deviceIsSecure) return;

  try {
    await BiometricAuth.authenticate({
      reason: PROMPTS[reason],
      cancelTitle: 'Cancelar',
      // El PIN o patron valen cuando la huella falla o no esta configurada:
      // lo que se busca es presencia de la persona, no un biometrico concreto.
      allowDeviceCredential: true,
      androidTitle: 'MicoPay',
      androidSubtitle: PROMPTS[reason],
      androidConfirmationRequired: false,
    });
    lastConfirmedAt = Date.now();
  } catch {
    // Cualquier fallo se trata como negativa. Interpretar un error del sistema
    // como "adelante" convertiria la compuerta en decorativa.
    throw new PresenceDeniedError();
  }
}
