/** 64-char hex string (32 bytes) — HTLC preimage or Stellar tx hash. */
export const HEX_64_PATTERN = /^[0-9a-fA-F]{64}$/;

/** RFC 4122 UUID (trade IDs from backend). */
export const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Cash claim request IDs (e.g. mcr-4b6c0e5c). */
export const REQUEST_ID_PATTERN = /^[a-zA-Z0-9_-]{4,64}$/;

/** Demo-only HTLC tx placeholder when on-chain lock fails. */
export const DEMO_HTLC_PREFIX = 'demo_htlc_';

export function isHex64(value: string): boolean {
  return HEX_64_PATTERN.test(value);
}

export function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}

export function isRequestId(value: string): boolean {
  return REQUEST_ID_PATTERN.test(value);
}

export function isHtlcReference(value: string, allowDemoPlaceholder: boolean): boolean {
  if (isHex64(value)) return true;
  if (allowDemoPlaceholder && value.startsWith(DEMO_HTLC_PREFIX)) return true;
  return false;
}
