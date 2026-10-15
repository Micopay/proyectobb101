import { errorMessages } from './errorMessages';

const statusToKey = {
  400: 'financial.failed',
  401: 'auth.sessionExpired',
  403: 'auth.unauthorized',
  404: 'generic.fallback',
  408: 'network.timeout',
  409: 'financial.conflict',
  503: 'network.unavailable',
};

const domainToKey = {
  ConflictError: 'financial.conflict',
  conflict: 'financial.conflict',
  insufficient_funds: 'financial.insufficientFunds',
  insufficient_funds_error: 'financial.insufficientFunds',
  unauthorized: 'auth.unauthorized',
  invalid_credentials: 'auth.invalidCredentials',
  session_expired: 'auth.sessionExpired',
  expired_session: 'auth.sessionExpired',
  network_error: 'network.offline',
  backend_not_available: 'network.unavailable',
  backend_unavailable: 'network.unavailable',
  service_unavailable: 'network.unavailable',
  timeout: 'network.timeout',
  timed_out: 'network.timeout',
  failed: 'financial.failed',
  operation_failed: 'financial.failed',
  escrow_unavailable: 'escrow.unavailable',
  qr_invalid: 'qr.invalid',
  camera_denied: 'qr.cameraDenied',
  scan_failed: 'qr.scanFailed',
  qr_expired: 'qr.expired',
  qr_unreadable: 'qr.unreadable',
  refund_pending: 'refund.pending',
  refund_failed: 'refund.failed',
  dispute_pending: 'dispute.pending',
  dispute_resolved: 'dispute.resolved',
};

function getByKey(key) {
  const parts = key.split('.');
  let current = errorMessages;

  for (const part of parts) {
    current = current?.[part];
  }

  return current ?? errorMessages.generic.fallback;
}

function pickKeyFromMessage(message) {
  const normalized = String(message || '').toLowerCase();

  if (normalized.includes('insufficient') || normalized.includes('saldo insuficiente') || normalized.includes('fondos insuficientes')) {
    return 'financial.insufficientFunds';
  }

  if (normalized.includes('conflict') || normalized.includes('already exists') || normalized.includes('ya cambió')) {
    return 'financial.conflict';
  }

  if (normalized.includes('unauthorized') || normalized.includes('no autorizado')) {
    return 'auth.unauthorized';
  }

  if (normalized.includes('expired') || normalized.includes('sesión vencida') || normalized.includes('session')) {
    return 'auth.sessionExpired';
  }

  if (normalized.includes('timeout') || normalized.includes('tiempo de espera')) {
    return 'network.timeout';
  }

  if (normalized.includes('network') || normalized.includes('connection') || normalized.includes('conexión')) {
    return 'network.offline';
  }

  if (normalized.includes('service unavailable') || normalized.includes('backend not available') || normalized.includes('backend unavailable')) {
    return 'network.unavailable';
  }

  if (normalized.includes('qr')) {
    return 'qr.invalid';
  }

  if (normalized.includes('refund')) {
    return 'refund.pending';
  }

  return 'generic.fallback';
}

export function resolveErrorMessage(error) {
  const status = error?.response?.status ?? error?.status;
  const responseError = error?.response?.data?.error ?? error?.error;
  const responseMessage = error?.response?.data?.message ?? error?.message;

  const statusKey = status ? statusToKey[status] : undefined;
  const domainKey = responseError ? domainToKey[responseError] : undefined;
  const messageKey = responseMessage ? domainToKey[String(responseMessage)] ?? pickKeyFromMessage(responseMessage) : undefined;
  const key = domainKey || statusKey || messageKey || 'generic.fallback';
  const message = getByKey(key);

  return {
    key,
    title: message.title,
    message: message.message,
    action: message.action,
    fundsSafe: message.fundsSafe,
  };
}

export { statusToKey, domainToKey };
