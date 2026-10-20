import type { FastifyInstance } from 'fastify';
import { authMiddleware } from '../middleware/auth.middleware.js';
import { AppError, UpstreamError } from '../utils/errors.js';
import { submitSignedTx } from '../lib/stellarRpc.js';

export async function stellarRoutes(app: FastifyInstance) {
  /**
   * POST /stellar/submit
   * Relay a signed transaction to Stellar.
   * Rate limited (10 per minute per IP).
   */
  app.post('/stellar/submit', {
    preHandler: [authMiddleware],
    config: {
      rateLimit: {
        max: 10,
        timeWindow: '1 minute',
      },
    },
    schema: {
      body: {
        type: 'object',
        required: ['xdr'],
        properties: {
          xdr: { type: 'string' },
        },
        additionalProperties: false,
      },
    },
  }, async (request, reply) => {
    const { xdr } = request.body as { xdr: string };

    try {
      const { TransactionBuilder, Networks } = await import('@stellar/stellar-sdk');
      const { config } = await import('../config.js');

      if (config.mockStellar) {
        // In mock mode, just return a fake hash
        const fakeHash = `mock_${Date.now()}_${Math.random().toString(36).substring(7)}`;
        return { hash: fakeHash, status: 'PENDING' };
      }

      const networkPassphrase =
        config.stellarNetwork === 'TESTNET' ? Networks.TESTNET : Networks.PUBLIC;

      const tx = TransactionBuilder.fromXDR(xdr, networkPassphrase);
      const result = await submitSignedTx(config.stellarRpcUrl, tx);

      return { hash: result.hash, status: result.status };
    } catch (err: any) {
      // Open circuit, timeout or uncertain submission: the error handler
      // answers with its own status and a message the app can show.
      if (err instanceof AppError) throw err;
      request.log.error({ err: err.message, category: 'stellar.tx' }, '[stellar] Submit failed');
      return reply.status(500).send({ error: err.message || 'Failed to submit transaction' });
    }
  });
}
