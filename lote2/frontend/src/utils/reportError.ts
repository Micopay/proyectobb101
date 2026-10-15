import axios from 'axios';
import { readJSON } from '../services/secureStorage';

const BASE_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3000';

function redactSensitiveData(obj: any): any {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) {
    return obj.map(redactSensitiveData);
  }
  const redacted: Record<string, any> = {};
  const sensitivePatterns = [
    /token/i,
    /secret/i,
    /key/i,
    /password/i,
    /auth/i,
    /htlc/i,
    /private/i,
    /seed/i,
    /mnemonic/i
  ];
  for (const [key, value] of Object.entries(obj)) {
    const isSensitive = sensitivePatterns.some((regex) => regex.test(key));
    if (isSensitive) {
      redacted[key] = '[REDACTED]';
    } else {
      redacted[key] = redactSensitiveData(value);
    }
  }
  return redacted;
}

function redactString(str: string | undefined): string | undefined {
  if (!str) return str;
  return str
    .replace(/\b[eE]y[a-zA-Z0-9-_=]+\.[a-zA-Z0-9-_=]+\.[a-zA-Z0-9-_.+/=]+\b/g, '[REDACTED_JWT]')
    .replace(/\bS[A-D][A-Z2-7]{54}\b/g, '[REDACTED_STELLAR_SEED]')
    .replace(/(?:bearer|authorization|auth)\s+[a-zA-Z0-9-._~+/]+=*/ig, '[REDACTED_AUTH_HEADER]');
}

/**
 * Best-effort fire-and-forget error report to the backend.
 * Used by ErrorBoundary and critical catch blocks so support
 * can correlate APK crashes with backend logs.
 */
export async function reportClientError(payload: {
  request_id?: string;
  error_code?: string;
  message: string;
  stack?: string;
  context?: Record<string, unknown>;
}) {
  // SEC-27: redact secrets (JWTs, Stellar seeds, auth headers, sensitive keys)
  // before the report ever leaves the device.
  const safePayload = {
    request_id: payload.request_id,
    error_code: payload.error_code,
    message: redactString(payload.message) ?? payload.message,
    stack: redactString(payload.stack),
    context: payload.context ? redactSensitiveData(payload.context) : undefined,
    app_version: import.meta.env.VITE_APP_VERSION ?? 'dev',
  };

  // Fire and forget — don't let a reporting failure break the UX.
  readJSON<{ token?: string }>('micopay_user')
    .then((stored) => {
      const token = stored?.token;
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (token) headers['Authorization'] = `Bearer ${token}`;
      return axios.post(`${BASE_URL}/client-errors`, safePayload, { headers });
    })
    .catch(() => {});
}
