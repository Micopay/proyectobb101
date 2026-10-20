// One breaker per upstream, shared by every caller of that upstream: the
// event listener and user requests hit the same Stellar RPC, so they share
// its health.
import pino from 'pino';
import { CircuitBreaker, type UpstreamLabels } from './circuitBreaker.js';
import { loadCircuitBreakerConfigs } from './circuitBreaker.config.js';

const logger = pino({ name: 'circuit-breaker' });

const LABELS: Record<'didit' | 'etherfuse' | 'stellarRpc', UpstreamLabels> = {
  didit: {
    code: 'DIDIT',
    unavailableMessage: 'La verificación de identidad no está disponible en este momento. Intenta de nuevo en unos minutos.',
    timeoutMessage: 'La verificación de identidad está tardando demasiado. Intenta de nuevo en unos minutos.',
  },
  etherfuse: {
    code: 'ETHERFUSE',
    unavailableMessage: 'El servicio de CETES no está disponible en este momento. Intenta de nuevo en unos minutos.',
    timeoutMessage: 'El servicio de CETES está tardando demasiado. Intenta de nuevo en unos minutos.',
  },
  stellarRpc: {
    code: 'STELLAR',
    unavailableMessage: 'La red Stellar no responde en este momento. Intenta de nuevo en unos minutos.',
    timeoutMessage: 'La red Stellar está tardando demasiado en responder. Intenta de nuevo en unos minutos.',
  },
};

function build(name: keyof typeof LABELS): CircuitBreaker {
  const config = loadCircuitBreakerConfigs()[name];
  return new CircuitBreaker(name, config, LABELS[name], {
    onStateChange: (n, from, to) => {
      const log = to === 'open' ? logger.warn.bind(logger) : logger.info.bind(logger);
      log({ breaker: n, from, to, category: 'circuit-breaker' }, `[circuit-breaker] ${n}: ${from} → ${to}`);
    },
  });
}

let instances: Record<keyof typeof LABELS, CircuitBreaker> | null = null;

function all(): Record<keyof typeof LABELS, CircuitBreaker> {
  if (!instances) {
    instances = { didit: build('didit'), etherfuse: build('etherfuse'), stellarRpc: build('stellarRpc') };
  }
  return instances;
}

export const breakers = {
  get didit(): CircuitBreaker { return all().didit; },
  get etherfuse(): CircuitBreaker { return all().etherfuse; },
  get stellarRpc(): CircuitBreaker { return all().stellarRpc; },
};

/** Replace the breakers (tests) or rebuild them from the environment (null). */
export function setBreakersForTests(next: Partial<Record<keyof typeof LABELS, CircuitBreaker>> | null): void {
  instances = next ? { ...all(), ...next } : null;
}

export { LABELS as UPSTREAM_LABELS };
