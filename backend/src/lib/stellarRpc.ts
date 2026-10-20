// Stellar RPC access through the shared breaker.
//
// Reads (getAccount, prepareTransaction, getEvents, getTransaction…) are safe
// to retry. Submissions are not reads: when sendTransaction ends without a
// clear answer (network error, timeout), the transaction may already be in
// the network. Before sending again we look it up by hash. Resending is the
// *same signed envelope*, which Stellar can apply at most once because its
// sequence number is consumed on the first application.
import { AppError } from '../utils/errors.js';
import { breakers } from './breakers.js';
import { isTransientError } from './circuitBreaker.js';

/** The subset of rpc.Server this backend uses. */
export interface RpcServerLike {
  getAccount(address: string): Promise<any>;
  prepareTransaction(tx: any): Promise<any>;
  sendTransaction(tx: any): Promise<{ status: string; hash: string; errorResult?: unknown }>;
  getTransaction(hash: string): Promise<{ status: string }>;
  getEvents(request: any): Promise<any>;
  getLatestLedger(): Promise<{ sequence: number }>;
}

type ServerFactory = (url: string) => Promise<RpcServerLike>;

const defaultFactory: ServerFactory = async (url) => {
  const { rpc } = await import('@stellar/stellar-sdk');
  return new rpc.Server(url) as unknown as RpcServerLike;
};

let factory: ServerFactory = defaultFactory;

/** Swap the RPC server (tests). null restores the real one. */
export function setRpcServerFactoryForTests(next: ServerFactory | null): void {
  factory = next ?? defaultFactory;
}

/** A read against Stellar RPC: timed out, counted by the breaker and retried if transient. */
export async function rpcRead<T>(
  url: string,
  op: (server: RpcServerLike) => Promise<T>,
  opts: { retry?: boolean } = {},
): Promise<T> {
  const server = await factory(url);
  return breakers.stellarRpc.run(() => op(server), { retry: opts.retry ?? true });
}

/** The submission may or may not have reached the network; the client must not resubmit blindly. */
export class StellarSubmitUncertainError extends AppError {
  constructor(hash: string, cause: unknown) {
    super(
      'STELLAR_SUBMIT_UNCERTAIN',
      'No pudimos confirmar si la transacción llegó a la red. Revisa el estado antes de volver a intentarlo.',
      `Submission of ${hash} is uncertain: ${(cause as any)?.message ?? String(cause)}`,
      504,
    );
  }
}

/** On-chain status by hash, or null when it could not be determined. */
async function lookup(url: string, hash: string): Promise<string | null> {
  try {
    const res = await rpcRead(url, (s) => s.getTransaction(hash));
    return res.status;
  } catch {
    return null;
  }
}

interface Signed {
  hash(): Buffer;
}

/**
 * sendTransaction with reconciliation. Returns the RPC answer, or a synthetic
 * PENDING when the transaction turned out to be already known to the network
 * (callers then confirm it by hash, as they do for any PENDING).
 */
export async function submitSignedTx(
  url: string,
  tx: Signed,
): Promise<{ status: string; hash: string; errorResult?: unknown }> {
  const server = await factory(url);
  const breaker = breakers.stellarRpc;
  const hash = tx.hash().toString('hex');
  const maxAttempts = 1 + breaker.config.maxRetries;
  let uncertain = false;

  for (let attempt = 1; ; attempt++) {
    let res: { status: string; hash: string; errorResult?: unknown };
    try {
      res = await breaker.run(() => server.sendTransaction(tx), { retry: false });
    } catch (err) {
      if (!isTransientError(err)) {
        // Nothing reached the network on this attempt (open circuit, client
        // error). That is only a definite answer if no earlier attempt did.
        if (uncertain) throw new StellarSubmitUncertainError(hash, err);
        throw err;
      }
      uncertain = true;
      const seen = await lookup(url, hash);
      if (seen === 'SUCCESS' || seen === 'FAILED') return { status: 'PENDING', hash };
      if (seen !== 'NOT_FOUND' || attempt >= maxAttempts) {
        throw new StellarSubmitUncertainError(hash, err);
      }
      await breaker.pause(attempt);
      continue;
    }

    if (res.status === 'ERROR' && uncertain) {
      // A rejection after an uncertain attempt can be the earlier attempt
      // having been applied (bad sequence). Check before calling it a failure.
      const seen = await lookup(url, hash);
      if (seen === 'SUCCESS' || seen === 'FAILED') return { status: 'PENDING', hash };
      throw new StellarSubmitUncertainError(hash, new Error(`ERROR after uncertain attempt: ${JSON.stringify(res.errorResult)}`));
    }

    if (res.status === 'TRY_AGAIN_LATER' && attempt < maxAttempts) {
      // Not accepted into the queue: resending the same envelope is safe.
      await breaker.pause(attempt);
      continue;
    }

    return res;
  }
}
