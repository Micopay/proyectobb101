// Circuit breaker and retry settings per upstream. Moved from the repo-root
// src/config/circuit-breaker.config.ts (same defaults and env names), plus
// volumeThreshold so a single failure cannot open a circuit.
import type { CircuitBreakerConfig, RetryConfig } from './circuitBreaker.js';

export type UpstreamConfig = CircuitBreakerConfig & RetryConfig;

export interface CircuitBreakerConfigs {
  stellarRpc: UpstreamConfig;
  etherfuse: UpstreamConfig;
  didit: UpstreamConfig;
}

/** Positive integer from the environment, or the default when unset or invalid. */
function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

export function loadCircuitBreakerConfigs(): CircuitBreakerConfigs {
  return {
    stellarRpc: {
      timeout: envInt('STELLAR_RPC_TIMEOUT_MS', 10000),
      errorThresholdPercentage: envInt('STELLAR_RPC_CB_THRESHOLD', 50),
      volumeThreshold: 5,
      resetTimeout: envInt('STELLAR_RPC_CB_RESET_MS', 30000),
      rollingCountTimeout: 10000,
      maxRetries: envInt('STELLAR_RPC_MAX_RETRIES', 3),
      baseDelayMs: envInt('STELLAR_RPC_RETRY_BASE_MS', 2000),
      maxDelayMs: envInt('STELLAR_RPC_RETRY_MAX_MS', 10000),
    },
    etherfuse: {
      timeout: envInt('ETHERFUSE_TIMEOUT_MS', 15000),
      errorThresholdPercentage: 50,
      volumeThreshold: 5,
      resetTimeout: 60000,
      rollingCountTimeout: 10000,
      maxRetries: envInt('ETHERFUSE_MAX_RETRIES', 3),
      baseDelayMs: envInt('ETHERFUSE_RETRY_BASE_MS', 2000),
      maxDelayMs: 30000,
    },
    didit: {
      timeout: envInt('DIDIT_TIMEOUT_MS', 20000),
      errorThresholdPercentage: envInt('DIDIT_CB_THRESHOLD', 50),
      volumeThreshold: 5,
      resetTimeout: envInt('DIDIT_CB_RESET_MS', 60000),
      rollingCountTimeout: 10000,
      maxRetries: 2,
      baseDelayMs: 3000,
      maxDelayMs: 15000,
    },
  };
}
