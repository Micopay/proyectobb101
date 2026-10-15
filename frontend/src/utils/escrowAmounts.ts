/**
 * WP-D del plan de selector de activo (D9, docs/PLAN_SELECTOR_ACTIVO_2026-09-14.md).
 *
 * Que cifra del escrow ve cada persona, SOLO con datos del servidor.
 *
 * El contrato bloquea `amount + platform_fee` (escrow/src/lib.rs, lock), devuelve
 * ese total si hay reembolso y, al liberar, entrega `amount` al comprador. Por
 * eso quien BLOQUEA (vendedor del escrow) ve el total retenido con la comision
 * dentro, y quien RECIBE (comprador) ve el monto. En cash-out bloquea el
 * cliente y recibe el agente; en deposito, al reves. El rol se lee de la
 * operacion (`seller_id`/`buyer_id`), no del flujo ni de la sesion.
 *
 * "En garantia" se afirma solo con evidencia de bloqueo y sin liberacion. Una
 * operacion `pending` todavia no bloqueo nada, y una completada ya libero.
 *
 * Nada de flotantes: las cifras llegan en stroops como cadenas enteras y aqui
 * solo se formatean. Si falta cualquier dato, se devuelve `null` y la pantalla
 * muestra solo pesos: nunca se inventa el activo.
 */

import type { TradeData } from '../services/api';

/** Decimales de XLM y de un token Soroban estandar. */
const STROOP_DECIMALS = 7;

/**
 * Stroops -> unidades, exacto. Quita ceros a la derecha pero conserva al menos
 * dos decimales: `1532267000` -> `"153.2267"`, `1000000000` -> `"100.00"`.
 */
export function formatStroops(stroops: string): string {
  if (!/^\d+$/.test(stroops)) throw new Error(`Invalid stroops: ${stroops}`);
  const padded = stroops.padStart(STROOP_DECIMALS + 1, '0');
  const whole = padded.slice(0, -STROOP_DECIMALS).replace(/^0+(?=\d)/, '');
  let frac = padded.slice(-STROOP_DECIMALS).replace(/0+$/, '');
  if (frac.length < 2) frac = frac.padEnd(2, '0');
  return `${whole}.${frac}`;
}

export type EscrowViewerRole = 'locker' | 'receiver';

export type EscrowPhase =
  /** Aun no hay bloqueo. */
  | 'toLock'
  /** Hay bloqueo y no se ha liberado: los fondos estan en el contrato. */
  | 'inEscrow'
  /** Se libero al comprador. */
  | 'released'
  /** Se devolvio a quien bloqueo. */
  | 'refunded';

export interface EscrowView {
  assetCode: string;
  role: EscrowViewerRole;
  phase: EscrowPhase;
  /** Lo que recibe el comprador, formateado. */
  amount: string;
  /** Comision de plataforma, formateada. */
  fee: string;
  /** Total que retiene el contrato (monto + comision), formateado. */
  total: string;
}

export type EscrowTrade = Pick<
  TradeData,
  'status' | 'lock_tx_hash' | 'release_tx_hash' | 'asset_code' | 'amount_stroops' | 'platform_fee_stroops' | 'total_locked_stroops'
> & { seller_id?: string; buyer_id?: string };

const IN_CONTRACT_STATES = new Set(['locked', 'revealing']);
/** Terminales en la app, pero con fondos aun dentro si hubo bloqueo sin liberar. */
const STOPPED_STATES = new Set(['cancelled', 'expired']);

function phaseOf(trade: EscrowTrade): EscrowPhase | null {
  const locked = !!trade.lock_tx_hash;
  const released = !!trade.release_tx_hash;
  switch (trade.status) {
    case 'pending':
      return locked ? 'inEscrow' : 'toLock';
    case 'completed':
      return 'released';
    case 'refunded':
      return 'refunded';
    default:
      if (IN_CONTRACT_STATES.has(trade.status)) return 'inEscrow';
      if (STOPPED_STATES.has(trade.status)) return locked && !released ? 'inEscrow' : null;
      return null;
  }
}

/**
 * H2: si la pantalla debe seguir preguntando al servidor por esta operacion.
 *
 * Mientras siga activa, si. Y tambien si esta cancelada o vencida con un bloqueo
 * sin liquidar: los fondos siguen en el contrato y el reembolso (del usuario,
 * del sweep o de un evento en cadena) puede llegar en cualquier momento. Antes
 * el detalle dejaba de consultar al pasar a `cancelled` y seguia mostrando "en
 * garantia" despues de que el servidor ya habia registrado el reembolso.
 * Se detiene al confirmarse `completed` o `refunded`.
 */
export function shouldKeepPollingTrade(
  trade: Pick<EscrowTrade, 'status' | 'lock_tx_hash' | 'release_tx_hash'> | null | undefined,
): boolean {
  if (!trade) return false;
  if (trade.status === 'pending' || IN_CONTRACT_STATES.has(trade.status)) return true;
  return STOPPED_STATES.has(trade.status) && !!trade.lock_tx_hash && !trade.release_tx_hash;
}

export function describeEscrowForViewer(trade: EscrowTrade | null | undefined, viewerId: string | null | undefined): EscrowView | null {
  if (!trade || !viewerId) return null;
  const { asset_code, amount_stroops, platform_fee_stroops, total_locked_stroops } = trade;
  if (!asset_code || !amount_stroops || !platform_fee_stroops || !total_locked_stroops) return null;

  let role: EscrowViewerRole;
  if (trade.seller_id === viewerId) role = 'locker';
  else if (trade.buyer_id === viewerId) role = 'receiver';
  else return null;

  const phase = phaseOf(trade);
  if (!phase) return null;
  // Quien recibe no tiene nada que ver en un reembolso ni en una operacion
  // detenida: esos fondos vuelven a quien bloqueo.
  if (role === 'receiver' && (phase === 'refunded' || (phase === 'inEscrow' && STOPPED_STATES.has(trade.status)))) {
    return null;
  }

  try {
    return {
      assetCode: asset_code,
      role,
      phase,
      amount: formatStroops(amount_stroops),
      fee: formatStroops(platform_fee_stroops),
      total: formatStroops(total_locked_stroops),
    };
  } catch {
    return null;
  }
}

/** Clave i18n (seccion `escrowAsset`) para una vista. */
export function escrowViewMessageKey(view: EscrowView): string {
  if (view.role === 'locker') {
    return {
      toLock: 'lockerToLock',
      inEscrow: 'lockerInEscrow',
      released: 'lockerReleased',
      refunded: 'lockerRefunded',
    }[view.phase];
  }
  return view.phase === 'released' ? 'receiverReceived' : 'receiverWillReceive';
}
