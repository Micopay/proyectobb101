import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'crypto';
import db from '../db/schema.js';
import { config } from '../config.js';
import { createRateLimiter } from '../middleware/rateLimit.middleware.js';
import { NotFoundError } from '../utils/errors.js';
import { revokeToken } from '../services/tokenRevocation.service.js';
import { authMiddleware } from '../middleware/auth.middleware.js';
import { issueChallenge, verifyAndConsumeChallenge } from '../services/challenge.service.js';

const authRateLimit = createRateLimiter({
  windowMs: config.authRateLimitWindowMs,
  max: config.authRateLimitMax,
});

export async function authRoutes(app: FastifyInstance) {
  /**
   * POST /auth/challenge
   * Generate a challenge for a Stellar address to sign (simplified SEP-10).
   * Also used by POST /users/register to prove key possession before signup.
   */
  app.post('/auth/challenge', {
    preHandler: [authRateLimit],
    schema: {
      body: {
        type: 'object',
        required: ['stellar_address'],
        properties: {
          stellar_address: { type: 'string', minLength: 56, maxLength: 56 },
        },
        additionalProperties: false,
      },
    },
  }, async (request, reply) => {
    const { stellar_address } = request.body as { stellar_address: string };

    const { challenge, expiresAt } = issueChallenge(stellar_address);

    request.log.info({ stellar_address, category: 'auth' }, '[auth] Challenge issued');
    return { challenge, expires_at: new Date(expiresAt).toISOString() };
  });

  /**
   * POST /auth/token
   * Verify the signed challenge and issue a JWT.
   *
   * In MVP mode: we skip actual Stellar signature verification and just issue the token.
   * In production: verify using Stellar SDK's Keypair.verify().
   */
  app.post('/auth/token', {
    preHandler: [authRateLimit],
    schema: {
      body: {
        type: 'object',
        required: ['stellar_address', 'challenge', 'signature'],
        properties: {
          stellar_address: { type: 'string', minLength: 56, maxLength: 56 },
          challenge: { type: 'string' },
          signature: { type: 'string' },
        },
        additionalProperties: false,
      },
    },
  }, async (request, reply) => {
    const { stellar_address, challenge, signature } = request.body as {
      stellar_address: string;
      challenge: string;
      signature: string;
    };

    await verifyAndConsumeChallenge(stellar_address, challenge, signature);

    // Find or create user
    let user = await db.getOne(
      'SELECT id, stellar_address, username FROM users WHERE stellar_address = $1',
      [stellar_address],
    );

    if (!user) {
      throw new NotFoundError(
        'USER_NOT_FOUND',
        'Usuario no encontrado. Por favor, regístrate primero.',
        'User not found. Register first via POST /users/register'
      );
    }

    // Issue JWT with a unique JTI so the token can be individually revoked on logout
    const jti = randomUUID();
    const token = app.jwt.sign(
      { id: user.id, stellar_address: user.stellar_address, jti },
      { expiresIn: config.jwtExpiry },
    );

    request.log.info({ stellar_address, user_id: user.id, category: 'auth' }, '[auth] Token issued');
    return { token, user };
  });

  /**
   * POST /auth/logout
   * Revoke the current JWT. Any subsequent request using the same token will be
   * rejected by the auth middleware, even before the token naturally expires.
   */
  app.post('/auth/logout', {
    preHandler: [authMiddleware],
  }, async (request, reply) => {
    const { jti, exp, id } = request.user as { id: string; jti?: string; exp?: number; stellar_address: string };

    if (jti && exp) {
      await revokeToken(jti, id, new Date(exp * 1000));
    }

    request.log.info({ user_id: id, jti, category: 'auth' }, '[auth] Token revoked on logout');
    return reply.status(200).send({ message: 'Logged out successfully' });
  });
}
