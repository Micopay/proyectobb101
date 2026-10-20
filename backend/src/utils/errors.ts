export class AppError extends Error {
  public code: string;
  public userMessage: string;
  public devMessage: string;
  public httpStatus: number;

  constructor(code: string, userMessage: string, devMessage: string, httpStatus: number) {
    super(devMessage);
    this.code = code;
    this.userMessage = userMessage;
    this.devMessage = devMessage;
    this.httpStatus = httpStatus;
    this.name = this.constructor.name;
    Error.captureStackTrace(this, this.constructor);
  }
}

/**
 * Helper for subclasses that need to accept either a single-arg legacy form
 * (`new NotFoundError('Trade not found')`) or the full taxonomy form
 * (`new NotFoundError('CODE', 'user msg', 'dev msg', status)`).
 */
function resolveErrorArgs(
  defaultCode: string,
  defaultStatus: number,
  args: [string] | [string, string, string, number?],
): [string, string, string, number] {
  if (args.length === 1) {
    const msg = args[0];
    return [defaultCode, msg, msg, defaultStatus];
  }
  const [code, userMessage, devMessage, status = defaultStatus] = args;
  return [code, userMessage, devMessage, status];
}

export class AuthError extends AppError {
  constructor(message: string);
  constructor(code: string, userMessage: string, devMessage: string, httpStatus?: number);
  constructor(...args: [string] | [string, string, string, number?]) {
    super(...resolveErrorArgs('UNAUTHORIZED', 401, args));
  }
}

export class ValidationError extends AppError {
  constructor(message: string);
  constructor(code: string, userMessage: string, devMessage: string, httpStatus?: number);
  constructor(...args: [string] | [string, string, string, number?]) {
    super(...resolveErrorArgs('VALIDATION_ERROR', 400, args));
  }
}

export class BadRequestError extends AppError {
  constructor(message: string);
  constructor(code: string, userMessage: string, devMessage: string, httpStatus?: number);
  constructor(...args: [string] | [string, string, string, number?]) {
    super(...resolveErrorArgs('BAD_REQUEST', 400, args));
  }
}

export class TradeStateError extends AppError {
  constructor(message: string);
  constructor(code: string, userMessage: string, devMessage: string, httpStatus?: number);
  constructor(...args: [string] | [string, string, string, number?]) {
    super(...resolveErrorArgs('TRADE_STATE_ERROR', 409, args));
  }
}

export class ConflictError extends AppError {
  constructor(message: string);
  constructor(code: string, userMessage: string, devMessage: string, httpStatus?: number);
  constructor(...args: [string] | [string, string, string, number?]) {
    super(...resolveErrorArgs('CONFLICT', 409, args));
  }
}

export class NotFoundError extends AppError {
  constructor(message: string);
  constructor(code: string, userMessage: string, devMessage: string, httpStatus?: number);
  constructor(...args: [string] | [string, string, string, number?]) {
    super(...resolveErrorArgs('NOT_FOUND', 404, args));
  }
}

export class ForbiddenError extends AppError {
  constructor(message: string);
  constructor(code: string, userMessage: string, devMessage: string, httpStatus?: number);
  constructor(...args: [string] | [string, string, string, number?]) {
    super(...resolveErrorArgs('FORBIDDEN', 403, args));
  }
}

export class MerchantLimitError extends AppError {
  constructor(message: string);
  constructor(code: string, userMessage: string, devMessage: string, httpStatus?: number);
  constructor(...args: [string] | [string, string, string, number?]) {
    super(...resolveErrorArgs('MERCHANT_LIMIT', 422, args));
  }
}

export class UpstreamError extends AppError {
  constructor(message: string);
  constructor(code: string, userMessage: string, devMessage: string, httpStatus?: number);
  constructor(...args: [string] | [string, string, string, number?]) {
    super(...resolveErrorArgs('UPSTREAM_ERROR', 502, args));
  }
}

export class RateLimitError extends AppError {
  public retryAfter?: number;

  constructor(message = 'Too many requests', retryAfter?: number) {
    super('RATE_LIMITED', message, message, 429);
    this.name = 'RateLimitError';
    this.retryAfter = retryAfter;
  }

  /** Alias for httpStatus for legacy callers/tests. */
  get statusCode(): number {
    return this.httpStatus;
  }
}

/** Account paused, suspended, or blocked by a risk rule (not a rate limit). */
export class RiskBlockedError extends AppError {
  constructor(
    code: string,
    userMessage: string,
    devMessage: string,
    httpStatus = 403,
  ) {
    super(code, userMessage, devMessage, httpStatus);
    this.name = 'RiskBlockedError';
  }
}

/** Operation blocked because the user's KYC tier is below the required level (#314). */
export class KycTierInsufficientError extends AppError {
  public readonly requiredLevel: number;
  public readonly currentLevel: number;

  constructor(requiredLevel: number, currentLevel: number, operationType: string) {
    super(
      'KYC_TIER_INSUFFICIENT',
      `Esta operación requiere un nivel de verificación más alto (nivel ${requiredLevel}). Verifica tu identidad para continuar.`,
      `User kyc_level=${currentLevel} below required=${requiredLevel} for operation ${operationType}`,
      403,
    );
    this.name = 'KycTierInsufficientError';
    this.requiredLevel = requiredLevel;
    this.currentLevel = currentLevel;
  }
}

/**
 * Operation blocked because it would push the user's monthly cumulative
 * volume, for their current KYC level, over the configured ceiling (#316).
 * Distinct from KycTierInsufficientError: this fires even when the user's
 * tier is sufficient for the operation itself, once accumulated volume for
 * the month is too high — the guard against structuring (pitufeo) that
 * #314's per-operation limit alone can't catch.
 */
export class KycMonthlyCapExceededError extends AppError {
  public readonly remainingMxn: number;
  public readonly ceilingMxn: number;
  public readonly resetAt: string;

  constructor(remainingMxn: number, ceilingMxn: number, resetAt: string, level: number) {
    const resetLabel = new Date(resetAt).toLocaleDateString('es-MX', { year: 'numeric', month: 'long', day: 'numeric' });
    super(
      'KYC_MONTHLY_CAP_EXCEEDED',
      `Superarías tu límite mensual de operaciones para tu nivel de verificación. Disponible este mes: $${remainingMxn.toFixed(2)} MXN. Se reinicia el ${resetLabel}.`,
      `User at kyc_level=${level} would exceed monthly volume ceiling=${ceilingMxn}; remaining=${remainingMxn}`,
      403,
    );
    this.name = 'KycMonthlyCapExceededError';
    this.remainingMxn = remainingMxn;
    this.ceilingMxn = ceilingMxn;
    this.resetAt = resetAt;
  }
}

/**
 * Thrown when a Stellar tx hash has already been processed.
 * HTTP 409 — the outcome of a replayed tx is deterministic, so this is
 * a conflict rather than a validation failure.
 */
export class ReplayError extends AppError {
  public readonly txHash: string;
  public readonly originalRoute: string;

  constructor(txHash: string, originalRoute: string) {
    const msg = `Stellar tx ${txHash} has already been processed via ${originalRoute}`;
    super('REPLAY_DETECTED', msg, msg, 409);
    this.name = 'ReplayError';
    this.txHash = txHash;
    this.originalRoute = originalRoute;
  }
}
