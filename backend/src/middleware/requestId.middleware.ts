import { randomUUID } from 'crypto';
import type { FastifyInstance } from 'fastify';

/**
 * Generates a short, human-friendly support code from a full UUID.
 * Example: "3f2a-bc91" — easy to read over the phone or screenshot.
 */
export function toSupportCode(requestId: string): string {
  const hex = requestId.replace(/-/g, '');
  return `${hex.slice(0, 4)}-${hex.slice(4, 8)}`;
}

/**
 * Registers an `onRequest` hook that:
 * 1. Reads or generates an `x-request-id` header per request.
 * 2. Binds the ID to the Pino child logger so every log line includes `request_id`.
 * 3. Echoes the ID back in the response via the `x-request-id` header.
 */
export function registerRequestId(app: FastifyInstance) {
  app.addHook('onRequest', async (request, reply) => {
    const requestId =
      (request.headers['x-request-id'] as string | undefined) || randomUUID();

    // Decorate request so route handlers / services can access it
    (request as any).requestId = requestId;

    // Bind to Pino child logger — every subsequent request.log call includes request_id
    request.log = request.log.child({ request_id: requestId });

    // Echo back so the client always knows which ID to quote
    reply.header('x-request-id', requestId);
  });
}
