import { getEscrowAssetOption } from '../constants/escrowAssets';

/**
 * H3 (docs/AUDITORIA_IMPLEMENTACION_SELECTOR_ACTIVO_2026-09-14.md) · que puede
 * hacer el cliente ANTES de pedir el bloqueo.
 *
 * QRReveal y TradeDetail llamaban a `ensureTrustline(VITE_ESCROW_ASSET_CODE)`
 * antes de `lockTrade`. El activo salia de la configuracion del APK, no de la
 * operacion: un APK compilado con otro valor firmaba y enviaba un ChangeTrust
 * innecesario (pidiendo huella, pagando comision y reserva) o fallaba, y todo
 * eso antes de que el guard del backend pudiera decir nada.
 *
 * El cliente no envia ninguna transaccion previa al bloqueo:
 *   - un activo con escrow desplegado: nada que preparar (XLM no usa
 *     trustline, y quien bloquea USDC ya la tiene porque ya tiene USDC);
 *   - sin `asset_code` (respuesta antigua): nada que preparar; el backend
 *     decide con su guard (409 ASSET_ESCROW_MISMATCH) y el cliente no inventa;
 *   - cualquier otro activo: se detiene aqui, sin firmar nada.
 *
 * La trustline que si hace falta es la de quien RECIBE en el release; esa la
 * crea `completeTrade` antes de firmar.
 */

export class EscrowAssetNotLockableError extends Error {
  constructor(public readonly assetCode: string) {
    super('Esta operación usa un activo que la app todavía no puede bloquear.');
    this.name = 'EscrowAssetNotLockableError';
  }
}

export function assertNoClientPreparationForLock(assetCode: string | null | undefined): void {
  if (!assetCode) return;
  // Un activo con escrow desplegado en esta red (VITE_ESCROW_ASSETS).
  // Quien bloquea un activo emitido ya lo tiene, asi que ya tiene su
  // trustline: tampoco hay nada que preparar.
  if (getEscrowAssetOption(`stellar:${assetCode.toUpperCase()}`)?.enabled) return;
  throw new EscrowAssetNotLockableError(assetCode);
}
