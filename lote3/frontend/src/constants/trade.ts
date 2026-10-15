/**
 * Trade amount + fee rules — **must stay aligned** with `trade.service.ts` on the backend
 * (`createTrade` validation and `PLATFORM_FEE_PERCENT` / `DEFAULT_TIMEOUT_MINUTES`).
 *
 * We duplicate literals here because the browser bundle cannot import the server module; if backend
 * constants change, update this file in the same PR.
 */
export const TRADE_AMOUNT_MIN_MXN = 100;
export const TRADE_AMOUNT_MAX_MXN = 50_000;
/** Matches backend `PLATFORM_FEE_PERCENT` (0.8%). */
export const PLATFORM_FEE_PERCENT = 0.8;
/** Matches backend `DEFAULT_TIMEOUT_MINUTES` (escrow / trade window). */
export const TRADE_DEFAULT_TIMEOUT_MINUTES = 120;

/**
 * Platform fee in MXN for a trade face value — mirrors `Math.ceil(amountMxn * PLATFORM_FEE_PERCENT / 100)` in the API.
 */
export function platformFeeMxnFromAmount(amountMxn: number): number {
  return Math.ceil(amountMxn * PLATFORM_FEE_PERCENT / 100);
}
