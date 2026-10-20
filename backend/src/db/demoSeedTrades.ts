/**
 * WP-F del plan de selector de activo (docs/PLAN_SELECTOR_ACTIVO_2026-09-14.md).
 *
 * Columnas de escrow para las operaciones de DEMOSTRACION que siembra el
 * arranque (`seedData` y `seedDemoMerchants` en index.ts).
 *
 * Antes esos INSERT calculaban `amount_stroops = amount_mxn * 10^7`, es decir
 * 1 MXN = 1 XLM, y no escribian activo ni tasa: la columna ponia `XLM` y tasa 1
 * por default. El resultado parecia una operacion real convertida, con cifras
 * 3 veces mayores que las de una operacion creada por la app, y
 * `rate_source` quedaba vacio sin decir de donde salia nada.
 *
 * Aqui la tasa es FIJA y se declara sintetica. No se consulta la tasa viva a
 * proposito: el arranque no debe depender de una API externa para sembrar
 * historial de mentira, y una tasa viva congelada haria pasar datos inventados
 * por operaciones reales. Con `rate_source = 'demo_seed_synthetic'` cualquiera
 * que lea la fila sabe que no es evidencia de nada.
 *
 * Los INSERT directos no pasan por `createTrade`, asi que tampoco por su guard
 * de activo: por eso el activo sale de `ENABLED_ESCROW_ASSETS` y no de un
 * literal.
 */

import { ENABLED_ESCROW_ASSETS, mxnToStroops, rateToScaled } from '../services/assetRate.service.js';

export const DEMO_SEED_RATE_SOURCE = 'demo_seed_synthetic';

/** MXN por XLM para el historial demo. Redondo para que se note que no es mercado. */
export const DEMO_SEED_RATE_MXN = '3.0000000';

export interface DemoSeedEscrowColumns {
  amount_stroops: string;
  asset_code: string;
  rate_mxn: string;
  rate_source: string;
}

export function demoSeedEscrowColumns(amountMxn: number): DemoSeedEscrowColumns {
  return {
    amount_stroops: mxnToStroops(amountMxn, rateToScaled(DEMO_SEED_RATE_MXN)).toString(),
    asset_code: ENABLED_ESCROW_ASSETS[0],
    rate_mxn: DEMO_SEED_RATE_MXN,
    rate_source: DEMO_SEED_RATE_SOURCE,
  };
}
