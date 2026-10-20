import type { FastifyInstance } from 'fastify';
import { authMiddleware } from '../middleware/auth.middleware.js';
import { createRateLimiter } from '../middleware/rateLimit.middleware.js';
import { config } from '../config.js';
import db from '../db/schema.js';
import * as tradeService from '../services/trade.service.js';
import { recordTradeDispute, assertCanOpenDispute, touchUserDevice, getClientContext } from '../services/abuse.service.js';
import { NotFoundError, ValidationError } from '../utils/errors.js';

const messageRateLimit = createRateLimiter({
  windowMs: config.messageRateLimitWindowMs || 60000,
  max: config.messageRateLimitMax || 30,
  keyGenerator: (req) => `${req.user?.id ?? req.ip}:messages`,
});

const disputeRateLimit = createRateLimiter({
  windowMs: config.disputeRateLimitWindowMs || 3600000,
  max: config.disputeRateLimitMax || 5,
  keyGenerator: (req) => `${req.user?.id ?? req.ip}:disputes`,
});

export async function tradeSafetyRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authMiddleware);

  /**
   * GET /trades/:id/messages
   * Trade-scoped chat messages.
   */
  app.get('/trades/:id/messages', {
    preHandler: [messageRateLimit],
  }, async (request) => {
    const { id } = request.params as { id: string };
    await tradeService.getTradeById(id, request.user.id);

    const messages = await db.getMany(
      `SELECT id, trade_id, sender_id, body, created_at
       FROM trade_messages
       WHERE trade_id = $1
       ORDER BY created_at ASC`,
      [id],
    );

    return { messages };
  });

  /**
   * POST /trades/:id/messages
   * Send a trade-scoped chat message.
   */
  app.post('/trades/:id/messages', {
    preHandler: [messageRateLimit],
    schema: {
      body: {
        type: 'object',
        required: ['body'],
        properties: {
          body: { type: 'string', minLength: 1, maxLength: 2000 },
        },
        additionalProperties: false,
      },
    },
  }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const { body } = request.body as { body: string };

    await tradeService.getTradeById(id, request.user.id);
    await touchUserDevice(request.user.id, getClientContext(request));

    const message = await db.getOne(
      `INSERT INTO trade_messages (trade_id, sender_id, body)
       VALUES ($1, $2, $3)
       RETURNING id, trade_id, sender_id, body, created_at`,
      [id, request.user.id, body.trim()],
    );

    reply.status(201);
    return { message };
  });

  /**
   * POST /trades/:id/dispute and POST /trades/:id/disputes
   * Open a dispute on a trade.
   */
  const handleDisputePost = async (request: any, reply: any) => {
    const { id } = request.params as { id: string };
    const { reason, evidence_urls } = request.body as { reason: string; evidence_urls?: string[] };

    const trade = await tradeService.getTradeById(id, request.user.id);
    if (!['locked', 'revealing', 'completed', 'pending'].includes(trade.status)) {
      throw new ValidationError(
        'DISPUTE_NOT_ALLOWED',
        'Solo puedes abrir una disputa cuando la operación está en curso o completada.',
        `Dispute not allowed in status ${trade.status}`,
      );
    }

    await assertCanOpenDispute(request.user.id, id);

    const dispute = await recordTradeDispute({
      tradeId: id,
      reportedBy: request.user.id,
      reason,
      evidenceUrls: evidence_urls,
    });

    reply.status(201);
    return { dispute };
  };

  const disputeSchema = {
    body: {
      type: 'object',
      required: ['reason'],
      properties: {
        reason: { type: 'string', minLength: 1, maxLength: 2000 },
        evidence_urls: {
          type: 'array',
          items: { type: 'string' },
        },
      },
      additionalProperties: false,
    },
  };

  app.post('/trades/:id/dispute', { preHandler: [disputeRateLimit], schema: disputeSchema }, handleDisputePost);
  app.post('/trades/:id/disputes', { preHandler: [disputeRateLimit], schema: disputeSchema }, handleDisputePost);
}
