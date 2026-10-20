import { createHmac, timingSafeEqual } from "crypto";
import canonicalize from "canonicalize";

// Etherfuse signs webhook deliveries by canonicalizing the JSON body (RFC 8785
// JCS — deterministic key ordering, no extra whitespace), then HMAC-SHA256 over
// that string with a per-subscription secret (base64), sent as
// `X-Signature: sha256={hex}`. See docs.etherfuse.com/guides/verifying-webhooks.
export function verifyWebhookSignature(
  body: unknown,
  signatureHeader: string | undefined,
  secret: string | undefined
): { valid: boolean; error?: string } {
  if (!secret) {
    return { valid: false, error: "webhook secret not configured" };
  }
  if (!signatureHeader) {
    return { valid: false, error: "Missing X-Signature header" };
  }

  const canonicalized = canonicalize(body);
  if (canonicalized === undefined) {
    return { valid: false, error: "Unable to canonicalize webhook body" };
  }

  const key = Buffer.from(secret, "base64");
  const digest = createHmac("sha256", key).update(canonicalized).digest("hex");
  const expected = `sha256=${digest}`;

  const expectedBuf = Buffer.from(expected);
  const actualBuf = Buffer.from(signatureHeader);
  if (expectedBuf.length !== actualBuf.length) {
    return { valid: false, error: "Signature mismatch" };
  }
  if (!timingSafeEqual(expectedBuf, actualBuf)) {
    return { valid: false, error: "Signature mismatch" };
  }
  return { valid: true };
}

// Didit signs webhook deliveries with HMAC-SHA256 over the exact raw request
// body (hex digest, secret used directly as the HMAC key — not base64
// decoded, unlike Etherfuse above), sent as `x-signature`, alongside
// `x-timestamp` (unix seconds) for replay protection.
//
// ⚠️ UNVERIFIED AGAINST A LIVE SANDBOX — see didit.service.ts's header
// comment. Confirm header names and signing scheme against your own Didit
// sandbox before relying on this in production.
//
// Unlike verifyWebhookSignature above (which re-canonicalizes the parsed
// body — safe only because Etherfuse itself signs the JCS-canonical form),
// this needs the caller to pass the exact raw bytes Didit sent: re-stringify
// of the parsed JSON is not guaranteed byte-identical to what was signed.
export function verifyDiditWebhookSignature(
  rawBody: string,
  signatureHeader: string | undefined,
  timestampHeader: string | undefined,
  secret: string | undefined,
  opts: { maxAgeMs?: number; now?: number } = {},
): { valid: boolean; error?: string } {
  const { maxAgeMs = 5 * 60 * 1000, now = Date.now() } = opts;

  if (!secret) {
    return { valid: false, error: "webhook secret not configured" };
  }
  if (!signatureHeader) {
    return { valid: false, error: "Missing x-signature header" };
  }
  if (!timestampHeader) {
    return { valid: false, error: "Missing x-timestamp header" };
  }

  const timestampMs = Number(timestampHeader) * 1000;
  if (!Number.isFinite(timestampMs)) {
    return { valid: false, error: "Invalid x-timestamp header" };
  }
  if (Math.abs(now - timestampMs) > maxAgeMs) {
    return { valid: false, error: "Timestamp outside allowed window (stale or replayed delivery)" };
  }

  const digest = createHmac("sha256", secret).update(rawBody).digest("hex");

  const expectedBuf = Buffer.from(digest);
  const actualBuf = Buffer.from(signatureHeader);
  if (expectedBuf.length !== actualBuf.length) {
    return { valid: false, error: "Signature mismatch" };
  }
  if (!timingSafeEqual(expectedBuf, actualBuf)) {
    return { valid: false, error: "Signature mismatch" };
  }
  return { valid: true };
}
