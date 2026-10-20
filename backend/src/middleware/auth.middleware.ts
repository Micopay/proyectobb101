import type { FastifyRequest, FastifyReply } from "fastify";
import db from "../db/schema.js";
import { toSupportCode } from "./requestId.middleware.js";
import { isRevoked } from "../services/tokenRevocation.service.js";

/**
 * JWT authentication middleware.
 * Decorates request with `user` containing { id, stellar_address }.
 */
export async function authMiddleware(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const requestId: string = (request as any).requestId ?? "unknown";
  const supportCode = toSupportCode(requestId);

  try {
    await request.jwtVerify();

    const { id, jti } = request.user as { id: string; stellar_address: string; jti?: string };

    // Reject tokens that have been explicitly revoked (e.g. via logout)
    if (jti && await isRevoked(jti)) {
      return reply.status(401).send({
        error: "Unauthorized",
        message: "Token has been revoked",
        request_id: requestId,
        support_code: supportCode,
      });
    }

    const activeUser = await db.getOne<{ id: string; is_admin?: boolean; is_banned?: boolean; is_suspended?: boolean | null }>(
      "SELECT id, is_admin, is_banned, is_suspended FROM users WHERE id = $1 AND deleted_at IS NULL",
      [id],
    );

    if (!activeUser) {
      return reply.status(401).send({
        error: "Unauthorized",
        message: "Account not found or deleted",
        request_id: requestId,
        support_code: supportCode,
      });
    }

    if (activeUser.is_suspended) {
      return reply.status(403).send({
        code: "ACCOUNT_SUSPENDED",
        message:
          "Tu cuenta está suspendida. Contacta a soporte si crees que es un error.",
        request_id: requestId,
        support_code: supportCode,
      });
    }

    if (activeUser.is_banned) {
      return reply.status(403).send({
        error: "Forbidden",
        message: "Account is banned",
        request_id: requestId,
        support_code: supportCode,
      });
    }
  } catch (err) {
    return reply
      .status(401)
      .send({
        error: "Unauthorized",
        message: "Invalid or missing JWT token",
        request_id: requestId,
        support_code: supportCode,
      });
  }
}

/**
 * Admin authentication middleware.
 * Verifies JWT and checks that the user has admin rights.
 */
export async function adminMiddleware(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  await authMiddleware(request, reply);
  if (reply.sent) return;

  const { id } = request.user;
  const user = await db.getOne<{ is_admin?: boolean }>(
    "SELECT is_admin FROM users WHERE id = $1",
    [id],
  );

  if (!user?.is_admin) {
    return reply
      .status(403)
      .send({
        error: "Forbidden",
        message: "Admin access required",
      });
  }
}

/**
 * Extend Fastify's type system to include the JWT user payload.
 */
declare module "@fastify/jwt" {
  interface FastifyJWT {
    payload: { id: string; stellar_address: string; is_admin?: boolean; jti?: string };
    user: { id: string; stellar_address: string; is_admin?: boolean; jti?: string; exp?: number };
  }
}
