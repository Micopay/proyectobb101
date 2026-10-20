import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { authMiddleware } from '../middleware/auth.middleware.js';
import { verifyWebhookSignature } from '../lib/webhook-auth.js';
import db from '../db/schema.js';
import { UpstreamError, ValidationError, ForbiddenError, NotFoundError } from '../utils/errors.js';
import {
  createQuote,
  createOrder,
  getOrder,
  regenerateOrderTx,
  getCetesIdentifier,
} from '../services/etherfuse.service.js';
import { assertKycTierSufficient } from '../services/kyc-gate.service.js';

interface RampUserRow {
  stellar_address: string;
  etherfuse_customer_id: string | null;
  etherfuse_bank_account_id: string | null;
}

async function requireOnboardedUser(userId: string): Promise<RampUserRow> {
  const user = await db.getOne<RampUserRow>(
    'SELECT stellar_address, etherfuse_customer_id, etherfuse_bank_account_id FROM users WHERE id = $1',
    [userId],
  );
  if (!user?.etherfuse_customer_id || !user?.etherfuse_bank_account_id) {
    throw new ForbiddenError('KYC requerido antes de continuar');
  }
  return user;
}

function ensureEtherfuseConfigured() {
  if (!process.env.ETHERFUSE_API_KEY) {
    throw new UpstreamError(
      'ETHERFUSE_NOT_CONFIGURED',
      'El servicio de rampa SPEI no está disponible por el momento.',
      'ETHERFUSE_API_KEY not configured',
      503,
    );
  }
}

/**
 * order_id is a backend-generated UUID handed to Etherfuse, never guessable —
 * but nothing previously stopped one authenticated user from polling another
 * user's order if they learned its ID. This records ownership at creation and
 * enforces it on every subsequent read (see docs/AUDIT_MOBILE_MAINNET.md,
 * "IDOR ramp order"). Orders created before this migration have no row here —
 * fail open for those (log + allow) rather than break in-flight orders.
 */
async function recordRampOrderOwner(orderId: string, userId: string): Promise<void> {
  await db.execute(
    'INSERT INTO ramp_orders (order_id, user_id) VALUES ($1, $2)',
    [orderId, userId],
  );
}

async function assertRampOrderOwnership(orderId: string, userId: string, request: { log: { warn: (obj: unknown, msg: string) => void } }): Promise<void> {
  const owner = await db.getOne<{ user_id: string }>(
    'SELECT user_id FROM ramp_orders WHERE order_id = $1',
    [orderId],
  );
  if (!owner) {
    request.log.warn({ order_id: orderId, user_id: userId, category: 'ramp' }, '[ramp] Order has no recorded owner (pre-migration) — allowing');
    return;
  }
  if (owner.user_id !== userId) {
    throw new ForbiddenError('No tienes permiso para ver esta orden');
  }
}

export async function rampRoutes(app: FastifyInstance): Promise<void> {
  // Get quote: MXN->CETES (onramp) or CETES->MXN (offramp).
  app.post<{ Body: { type: 'onramp' | 'offramp'; sourceAmount: string } }>(
    '/defi/ramp/quote',
    { preHandler: [authMiddleware] },
    async (request: any) => {
      ensureEtherfuseConfigured();

      const { type, sourceAmount } = request.body ?? {};
      if (!type || !sourceAmount) {
        throw new ValidationError('type y sourceAmount son requeridos');
      }
      const amount = parseFloat(sourceAmount);
      if (isNaN(amount) || amount <= 0) {
        throw new ValidationError('sourceAmount invalido');
      }

      const user = await requireOnboardedUser(request.user.id);

      // #314: tiered KYC gate. Onramp amount is already MXN; offramp's
      // sourceAmount is CETES units, so amountMxn is left undefined there
      // (falls back to the operation's base tier requirement).
      await assertKycTierSufficient({
        userId: request.user.id,
        operationType: type === 'onramp' ? 'cash_in' : 'cash_out',
        amountMxn: type === 'onramp' ? amount : undefined,
      });

      try {
        const cetesIdentifier = await getCetesIdentifier(user.stellar_address);
        const quote = await createQuote({
          quoteId: randomUUID(),
          customerId: user.etherfuse_customer_id!,
          sourceAmount,
          walletAddress: user.stellar_address,
          quoteAssets:
            type === 'onramp'
              ? { type: 'onramp', sourceAsset: 'MXN', targetAsset: cetesIdentifier }
              : { type: 'offramp', sourceAsset: cetesIdentifier, targetAsset: 'MXN' },
        });

        return {
          quoteId: quote.quoteId,
          type,
          exchangeRate: quote.exchangeRate,
          sourceAmount: quote.sourceAmount,
          destinationAmount: quote.destinationAmount,
          feeAmount: quote.feeAmount,
          expiresAt: quote.expiresAt,
        };
      } catch (err: any) {
        throw new UpstreamError(
          'ETHERFUSE_QUOTE_FAILED',
          'No se pudo obtener la cotización. Intenta de nuevo.',
          err.message || 'Failed to create Etherfuse quote',
        );
      }
    },
  );

  // Create order: returns CLABE deposit instructions (onramp) or anchor account+memo (offramp).
  app.post<{ Body: { quoteId: string; useAnchor?: boolean } }>(
    '/defi/ramp/order',
    { preHandler: [authMiddleware] },
    async (request: any) => {
      ensureEtherfuseConfigured();

      const { quoteId, useAnchor } = request.body ?? {};
      if (!quoteId) {
        throw new ValidationError('quoteId es requerido');
      }

      const user = await requireOnboardedUser(request.user.id);
      const orderId = randomUUID();

      try {
        const result = await createOrder({
          orderId,
          quoteId,
          bankAccountId: user.etherfuse_bank_account_id!,
          publicKey: user.stellar_address,
          useAnchor,
        });

        await recordRampOrderOwner(orderId, request.user.id);

        return 'offramp' in result ? result.offramp : result.onramp;
      } catch (err: any) {
        throw new UpstreamError(
          'ETHERFUSE_ORDER_FAILED',
          'No se pudo crear la orden. Intenta de nuevo.',
          err.message || 'Failed to create Etherfuse order',
        );
      }
    },
  );

  // Poll order status.
  app.get<{ Params: { orderId: string } }>(
    '/defi/ramp/order/:orderId',
    { preHandler: [authMiddleware] },
    async (request) => {
      const { orderId } = request.params;
      await assertRampOrderOwnership(orderId, request.user.id, request);
      try {
        const order = await getOrder(orderId);
        return { orderId: order.orderId, status: order.status, type: order.orderType };
      } catch (err: any) {
        if (err.message === 'ORDER_NOT_FOUND') {
          throw new NotFoundError('Orden no encontrada');
        }
        throw new UpstreamError(
          'ETHERFUSE_ORDER_FETCH_FAILED',
          'No se pudo consultar la orden. Intenta de nuevo.',
          err.message || 'Failed to fetch Etherfuse order',
        );
      }
    },
  );

  // Regenerate expired Stellar transaction (offramp anchor mode, or stale onramp claim TX).
  app.post<{ Params: { orderId: string } }>(
    '/defi/ramp/order/:orderId/regenerate_tx',
    { preHandler: [authMiddleware] },
    async (request, reply) => {
      const { orderId } = request.params;
      await assertRampOrderOwnership(orderId, request.user.id, request);
      try {
        const { status, body } = await regenerateOrderTx(orderId);
        return reply.status(status).send(body ?? {});
      } catch (err: any) {
        throw new UpstreamError(
          'ETHERFUSE_REGENERATE_TX_FAILED',
          'No se pudo regenerar la transacción. Intenta de nuevo.',
          err.message || 'Failed to regenerate Etherfuse order tx',
        );
      }
    },
  );

  // Webhook endpoints (Etherfuse calls these on order/KYC status changes).
  // One URL per event type — each POST /ramp/webhook subscription gets its
  // own signing secret, and the X-Signature header alone doesn't tell you
  // which one to verify against. See docs/SPEI_ANCHOR_PLAN.md.
  app.post<{ Body: unknown }>('/defi/ramp/webhook/order', async (request, reply) => {
    const signature = request.headers['x-signature'] as string | undefined;
    const secret = process.env.ETHERFUSE_WEBHOOK_SECRET_ORDER;
    const { valid, error } = verifyWebhookSignature(request.body, signature, secret);
    if (!valid) {
      return reply.status(401).send({ error: `webhook signature verification failed: ${error}` });
    }
    request.log.info({ body: request.body }, 'Etherfuse order_updated webhook');
    return reply.status(200).send({ received: true });
  });

  app.post<{ Body: unknown }>('/defi/ramp/webhook/kyc', async (request, reply) => {
    const signature = request.headers['x-signature'] as string | undefined;
    const secret = process.env.ETHERFUSE_WEBHOOK_SECRET_KYC;
    const { valid, error } = verifyWebhookSignature(request.body, signature, secret);
    if (!valid) {
      return reply.status(401).send({ error: `webhook signature verification failed: ${error}` });
    }
    request.log.info({ body: request.body }, 'Etherfuse kyc_updated webhook');
    return reply.status(200).send({ received: true });
  });
}
