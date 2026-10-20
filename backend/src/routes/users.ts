import type { FastifyInstance } from "fastify";
import { randomUUID } from "crypto";
import { StrKey } from "@stellar/stellar-sdk";
import db from "../db/schema.js";
import { config } from "../config.js";
import { authMiddleware } from "../middleware/auth.middleware.js";
import { deleteAccount } from "../services/account.service.js";
import { createRateLimiter } from '../middleware/rateLimit.middleware.js';
import { ConflictError, ValidationError } from "../utils/errors.js";
import { verifyAndConsumeChallenge } from "../services/challenge.service.js";
import { setProviderAvailability } from "../services/providerEnrollment.service.js";

const authRateLimit = createRateLimiter({
  windowMs: config.authRateLimitWindowMs,
  max: config.authRateLimitMax,
});

export async function userRoutes(app: FastifyInstance) {
  /**
   * POST /users/register
   * Create a new user + wallet. Returns a JWT so the user is immediately authenticated.
   *
   * Requires a signed challenge (call POST /auth/challenge first) proving
   * possession of stellar_address's private key — otherwise anyone could
   * register someone else's public Stellar address before they do (address
   * squatting), since Stellar addresses are public. See
   * docs/AUDIT_MOBILE_MAINNET.md, "Registro sin prueba de posesión de llave".
   */
  app.post(
    "/users/register",
    {
      preHandler: [authRateLimit],
      schema: {
        body: {
          type: "object",
          required: ["stellar_address", "username", "challenge", "signature"],
          properties: {
            stellar_address: { type: "string", minLength: 56, maxLength: 56 },
            username: {
              type: "string",
              minLength: 3,
              maxLength: 30,
              pattern: "^[a-zA-Z0-9_]+$",
            },
            phone_hash: { type: "string", maxLength: 64 },
            challenge: { type: "string" },
            signature: { type: "string" },
          },
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      const { stellar_address, username, phone_hash, challenge, signature } = request.body as {
        stellar_address: string;
        username: string;
        phone_hash?: string;
        challenge: string;
        signature: string;
      };

      if (!StrKey.isValidEd25519PublicKey(stellar_address)) {
        throw new ValidationError(
          "INVALID_STELLAR_ADDRESS",
          "La dirección de Stellar no es válida.",
          "stellar_address failed StrKey.isValidEd25519PublicKey",
        );
      }

      await verifyAndConsumeChallenge(stellar_address, challenge, signature);

      // Check for existing user. Two very distinct situations hide behind the
      // same 409, and collapsing them into one message is a dead end for the
      // user: if the collision is on stellar_address, this device already has
      // an account and picking another username can never fix it — the caller
      // should log in instead (the device key already proves the account is
      // theirs). Only a username collision is worth asking for a new name.
      const existing = await db.getOne(
        "SELECT id, stellar_address, username FROM users WHERE stellar_address = $1 OR username = $2",
        [stellar_address, username],
      );
      if (existing) {
        if (existing.stellar_address === stellar_address) {
          throw new ConflictError(
            "ADDRESS_ALREADY_REGISTERED",
            "Este dispositivo ya tiene una cuenta de Micopay. Inicia sesión para entrar.",
            `stellar_address ${stellar_address} is already registered as "${existing.username}"`,
          );
        }
        throw new ConflictError(
          "USERNAME_TAKEN",
          "Ese nombre de usuario ya está ocupado. Elige otro.",
          `username "${username}" is already taken by another account`,
        );
      }

      // RED-1: abrir una cuenta NO te mete en Red MicoPay. Antes esto pasaba
      // `true` y publicaba a toda persona registrada como proveedora de efectivo
      // en el mapa, sin que lo hubiera decidido. El alta es explicita y vive en
      // `provider_status`, que arranca en 'not_enrolled' por defecto.
      const user = await db.getOne(
        `INSERT INTO users (stellar_address, username, phone_hash, merchant_available)
         VALUES ($1, $2, $3, $4)
         RETURNING id, stellar_address, username, merchant_available, provider_status, created_at`,
        [stellar_address, username, phone_hash || null, false],
      );

      // Create wallet record
      await db.execute(
        `INSERT INTO wallets (user_id, stellar_address) VALUES ($1, $2)`,
        [user.id, stellar_address],
      );

      // Issue JWT (with jti so it's revocable via logout, same as /auth/token)
      const jti = randomUUID();
      const token = app.jwt.sign(
        { id: user.id, stellar_address: user.stellar_address, jti },
        { expiresIn: config.jwtExpiry },
      );

      request.log.info({ user_id: user.id, stellar_address, category: 'auth' }, '[auth] User registered');
      reply.status(201);
      return { user, token };
    },
  );

  /**
   * GET /users/me
   * Get the authenticated user's profile.
   */
  app.get(
    "/users/me",
    {
      preHandler: [authMiddleware],
    },
    async (request) => {
      const userId = request.user.id;

      const user = await db.getOne(
        `SELECT u.*, w.wallet_type
       FROM users u
       LEFT JOIN wallets w ON w.user_id = u.id
       WHERE u.id = $1 AND u.deleted_at IS NULL`,
        [userId],
      );

      // Reputation stats derived from the trades table (buyer or seller side).
      const stats = await db.getOne<{
        trades_completed: string;
        trades_total: string;
      }>(
        `SELECT
           COUNT(*) FILTER (WHERE status = 'completed')                           AS trades_completed,
           COUNT(*) FILTER (WHERE status IN ('completed', 'cancelled', 'refunded')) AS trades_total
         FROM trades
         WHERE buyer_id = $1 OR seller_id = $1`,
        [userId],
      ).catch(() => null);

      const completed = stats ? parseInt(stats.trades_completed, 10) || 0 : 0;
      const total = stats ? parseInt(stats.trades_total, 10) || 0 : 0;
      const completionRate = total > 0 ? Math.round((completed / total) * 100) : null;

      // Reputation tier from completed-trade volume.
      const tier =
        completed >= 50 ? 'Oro' : completed >= 10 ? 'Plata' : completed >= 1 ? 'Bronce' : 'Nuevo';

      request.log.info({ user_id: userId, category: 'auth' }, '[auth] Profile fetched');
      return {
        user: {
          ...user,
          trades_completed: completed,
          completion_rate: completionRate,
          reputation_tier: tier,
        },
      };
    },
  );

  /**
   * POST /users/me/delete
   * Permanently delete the authenticated account after username confirmation.
   */
  app.post(
    "/users/me/delete",
    {
      preHandler: [authMiddleware],
      schema: {
        body: {
          type: "object",
          required: ["username"],
          properties: {
            username: { type: "string", minLength: 3, maxLength: 30 },
          },
          additionalProperties: false,
        },
      },
    },
    async (request) => {
      const { username } = request.body as { username: string };
      return deleteAccount(request.user.id, username);
    },
  );

  /**
   * PATCH /users/me/push_token
   * Register or update the authenticated merchant's FCM push token.
   * Called after the Capacitor app receives a token from Firebase Cloud Messaging.
   */
  app.patch(
    "/users/me/push_token",
    {
      preHandler: [authMiddleware],
      schema: {
        body: {
          type: "object",
          required: ["push_token"],
          properties: {
            push_token: { type: "string", minLength: 1, maxLength: 512 },
          },
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      const { push_token } = request.body as { push_token: string };
      const userId = request.user.id;

      if (!push_token || push_token.trim().length === 0) {
        reply.status(400).send({
          code: "INVALID_PUSH_TOKEN",
          message: "Push token cannot be empty",
        });
        return;
      }

      try {
        await db.execute(
          `UPDATE users
           SET push_token = $1, push_token_updated_at = NOW()
           WHERE id = $2`,
          [push_token, userId]
        );

        request.log.info(
          { user_id: userId, category: "push" },
          "[push] Push token registered"
        );

        reply.status(200);
        return { success: true };
      } catch (err) {
        request.log.error(
          { err, user_id: userId, category: "push" },
          "[push] Failed to update push token"
        );
        reply.status(500).send({
          code: "PUSH_TOKEN_UPDATE_FAILED",
          message: "Failed to register push token",
        });
      }
    }
  );

  /**
   * PATCH /users/me/availability
   * Sets whether the authenticated merchant is currently accepting new trades.
   * `paused` is stored the same as `offline` (merchant_available=false) — the
   * distinction is UI-only (temporary vs deliberate) for now.
   */
  app.patch(
    "/users/me/availability",
    {
      preHandler: [authMiddleware],
      schema: {
        body: {
          type: "object",
          required: ["availability"],
          properties: {
            availability: { type: "string", enum: ["online", "offline", "paused"] },
          },
          additionalProperties: false,
        },
      },
    },
    async (request) => {
      const { availability } = request.body as { availability: "online" | "offline" | "paused" };
      const userId = request.user.id;

      // RED-1: la escritura canonica vive en un solo sitio. Antes esto tocaba
      // solo `merchant_available` y dejaba `users.availability` obsoleta, asi
      // que el mapa podia mostrar disponible a quien se habia puesto en pausa.
      // Ademas, quien no es agente activo no tiene disponibilidad que cambiar.
      const result = await setProviderAvailability(userId, availability);

      request.log.info(
        { user_id: userId, availability, category: "merchant" },
        "[merchant] Availability updated",
      );

      return result;
    },
  );
}
