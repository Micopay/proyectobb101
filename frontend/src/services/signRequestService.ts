import axios from 'axios';
import { extractApiErrorPayload, toApiError } from '../utils/apiError';
import { signTransactionXdr } from '../lib/keystore';

const BASE_URL = import.meta.env.VITE_API_URL ?? "http://localhost:3000";
const http = axios.create({ baseURL: BASE_URL });

function authHeaders(token: string) {
  return { headers: { Authorization: `Bearer ${token}` } };
}

export interface SignatureRequest {
  id: string;
  app_name: string;
  app_icon?: string;
  xdr: string;
  network_passphrase?: string;
  status: 'pending' | 'approved' | 'rejected' | 'expired';
  created_at: string;
  expires_at: string;
}

export type ResolveAction = 'approve' | 'reject';

export interface ResolveSignatureRequestResult {
  id: string;
  status: 'approved' | 'rejected';
  signed_xdr?: string;
}

/**
 * Fetch a single signature request by ID.
 */
export async function getSignatureRequest(id: string, token?: string): Promise<SignatureRequest> {
  try {
    const config = token ? authHeaders(token) : {};
    const res = await http.get(`/sign-requests/${id}`, config);
    return res.data;
  } catch (err: any) {
    throw toApiError(err);
  }
}

/**
 * Fetch pending signature requests for current user.
 */
export async function getPendingSignatureRequests(token: string): Promise<SignatureRequest[]> {
  try {
    const res = await http.get('/sign-requests/pending', authHeaders(token));
    return res.data;
  } catch (err: any) {
    throw toApiError(err);
  }
}

/**
 * Resolve a signature request by approving (signing local XDR) or rejecting.
 */
export async function resolveSignatureRequest(
  id: string,
  action: ResolveAction,
  xdr?: string,
  networkPassphrase?: string,
  token?: string
): Promise<ResolveSignatureRequestResult> {
  try {
    let signedXdr: string | undefined;

    if (action === 'approve') {
      if (!xdr) {
        throw new Error('Transaction XDR is required for approval');
      }
      const passphrase = networkPassphrase || 'Test SDF Network ; July 2015';
      signedXdr = await signTransactionXdr(xdr, passphrase);
    }

    const payload = {
      action,
      ...(signedXdr ? { signed_xdr: signedXdr } : {}),
    };

    const config = token ? authHeaders(token) : {};
    const res = await http.post(`/sign-requests/${id}/resolve`, payload, config);
    return res.data;
  } catch (err: any) {
    throw toApiError(err);
  }
}

/**
 * Parse pairing payload from QR code or deeplink URL.
 * Accepts either:
 * - A full URL string, e.g. "micopay://sign-request?id=123" or "https://app.micopay.io/sign-request?id=123"
 * - A JSON string with { id: "123" }
 * - A raw request ID string.
 */
export function parsePairingPayload(payload: string): { requestId: string } | null {
  if (!payload || typeof payload !== 'string') return null;
  const trimmed = payload.trim();
  if (!trimmed) return null;

  // Case 1: Deep link or HTTP URL
  if (trimmed.includes('://') || trimmed.startsWith('micopay:')) {
    try {
      const url = new URL(trimmed);
      const id = url.searchParams.get('id') || url.searchParams.get('requestId');
      if (id) return { requestId: id };
      const pathParts = url.pathname.split('/').filter(Boolean);
      if (pathParts.length > 0) {
        const lastPart = pathParts[pathParts.length - 1];
        if (lastPart && lastPart !== 'sign-request') {
          return { requestId: lastPart };
        }
      }
    } catch {
      // Fall through if URL parsing fails
    }
  }

  // Case 2: JSON object
  if (trimmed.startsWith('{')) {
    try {
      const data = JSON.parse(trimmed);
      const id = data.id || data.requestId || data.signRequestId;
      if (id && typeof id === 'string') {
        return { requestId: id };
      }
    } catch {
      // Fall through
    }
  }

  // Case 3: Raw ID (alphanumeric/uuid)
  if (/^[a-zA-Z0-9_-]+$/.test(trimmed)) {
    return { requestId: trimmed };
  }

  return null;
}
