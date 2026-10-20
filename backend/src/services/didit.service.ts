// Didit hosted-verification client (#315 — [4b] KYC Provider Integration).
//
// ⚠️ UNVERIFIED AGAINST A LIVE SANDBOX: the endpoint path, header name, and
// request/response field names below follow Didit's publicly documented v2
// Hosted Verification API. This integration has not been exercised against
// a real Didit sandbox account — confirm the shapes here against your own
// sandbox (docs.didit.me) before relying on this in production, and adjust
// this file only (the rest of the integration is provider-agnostic).
import { breakers } from "../lib/breakers.js";
import { breakerFetch, isIdempotentMethod } from "../lib/circuitBreaker.js";

const DIDIT_API = process.env.DIDIT_API_URL ?? "https://verification.didit.me";

function diditClient(path: string, init: RequestInit = {}): Promise<Response> {
  const apiKey = process.env.DIDIT_API_KEY;
  if (!apiKey) {
    throw new Error("DIDIT_API_KEY not configured");
  }

  // Session creation is a POST: never retried, so a lost response cannot
  // open a second session behind the user's back.
  return breakerFetch(breakers.didit, `${DIDIT_API}${path}`, {
    ...init,
    headers: {
      "x-api-key": apiKey,
      "Content-Type": "application/json",
      ...init.headers,
    },
  }, { idempotent: isIdempotentMethod(init.method) });
}

export interface CreateDiditSessionParams {
  /**
   * Opaque string Didit echoes back verbatim in the webhook payload and the
   * session decision. We encode `${userId}:${requestedLevel}` here — see
   * kyc.ts's parseVendorData — so the webhook can identify the user/level
   * without a separate lookup table keyed by anything Didit doesn't return.
   */
  vendorData: string;
  /** Overrides DIDIT_WORKFLOW_ID for this call; falls back to the env var. */
  workflowId?: string;
}

export interface DiditSession {
  sessionId: string;
  url: string;
}

export async function createDiditSession(params: CreateDiditSessionParams): Promise<DiditSession> {
  const workflowId = params.workflowId ?? process.env.DIDIT_WORKFLOW_ID;
  if (!workflowId) {
    throw new Error("DIDIT_WORKFLOW_ID not configured");
  }

  const response = await diditClient("/v2/session/", {
    method: "POST",
    body: JSON.stringify({ workflow_id: workflowId, vendor_data: params.vendorData }),
  });
  if (!response.ok) {
    throw new Error(`Didit API error: ${response.status} ${await response.text()}`);
  }

  const data = (await response.json()) as { session_id: string; url: string };
  return { sessionId: data.session_id, url: data.url };
}

export type DiditDecisionStatus = "approved" | "rejected" | "pending";

/**
 * Maps Didit's webhook/decision status string to our three-value status.
 * Provider-response-driven per #315's legal note: we only ever branch on
 * "did this session end up approved or not", never on which documents/fields
 * Didit collected — that stays entirely on Didit's side of the integration.
 */
export function mapDiditStatus(raw: string | undefined | null): DiditDecisionStatus {
  const normalized = (raw ?? "").toLowerCase();
  if (normalized === "approved") return "approved";
  if (normalized === "declined" || normalized === "rejected" || normalized === "abandoned") {
    return "rejected";
  }
  return "pending";
}
