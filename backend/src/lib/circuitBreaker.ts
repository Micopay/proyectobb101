// Circuit breaker for the backend's upstreams (Didit, Etherfuse, Stellar RPC).
//
// Rules this file enforces, because getting them wrong moves or loses money:
//   - Only transient failures (network error, timeout, 5xx, 429) count against
//     the circuit or are retried. A 4xx or a contract error means the upstream
//     answered: it counts as a healthy call and is surfaced unchanged.
//   - Retries only happen when the caller says the operation is idempotent.
//     A POST that may already have created something upstream is never
//     retried here (a lost response must not become a duplicate order).
//   - An open circuit rejects without touching the network and never invents
//     a result: there is no fallback that fakes success.
import { AppError } from '../utils/errors.js';

export type BreakerState = 'closed' | 'open' | 'half_open';

export interface CircuitBreakerConfig {
  /** Per-attempt timeout. */
  timeout: number;
  /** Failure percentage within the rolling window that opens the circuit. */
  errorThresholdPercentage: number;
  /** Minimum calls in the window before the percentage is trusted. */
  volumeThreshold: number;
  /** How long the circuit stays open before letting one probe through. */
  resetTimeout: number;
  /** Length of the rolling window. */
  rollingCountTimeout: number;
}

export interface RetryConfig {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

/** User-facing copy for one upstream, used by the errors below. */
export interface UpstreamLabels {
  /** Prefix for error codes, e.g. "DIDIT" → DIDIT_UNAVAILABLE / DIDIT_TIMEOUT. */
  code: string;
  unavailableMessage: string;
  timeoutMessage: string;
}

/** The circuit is open: the call was rejected before reaching the network. */
export class CircuitOpenError extends AppError {
  constructor(name: string, labels: UpstreamLabels) {
    super(
      `${labels.code}_UNAVAILABLE`,
      labels.unavailableMessage,
      `Circuit "${name}" is open; request rejected without calling upstream`,
      503,
    );
  }
}

/** The attempt exceeded its timeout. The upstream may still have acted on it. */
export class UpstreamTimeoutError extends AppError {
  constructor(name: string, labels: UpstreamLabels, ms: number) {
    super(
      `${labels.code}_TIMEOUT`,
      labels.timeoutMessage,
      `Upstream "${name}" did not answer within ${ms}ms`,
      504,
    );
  }
}

/** Internal marker for a 5xx/429 HTTP answer; carries the response. */
export class TransientHttpError extends Error {
  constructor(public readonly response: Response) {
    super(`Upstream answered ${response.status}`);
    this.name = 'TransientHttpError';
  }
}

const TRANSIENT_CODES = new Set([
  'ECONNRESET', 'ECONNREFUSED', 'ECONNABORTED', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN',
  // ERR_NETWORK: axios (the Stellar SDK's HTTP client) when no response arrived.
  'EPIPE', 'ERR_NETWORK', 'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT',
]);

/**
 * Is this a failure of the upstream itself (worth counting and, for reads,
 * retrying) rather than an answer we did not like?
 */
export function isTransientError(err: unknown): boolean {
  if (err instanceof UpstreamTimeoutError || err instanceof TransientHttpError) return true;
  if (err instanceof CircuitOpenError || err instanceof AppError) return false;
  const e = err as any;
  if (!e || typeof e !== 'object') return false;
  const code = e.code ?? e.cause?.code;
  if (typeof code === 'string' && TRANSIENT_CODES.has(code)) return true;
  // undici's fetch reports every network failure as TypeError("fetch failed").
  if (e.name === 'TypeError' && /fetch failed|network/i.test(String(e.message))) return true;
  // HTTP clients that attach the response (the Stellar SDK's RPC client does).
  const status = e.response?.status ?? e.status;
  if (typeof status === 'number' && (status >= 500 || status === 429)) return true;
  return false;
}

export interface RunOptions {
  /** Retry transient failures. Only for operations safe to repeat. */
  retry?: boolean;
}

interface Deps {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  random: () => number;
  onStateChange?: (name: string, from: BreakerState, to: BreakerState) => void;
}

const defaultDeps: Deps = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  random: Math.random,
};

export class CircuitBreaker {
  private _state: BreakerState = 'closed';
  private openedAt = 0;
  private probeInFlight = false;
  private window: { t: number; ok: boolean }[] = [];
  private readonly deps: Deps;

  readonly metrics = {
    successes: 0,
    failures: 0,
    timeouts: 0,
    rejected: 0,
    retries: 0,
  };

  constructor(
    readonly name: string,
    readonly config: CircuitBreakerConfig & RetryConfig,
    private readonly labels: UpstreamLabels,
    deps: Partial<Deps> = {},
  ) {
    this.deps = { ...defaultDeps, ...deps };
  }

  get state(): BreakerState {
    return this._state;
  }

  /**
   * Run `fn` through the breaker. `fn` receives an AbortSignal that fires on
   * timeout; callers that can cancel (fetch) should pass it on.
   */
  async run<T>(fn: (signal: AbortSignal) => Promise<T>, opts: RunOptions = {}): Promise<T> {
    const attempts = opts.retry ? 1 + this.config.maxRetries : 1;
    for (let attempt = 1; ; attempt++) {
      this.admit();
      try {
        const result = await this.withTimeout(fn);
        this.record(true);
        return result;
      } catch (err) {
        const transient = isTransientError(err);
        this.record(!transient);
        if (!transient || attempt >= attempts) throw err;
        this.metrics.retries++;
        await this.deps.sleep(this.backoff(attempt));
      }
    }
  }

  /** Throws CircuitOpenError unless a call may go through now. */
  private admit(): void {
    if (this._state === 'open') {
      if (this.deps.now() - this.openedAt < this.config.resetTimeout) {
        this.metrics.rejected++;
        throw new CircuitOpenError(this.name, this.labels);
      }
      this.transition('half_open');
    }
    if (this._state === 'half_open') {
      // One probe at a time; everyone else waits for its verdict.
      if (this.probeInFlight) {
        this.metrics.rejected++;
        throw new CircuitOpenError(this.name, this.labels);
      }
      this.probeInFlight = true;
    }
  }

  private record(ok: boolean): void {
    if (ok) this.metrics.successes++;
    else this.metrics.failures++;

    if (this._state === 'half_open') {
      this.probeInFlight = false;
      if (ok) {
        this.window = [];
        this.transition('closed');
      } else {
        this.trip();
      }
      return;
    }

    const now = this.deps.now();
    this.window.push({ t: now, ok });
    const since = now - this.config.rollingCountTimeout;
    while (this.window.length && this.window[0].t < since) this.window.shift();

    if (!ok && this.window.length >= this.config.volumeThreshold) {
      const failed = this.window.filter((s) => !s.ok).length;
      if ((failed * 100) / this.window.length >= this.config.errorThresholdPercentage) {
        this.trip();
      }
    }
  }

  private trip(): void {
    this.openedAt = this.deps.now();
    this.window = [];
    this.transition('open');
  }

  private transition(to: BreakerState): void {
    const from = this._state;
    if (from === to) return;
    this._state = to;
    this.deps.onStateChange?.(this.name, from, to);
  }

  /** Wait the backoff for `attempt` (1-based). For callers with their own retry loop. */
  pause(attempt: number): Promise<void> {
    return this.deps.sleep(this.backoff(attempt));
  }

  private backoff(attempt: number): number {
    const exp = this.config.baseDelayMs * 2 ** (attempt - 1);
    const capped = Math.min(exp, this.config.maxDelayMs);
    // Full jitter in the upper half: spreads retries without collapsing to 0.
    return Math.round(capped / 2 + this.deps.random() * (capped / 2));
  }

  private async withTimeout<T>(fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        this.metrics.timeouts++;
        const err = new UpstreamTimeoutError(this.name, this.labels, this.config.timeout);
        controller.abort(err);
        reject(err);
      }, this.config.timeout);
    });
    try {
      // Race as well as abort: not every client honours the signal.
      return await Promise.race([fn(controller.signal), timeout]);
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * fetch() through a breaker. A 5xx/429 counts as a failure (and is retried
 * when `idempotent`); once attempts run out, the last response is returned
 * so the caller keeps its own error handling for non-OK answers.
 */
export async function breakerFetch(
  breaker: CircuitBreaker,
  url: string,
  init: RequestInit = {},
  opts: { idempotent: boolean },
): Promise<Response> {
  try {
    return await breaker.run(async (signal) => {
      const res = await fetch(url, { ...init, signal });
      if (res.status >= 500 || res.status === 429) throw new TransientHttpError(res);
      return res;
    }, { retry: opts.idempotent });
  } catch (err) {
    if (err instanceof TransientHttpError) return err.response;
    throw err;
  }
}

/** Idempotent per HTTP semantics, so safe to retry automatically. */
export function isIdempotentMethod(method: string | undefined): boolean {
  const m = (method ?? 'GET').toUpperCase();
  return m === 'GET' || m === 'HEAD' || m === 'OPTIONS';
}
