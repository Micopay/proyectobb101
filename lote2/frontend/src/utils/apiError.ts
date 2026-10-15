import axios from 'axios';
import { resolveErrorMessage } from '../constants/errorMap';

export interface ApiErrorPayload {
  message: string;
  error?: string;
  /** Full correlation ID returned by the backend in every error response. */
  request_id?: string;
  /** Short human-friendly code (e.g. "3f2a-bc91") for support conversations. */
  support_code?: string;
}

/**
 * Error carrying the normalized API payload so the UI can surface the safe
 * message plus the optional machine-readable `error`, `request_id` and
 * `support_code` fields.
 */
export class ApiError extends Error {
  readonly code?: string;
  readonly requestId?: string;
  readonly supportCode?: string;

  constructor(payload: ApiErrorPayload) {
    super(payload.message);
    this.name = 'ApiError';
    this.code = payload.error;
    this.requestId = payload.request_id;
    this.supportCode = payload.support_code;
  }
}

/** Build an `ApiError` from a normalized payload (used in service catch blocks). */
export function toApiError(payload: ApiErrorPayload): ApiError {
  return new ApiError(payload);
}

/**
 * Normalizes Fastify `setErrorHandler` payloads (`{ error, message }`) and Axios failures
 * so UI can show a safe string + optional machine-readable `error` key (#20 error path).
 *
 * Since #81 the backend includes `request_id` and `support_code` in every error
 * response — this function now surfaces those for the UI to display.
 */
export function extractApiErrorPayload(err: unknown): ApiErrorPayload {
  if (axios.isAxiosError(err)) {
    const data = err.response?.data as
      | { message?: string; error?: string; code?: string; request_id?: string; support_code?: string }
      | undefined;
    const resolved = resolveErrorMessage({
      response: {
        status: err.response?.status,
        data,
      },
      message: err.message,
    });
    const message =
      typeof data?.message === 'string' && data.message.length > 0
        ? resolved.message
        : resolved.message;
    // Backend's global error handler sends `code` (see index.ts setErrorHandler),
    // not `error` — `error` is kept as a fallback for any endpoint that still
    // uses the older shape.
    const error = typeof data?.code === 'string' ? data.code : typeof data?.error === 'string' ? data.error : undefined;
    const request_id = typeof data?.request_id === 'string' ? data.request_id : undefined;
    const support_code = typeof data?.support_code === 'string' ? data.support_code : undefined;

    return { message, error, request_id, support_code };
  }
  if (err instanceof Error) {
    const resolved = resolveErrorMessage(err);
    return { message: resolved.message };
  }
  return { message: resolveErrorMessage(undefined).message };
}

export type ApiErrorAction = 'retry' | 'support';

export interface MappedApiError {
  message: string;
  error?: string;
  action: ApiErrorAction;
  status?: number;
}

/** Maps network / HTTP failures to Spanish copy with a suggested user action. */
export function mapApiError(err: unknown): MappedApiError {
  if (axios.isAxiosError(err)) {
    const status = err.response?.status;
    const { message, error } = extractApiErrorPayload(err);

    if (!err.response) {
      return {
        message: 'Sin conexión al servidor. Revisa tu internet e inténtalo de nuevo.',
        error,
        action: 'retry',
      };
    }

    switch (status) {
      case 401:
        return {
          message: 'Tu sesión expiró o no tienes acceso. Vuelve a iniciar sesión o contacta soporte.',
          error,
          action: 'support',
          status,
        };
      case 409:
        return {
          message:
            message === 'Something went wrong. Please try again.'
              ? 'Esta operación ya no está disponible o fue modificada. Contacta soporte si necesitas ayuda.'
              : message,
          error,
          action: 'support',
          status,
        };
      case 500:
      case 502:
      case 503:
        return {
          message: 'El servidor no respondió correctamente. Inténtalo de nuevo en unos momentos.',
          error,
          action: 'retry',
          status,
        };
      default:
        return {
          message:
            message === 'Something went wrong. Please try again.'
              ? 'Ocurrió un error inesperado. Inténtalo de nuevo.'
              : message,
          error,
          action: status !== undefined && status >= 400 && status < 500 ? 'support' : 'retry',
          status,
        };
    }
  }

  if (err instanceof Error) {
    return { message: err.message, action: 'retry' };
  }

  return {
    message: 'Ocurrió un error inesperado. Inténtalo de nuevo.',
    action: 'retry',
  };
}
