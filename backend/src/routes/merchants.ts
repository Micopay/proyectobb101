import type { FastifyInstance } from 'fastify';
import { authMiddleware } from '../middleware/auth.middleware.js';
import { createRateLimiter } from '../middleware/rateLimit.middleware.js';
import {
  getOrCreateMerchantConfig,
  updateMerchantConfig,
  getAvailableMerchants,
} from '../services/merchant.service.js';
import {
  enrollProvider,
  getProviderReadiness,
  activateProvider,
} from '../services/providerEnrollment.service.js';
import db from '../db/schema.js';

// G1: /merchants/available is public and unauthenticated — without a rate
// limit it lets anyone scrape the full census of merchant locations by
// sweeping lat/lng. 30 req/min per IP is generous for legitimate use (the
// app makes one request per search).
const discoveryRateLimit = createRateLimiter({ windowMs: 60_000, max: 30 });

export async function merchantRoutes(app: FastifyInstance) {
  /**
   * GET /merchants/available
   * Public. Returns merchants near the caller that can handle the requested amount.
   *
   * Query params:
   *   lat        – caller latitude  (required)
   *   lng        – caller longitude (required)
   *   radius_km  – search radius in km (default 5, max 50)
   *   amount_mxn – trade amount in MXN (required)
   *   flow       – 'cashout' | 'deposit' (optional, reserved)
   */
  app.get('/merchants/available', {
    preHandler: [discoveryRateLimit],
    schema: {
      querystring: {
        type: 'object',
        required: ['lat', 'lng', 'amount_mxn'],
        properties: {
          lat:        { type: 'number', minimum: -90,  maximum: 90  },
          lng:        { type: 'number', minimum: -180, maximum: 180 },
          radius_km:  { type: 'number', minimum: 0.1,  maximum: 50, default: 5 },
          amount_mxn: { type: 'number', minimum: 1 },
          flow:       { type: 'string', enum: ['cashout', 'deposit'] },
        },
        additionalProperties: false,
      },
    },
  }, async (request, reply) => {
    const q = request.query as {
      lat: number;
      lng: number;
      radius_km?: number;
      amount_mxn: number;
      flow?: string;
    };

    const merchants = await getAvailableMerchants({
      lat: q.lat,
      lng: q.lng,
      radius_km: q.radius_km ?? 5,
      amount_mxn: q.amount_mxn,
      flow: q.flow,
    });

    return reply.send({ merchants });
  });

  // ── Authenticated routes ──────────────────────────────────────────────────
  // Auth is applied per-route (NOT via a plugin-level addHook) so the public
  // /merchants/available discovery endpoint above stays unauthenticated.

  // ── RED-1: alta explicita en Red MicoPay ──────────────────────────────────
  //
  // Tres endpoints, tres hechos distintos: unirse, ver que falta, y activarse.
  // Ninguno los mezcla, porque mezclarlos fue el defecto original.

  /**
   * POST /merchants/me/enroll
   * Inicia el alta como agente. Idempotente: llamarlo dos veces no crea nada
   * nuevo ni degrada a quien ya esta activo.
   */
  app.post('/merchants/me/enroll', { preHandler: [authMiddleware] }, async (request) => {
    const readiness = await enrollProvider(request.user.id);
    request.log.info(
      { user_id: request.user.id, status: readiness.status, category: 'merchant' },
      '[merchant] Provider enrollment started',
    );
    return readiness;
  });

  /**
   * GET /merchants/me/readiness
   * Que le falta a esta persona para poder activarse. La verdad la dice el
   * servidor: la app no debe deducir la elegibilidad por su cuenta.
   */
  app.get('/merchants/me/readiness', { preHandler: [authMiddleware] }, async (request) => {
    return getProviderReadiness(request.user.id);
  });

  /**
   * POST /merchants/me/activate
   * Activa al agente. Falla cerrada: recalcula contra la base, no confia en lo
   * que la app crea saber.
   */
  app.post('/merchants/me/activate', { preHandler: [authMiddleware] }, async (request) => {
    const readiness = await activateProvider(request.user.id);
    request.log.info(
      { user_id: request.user.id, status: readiness.status, category: 'merchant' },
      '[merchant] Provider activated',
    );
    return readiness;
  });

  app.get('/merchants/me/config', { preHandler: [authMiddleware] }, async (request) => {
    const config = await getOrCreateMerchantConfig(request.user.id);
    return {
      config,
      daily_cap_reset_timezone: 'UTC',
      daily_cap_reset_time: '00:00',
      daily_cap_reset_note: 'Daily cap usage resets every day at 00:00 UTC.',
    };
  });

  app.put('/merchants/me/config', {
    preHandler: [authMiddleware],
    schema: {
      body: {
        type: 'object',
        required: ['rate_percent', 'min_trade_mxn', 'max_trade_mxn', 'daily_cap_mxn'],
        properties: {
          rate_percent:  { type: 'number', minimum: 0, maximum: 100 },
          min_trade_mxn: { type: 'integer', minimum: 100, maximum: 50000 },
          max_trade_mxn: { type: 'integer', minimum: 100, maximum: 50000 },
          daily_cap_mxn: { type: 'integer', minimum: 100 },
        },
        additionalProperties: false,
      },
    },
  }, async (request) => {
    const body = request.body as {
      rate_percent: number;
      min_trade_mxn: number;
      max_trade_mxn: number;
      daily_cap_mxn: number;
    };

    const config = await updateMerchantConfig(request.user.id, {
      ratePercent: body.rate_percent,
      minTradeMxn: body.min_trade_mxn,
      maxTradeMxn: body.max_trade_mxn,
      dailyCapMxn: body.daily_cap_mxn,
    });

    return {
      config,
      daily_cap_reset_timezone: 'UTC',
      daily_cap_reset_time: '00:00',
      daily_cap_reset_note: 'Daily cap usage resets every day at 00:00 UTC.',
    };
  });

  /**
   * PATCH /merchants/me/location
   * Authenticated. Sets or updates the provider's location.
   *
   * RED-3: `address_text` era un solo campo de texto libre que viajaba tal
   * cual en el discovery anonimo. Ahora se piden dos cosas distintas, porque
   * lo son:
   *
   *   area_label     zona amplia, publica. "Centro, CDMX".
   *   meeting_point  punto exacto, privado. Solo lo ven las dos partes de una
   *                  operacion aceptada, salvo consentimiento explicito.
   *
   * `publish_storefront` es ese consentimiento y por omision es false. Tener
   * `meeting_point` lleno NO se interpreta como permiso para publicarlo.
   */
  app.patch('/merchants/me/location', {
    preHandler: [authMiddleware],
    schema: {
      body: {
        type: 'object',
        required: ['latitude', 'longitude'],
        properties: {
          latitude:           { type: 'number', minimum: -90,  maximum: 90  },
          longitude:          { type: 'number', minimum: -180, maximum: 180 },
          area_label:         { type: 'string', maxLength: 120 },
          meeting_point:      { type: 'string', maxLength: 200 },
          publish_storefront: { type: 'boolean' },
        },
        additionalProperties: false,
      },
    },
  }, async (request, reply) => {
    const body = request.body as {
      latitude: number;
      longitude: number;
      area_label?: string;
      meeting_point?: string;
      publish_storefront?: boolean;
    };

    // Ensure config row exists before updating location
    await getOrCreateMerchantConfig(request.user.id);

    const updated = await db.getOne(
      `UPDATE merchant_configs
       SET latitude = $2,
           longitude = $3,
           area_label = $4,
           meeting_point = $5,
           publish_storefront = $6,
           updated_at = NOW()
       WHERE user_id = $1
       RETURNING user_id, latitude, longitude, area_label, meeting_point,
                 publish_storefront, updated_at`,
      [
        request.user.id,
        body.latitude,
        body.longitude,
        body.area_label ?? null,
        body.meeting_point ?? null,
        // Consentimiento explicito: ausente significa NO publicar.
        body.publish_storefront === true,
      ],
    );

    return reply.send({ location: updated });
  });
}
