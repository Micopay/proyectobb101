/**
 * Depósito · el agente confirma que recibió el efectivo.
 *
 * En un depósito el agente es el VENDEDOR del escrow: bloquea su cripto y
 * recibe el efectivo del cliente. Confirmarlo es `POST /trades/:id/reveal`,
 * que el servidor solo acepta del vendedor y con la operación en `locked`.
 * Después el cliente (comprador del escrow) libera y recibe sus activos.
 *
 * Antes no había forma de hacerlo desde la app: `revealTrade` solo se llamaba
 * en `QRReveal`, atado al `activeTrade` del flujo del cliente, y el depósito
 * con un agente real se quedaba en `locked` hasta vencer.
 */
import axios from 'axios';
import { getTrade, revealTrade } from '../services/api';
import { mapApiError } from './apiError';
import type { TradeActor } from './tradeActor';

/** Si a quien mira esta operación le toca confirmar el efectivo ahora. */
export function canConfirmCashReceived(actor: TradeActor, status: string | null | undefined): boolean {
  return (
    actor.flow === 'deposit' &&
    actor.party === 'provider' &&
    actor.escrowRole === 'seller' &&
    status === 'locked'
  );
}

/**
 * Confirma el efectivo. Idempotente para la app: si el servidor responde 409
 * porque la operación ya está en `revealing` (doble toque, doble escaneo o un
 * reintento tras un timeout), se consulta y se trata como éxito.
 */
export async function confirmCashReceived(tradeId: string, token: string): Promise<void> {
  try {
    await revealTrade(tradeId, token);
  } catch (err) {
    if (axios.isAxiosError(err) && err.response?.status === 409) {
      const current = await getTrade(tradeId, token).catch(() => null);
      if (current?.status === 'revealing') return;
    }
    throw err;
  }
}

/** Mensaje en español para un fallo al confirmar el efectivo. */
export function cashConfirmErrorMessage(err: unknown): string {
  if (axios.isAxiosError(err) && err.response) {
    switch (err.response.status) {
      case 403:
        return 'Esta operación no es tuya o no te toca confirmar el efectivo.';
      case 404:
        return 'No encontramos esta operación.';
      case 409:
        return 'Esta operación ya no está esperando la confirmación del efectivo.';
    }
  }
  return mapApiError(err).message;
}
