import type { FastifyInstance } from 'fastify';
import { authMiddleware } from '../middleware/auth.middleware.js';
import db from '../db/schema.js';

export async function clientErrorRoutes(app: FastifyInstance) {
  /**
   * POST /client-errors
   *
   * APK / frontend reports a client-side error so it appears in backend logs
   * and is stored for support investigation. Auth is optional — unauthenticated
   * reports are accepted (e.g. crashes before login) but user_id is recorded
   * when available.
   */
  app.post('/client-errors', {
    schema: {
      body: {
        type: 'object',
        required: ['message'],
        properties: {
          request_id: { type: 'string', maxLength: 128 },
          error_code: { type: 'string', maxLength: 64 },
          message: { type: 'string', maxLength: 2048 },
          stack: { type: 'string', maxLength: 8192 },
          context: { type: 'object', additionalProperties: true },
          app_version: { type: 'string', maxLength: 32 },
        },
        additionalProperties: false,
      },
    },
  }, async (request, reply) => {
    const body = request.body as {
      request_id?: string;
      error_code?: string;
      message: string;
      stack?: string;
      context?: Record<string, unknown>;
      app_version?: string;
    };

    // Try to extract user from JWT if present (don't fail if missing)
    let userId: string | null = null;
    try {
      await request.jwtVerify();
      userId = (request.user as { id: string }).id;
    } catch {
      // Unauthenticated report — that's fine
    }

    const userAgent = request.headers['user-agent'] || null;

    await db.execute(
      `INSERT INTO client_errors
        (request_id, user_id, error_code, message, stack, context, user_agent, app_version)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        body.request_id || null,
        userId,
        body.error_code || null,
        body.message,
        body.stack || null,
        body.context || {},
        userAgent,
        body.app_version || null,
      ],
    );

    request.log.warn(
      {
        category: 'client.error',
        error_code: body.error_code,
        client_request_id: body.request_id,
        user_id: userId,
        app_version: body.app_version,
      },
      `[client-error] ${body.message}`,
    );

    reply.status(201).send({ status: 'recorded' });
  });
}
