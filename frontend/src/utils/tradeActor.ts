/**
 * CASH-5B · Quién es cada quien en ESTA operación.
 *
 * El rol no es una propiedad de la sesión: la misma persona es cliente en una
 * operación y proveedora en otra (CASH-7). Y el papel en el escrow se invierte
 * entre los dos flujos, así que tampoco se puede leer de `seller_id` a secas:
 *
 *   cash-out · el cliente entrega cripto  -> es el VENDEDOR del escrow
 *              el proveedor entrega efectivo -> es el COMPRADOR
 *   depósito · el proveedor entrega cripto -> es el VENDEDOR del escrow
 *              el cliente entrega efectivo  -> es el COMPRADOR
 *
 * Lo único constante es que **quien libera es siempre el comprador del
 * escrow**, porque el contrato exige su firma y la cripto se le entrega a él.
 */

import type { TradeFlow } from '../services/api';

export type TradeParty = 'client' | 'provider' | 'observer';
export type EscrowRole = 'seller' | 'buyer' | 'none';

export interface TradeActor {
  /** Papel de producto: quien pide el servicio, o quien lo provee. */
  party: TradeParty;
  /** Papel en el contrato de escrow. */
  escrowRole: EscrowRole;
  /** Flujo canónico de la operación. */
  flow: TradeFlow;
  /**
   * `true` si a esta persona le toca liberar los fondos en este flujo.
   * Es el comprador del escrow, siempre.
   */
  canRelease: boolean;
}

interface TradeParticipants {
  flow?: TradeFlow;
  seller_id?: string;
  buyer_id?: string;
  provider_id?: string;
}

export function resolveTradeActor(
  userId: string | null | undefined,
  trade: TradeParticipants,
): TradeActor {
  const flow: TradeFlow = trade.flow === 'cashout' ? 'cashout' : 'deposit';

  const escrowRole: EscrowRole =
    userId && trade.seller_id === userId
      ? 'seller'
      : userId && trade.buyer_id === userId
        ? 'buyer'
        : 'none';

  // `provider_id` es la fuente canónica (CASH-1). Sin él no se adivina a
  // partir de los roles del escrow: se prefiere no atribuir.
  const party: TradeParty =
    escrowRole === 'none'
      ? 'observer'
      : trade.provider_id && trade.provider_id === userId
        ? 'provider'
        : trade.provider_id
          ? 'client'
          : 'observer';

  return {
    party,
    escrowRole,
    flow,
    canRelease: escrowRole === 'buyer',
  };
}
