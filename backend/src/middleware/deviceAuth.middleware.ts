import type { FastifyRequest, FastifyReply } from 'fastify';
import { createHash } from 'crypto';
import db from '../db/schema.js';
import { toSupportCode } from './requestId.middleware.js';

export interface DevicePayload {
  id: string;
  name: string;
}

/**
 * Device authentication middleware.
 * Verifies Bearer tokens against SHA-256 hashed keys stored in `device_keys`.
 * Decorates request with `device` containing { id, name }.
 */
export async function deviceAuthMiddleware(
  request: FastifyRequest,
  reply: FastifyReply
) {
  const requestId: string = (request as any).requestId ?? 'unknown';
  const supportCode = toSupportCode(requestId);

  const authHeader = request.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return reply.status(401).send({
      error: 'Unauthorized',
      message: 'Missing or invalid Authorization header (Bearer token required)',
      request_id: requestId,
      support_code: supportCode,
    });
  }

  const token = authHeader.substring(7).trim();
  if (!token) {
    return reply.status(401).send({
      error: 'Unauthorized',
      message: 'Empty device token provided',
      request_id: requestId,
      support_code: supportCode,
    });
  }

  const keyHash = createHash('sha256').update(token).digest('hex');

  const deviceKey = await db.getOne<{ id: string; name: string; is_active: boolean }>(
    'SELECT id, name, is_active FROM device_keys WHERE key_hash = $1 AND is_active = true',
    [keyHash]
  );

  if (!deviceKey) {
    return reply.status(401).send({
      error: 'Unauthorized',
      message: 'Invalid or inactive device token',
      request_id: requestId,
      support_code: supportCode,
    });
  }

  // Update last_used_at timestamp asynchronously
  db.execute('UPDATE device_keys SET last_used_at = NOW() WHERE id = $1', [deviceKey.id]).catch(
    () => {}
  );

  (request as any).device = {
    id: deviceKey.id,
    name: deviceKey.name,
  } as DevicePayload;
}
