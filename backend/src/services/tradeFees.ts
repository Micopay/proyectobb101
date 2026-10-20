/**
 * El desglose de comisiones de una operacion, en UN solo sitio.
 *
 * Antes se calculaba en dos, con criterios distintos, y no cuadraban:
 *
 *   · El descubrimiento anunciaba `payout = monto * (1 - tarifa)` e ignoraba la
 *     comision de plataforma por completo.
 *   · La pantalla de confirmacion deducia la parte del agente RESTANDO la de
 *     plataforma de ese total, con lo que un agente al 1.5% acababa cobrando
 *     0.7% sin enterarse.
 *   · Y `trades` no guardaba la comision del agente en ninguna columna, asi que
 *     al liquidar no habia numero que dijera cuanto le tocaba.
 *
 * DECISION DE PRODUCTO (2026-09-05): el cliente paga las dos. El agente cobra
 * su tarifa integra y la plataforma la suya aparte. Hacia donde van (encima o
 * descontadas) lo decide el flujo: ver `FeeFlow`.
 *
 * El redondeo va SIEMPRE a favor de quien recibe la comision (`ceil`) y el
 * cliente absorbe los centavos. Es la convencion menos sorprendente: nadie
 * cobra de menos por un decimal, y el neto del cliente nunca sale mayor de lo
 * anunciado.
 */

/** Comision de MicoPay. El backend es la fuente de verdad; el frontend la espeja. */
export const PLATFORM_FEE_PERCENT = 0.8;

/**
 * Flujo de la operacion. Decide hacia donde van las comisiones (H5, decision
 * de Eric del 2026-09-14): EL MONTO QUE ESCRIBE LA PERSONA ES SIEMPRE EL
 * EFECTIVO QUE CAMBIA DE MANO.
 *
 *   retiro   (cashout): el cliente recibe ese monto en billetes; las comisiones
 *                       van ENCIMA de lo que entrega de su saldo.
 *   deposito (deposit): el cliente entrega ese monto en billetes; las comisiones
 *                       se DESCUENTAN de lo que recibe en su saldo.
 *
 * El contrato solo conoce `amount` (lo que recibe el comprador del escrow al
 * liberar) y `platform_fee`. La comision del agente se cobra a traves de
 * `amount`: en retiro el agente recibe efectivo entregado + su comision; en
 * deposito bloquea solo lo que el cliente recibe mas la plataforma.
 *
 *     $500, agente 1%, plataforma 0.8%   retiro          deposito
 *     efectivo que cambia de mano        recibe 500      entrega 500
 *     escrowAmountMxn (al comprador)     505 (agente)    491 (cliente)
 *     bloquea el vendedor del escrow     509 (cliente)   495 (agente)
 *     neto del agente                    +5              +5
 */
export type FeeFlow = 'cashout' | 'deposit';

export interface TradeFeeBreakdown {
  /** Efectivo que cambia de mano: lo que la persona escribio. */
  amountMxn: number;
  /** Comision del agente, en MXN. */
  providerFeeMxn: number;
  /** Tarifa del agente vigente al calcular, congelada en la operacion. */
  providerRatePercent: number;
  /** Comision de MicoPay, en MXN. */
  platformFeeMxn: number;
  flow: FeeFlow;
  /** Lo que recibe el comprador del escrow al liberar (va a `amount` del contrato). */
  escrowAmountMxn: number;
  /** Lo que bloquea el vendedor del escrow: `escrowAmountMxn + platformFeeMxn`. */
  sellerLocksMxn: number;
  /** Lo que le cuesta al cliente: retiro = saldo que entrega; deposito = efectivo. */
  clientPaysMxn: number;
  /** Lo que recibe el cliente: retiro = efectivo; deposito = saldo. */
  clientReceivesMxn: number;
  /** Igual a `clientReceivesMxn`. Se conserva por compatibilidad con la API. */
  payoutMxn: number;
  /** Coste total sobre el monto, en %. Lo que de verdad le cuesta al cliente. */
  effectivePercent: number;
}

export function normalizeFeeFlow(flow: unknown): FeeFlow {
  // Sin flujo se asume deposito: es el comportamiento que tenian los APK que no
  // lo mandan (decision abierta 2 de PLAN_COMISIONES_EFECTIVO).
  return flow === 'cashout' ? 'cashout' : 'deposit';
}

/**
 * @param amountMxn efectivo que cambia de mano
 * @param providerRatePercent tarifa del agente (`merchant_configs.rate_percent`)
 * @param flow retiro o deposito; sin el se asume deposito
 */
export function computeTradeFees(
  amountMxn: number,
  providerRatePercent: number,
  flow: FeeFlow = 'deposit',
): TradeFeeBreakdown {
  const rate = Number.isFinite(providerRatePercent) ? Math.max(0, providerRatePercent) : 0;

  let providerFeeMxn = Math.ceil((amountMxn * rate) / 100);
  let platformFeeMxn = Math.ceil((amountMxn * PLATFORM_FEE_PERCENT) / 100);

  if (flow === 'deposit') {
    // En deposito las comisiones salen del monto, y con montos minusculos los
    // dos redondeos al alza pueden superarlo. Se topan: primero cobra el agente
    // y la plataforma se queda con lo que reste, para que nada salga negativo.
    // Con `min_trade_mxn` = 100 no ocurre; `createTrade` ademas rechaza un
    // escrow menor a 1 (el contrato no acepta amount <= 0).
    providerFeeMxn = Math.min(providerFeeMxn, amountMxn);
    platformFeeMxn = Math.min(platformFeeMxn, amountMxn - providerFeeMxn);
  }

  const escrowAmountMxn =
    flow === 'cashout' ? amountMxn + providerFeeMxn : amountMxn - providerFeeMxn - platformFeeMxn;
  const clientPaysMxn = flow === 'cashout' ? amountMxn + providerFeeMxn + platformFeeMxn : amountMxn;
  const clientReceivesMxn = flow === 'cashout' ? amountMxn : escrowAmountMxn;

  const effectivePercent =
    amountMxn > 0
      ? Math.round(((providerFeeMxn + platformFeeMxn) / amountMxn) * 10000) / 100
      : 0;

  return {
    amountMxn,
    providerFeeMxn,
    providerRatePercent: rate,
    platformFeeMxn,
    flow,
    escrowAmountMxn,
    sellerLocksMxn: escrowAmountMxn + platformFeeMxn,
    clientPaysMxn,
    clientReceivesMxn,
    payoutMxn: clientReceivesMxn,
    effectivePercent,
  };
}
