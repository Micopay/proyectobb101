import db from '../db/schema.js';
import { BadRequestError, NotFoundError } from '../utils/errors.js';
import { computeTradeFees, normalizeFeeFlow } from './tradeFees.js';

export const GLOBAL_MIN_AMOUNT_MXN = 100;
export const GLOBAL_MAX_AMOUNT_MXN = 50000;

export interface MerchantConfig {
  user_id: string;
  rate_percent: number;
  min_trade_mxn: number;
  max_trade_mxn: number;
  daily_cap_mxn: number;
  latitude: number | null;
  longitude: number | null;
  /** RED-3: zona publica. */
  area_label: string | null;
  /** RED-3: punto exacto. Privado salvo consentimiento explicito. */
  meeting_point: string | null;
  /** RED-3: consentimiento para publicar `meeting_point`. Nunca se infiere. */
  publish_storefront: boolean;
  updated_at: string;
}

export interface AvailableMerchant {
  seller_id: string;
  username: string;
  rate_percent: number;
  min_trade_mxn: number;
  max_trade_mxn: number;
  daily_cap_mxn: number;
  latitude: number;
  longitude: number;
  /**
   * RED-3: zona publica y no sensible. Sustituye a `address_text`, que era
   * texto libre y podia llevar un domicilio a un endpoint anonimo.
   */
  area_label: string | null;
  /** RED-3: solo si el proveedor consintio publicar su local. */
  storefront_address: string | null;
  distance_km: number;
  /** Lo que recibe el cliente: efectivo en retiro, saldo en deposito (H5). */
  payout_mxn: number;
  /** Lo que le cuesta al cliente: saldo en retiro (monto + comisiones), efectivo en deposito. */
  client_pays_mxn: number;
  /** Igual a `payout_mxn`. */
  client_receives_mxn: number;
  /** Comision del agente en MXN, para este monto. */
  provider_fee_mxn: number;
  /** Comision de MicoPay en MXN, para este monto. */
  platform_fee_mxn: number;
  /** Coste total sobre el monto, en %. */
  effective_fee_percent: number;
  /** Completed trades as seller — reputation signal */
  trades_completed: number;
  /** Completion rate (%) over terminal trades, null if no history */
  completion_rate: number | null;
  /** Reputation tier derived from completed-trade volume */
  tier: string;
}

export interface AvailableMerchantsQuery {
  lat: number;
  lng: number;
  radius_km: number;
  amount_mxn: number;
  /** 'cashout' | 'deposit'. Decide hacia donde van las comisiones; sin el, deposito. */
  flow?: string;
}

/**
 * Haversine distance in km between two lat/lng points.
 * Computed in SQL to avoid pulling all rows into Node.
 */
const HAVERSINE_SQL = `
  (6371 * acos(
    LEAST(1.0, cos(radians($1)) * cos(radians(mc.latitude))
    * cos(radians(mc.longitude) - radians($2))
    + sin(radians($1)) * sin(radians(mc.latitude)))
  ))
`.trim();

export interface UpdateMerchantConfigInput {
  ratePercent: number;
  minTradeMxn: number;
  maxTradeMxn: number;
  dailyCapMxn: number;
}

const DEFAULT_CONFIG = {
  rate_percent: 1.0,
  min_trade_mxn: 100,
  max_trade_mxn: 50000,
  daily_cap_mxn: 250000,
};

function validateConfig(input: UpdateMerchantConfigInput) {
  const { ratePercent, minTradeMxn, maxTradeMxn, dailyCapMxn } = input;

  if (ratePercent < 0 || ratePercent > 100) {
    throw new BadRequestError('rate_percent must be between 0 and 100');
  }

  if (minTradeMxn < GLOBAL_MIN_AMOUNT_MXN || minTradeMxn > GLOBAL_MAX_AMOUNT_MXN) {
    throw new BadRequestError(`min_trade_mxn must be between ${GLOBAL_MIN_AMOUNT_MXN} and ${GLOBAL_MAX_AMOUNT_MXN}`);
  }

  if (maxTradeMxn < GLOBAL_MIN_AMOUNT_MXN || maxTradeMxn > GLOBAL_MAX_AMOUNT_MXN) {
    throw new BadRequestError(`max_trade_mxn must be between ${GLOBAL_MIN_AMOUNT_MXN} and ${GLOBAL_MAX_AMOUNT_MXN}`);
  }

  if (minTradeMxn > maxTradeMxn) {
    throw new BadRequestError('min_trade_mxn cannot exceed max_trade_mxn');
  }

  if (dailyCapMxn < maxTradeMxn) {
    throw new BadRequestError('daily_cap_mxn must be greater than or equal to max_trade_mxn');
  }
}

export async function getOrCreateMerchantConfig(userId: string): Promise<MerchantConfig> {
  const user = await db.getOne('SELECT id FROM users WHERE id = $1', [userId]);
  if (!user) throw new NotFoundError('Merchant not found');

  const existing = await db.getOne<MerchantConfig>(
    `SELECT user_id, rate_percent, min_trade_mxn, max_trade_mxn, daily_cap_mxn,
            latitude, longitude, area_label, meeting_point, publish_storefront, updated_at
     FROM merchant_configs WHERE user_id = $1`,
    [userId],
  );
  if (existing) return existing;

  const created = await db.getOne<MerchantConfig>(
    `INSERT INTO merchant_configs (user_id, rate_percent, min_trade_mxn, max_trade_mxn, daily_cap_mxn, updated_at)
     VALUES ($1, $2, $3, $4, $5, NOW())
     RETURNING user_id, rate_percent, min_trade_mxn, max_trade_mxn, daily_cap_mxn,
               latitude, longitude, area_label, meeting_point, publish_storefront, updated_at`,
    [
      userId,
      DEFAULT_CONFIG.rate_percent,
      DEFAULT_CONFIG.min_trade_mxn,
      DEFAULT_CONFIG.max_trade_mxn,
      DEFAULT_CONFIG.daily_cap_mxn,
    ],
  );

  return created!;
}

export async function updateMerchantConfig(userId: string, input: UpdateMerchantConfigInput): Promise<MerchantConfig> {
  validateConfig(input);

  await getOrCreateMerchantConfig(userId);

  const updated = await db.getOne<MerchantConfig>(
    `UPDATE merchant_configs
     SET rate_percent = $2,
         min_trade_mxn = $3,
         max_trade_mxn = $4,
         daily_cap_mxn = $5,
         -- RED-1: guardar la configuracion ES el acto de aceptar tus terminos.
         -- La lista de alta lo exige, porque tener numeros por defecto no
         -- significa que la persona los haya visto.
         terms_confirmed_at = NOW(),
         updated_at = NOW()
     WHERE user_id = $1
     RETURNING user_id, rate_percent, min_trade_mxn, max_trade_mxn, daily_cap_mxn,
               latitude, longitude, area_label, meeting_point, publish_storefront,
               terms_confirmed_at, updated_at`,
    [userId, input.ratePercent, input.minTradeMxn, input.maxTradeMxn, input.dailyCapMxn],
  );

  return updated!;
}

/**
 * GET /merchants/available
 *
 * Returns merchants who:
 *  - are enrolled and active in Red MicoPay (provider_status = 'active')
 *  - are not suspended, banned or deleted
 *  - have merchant_available = true
 *  - have a location set (latitude/longitude NOT NULL)
 *  - are within radius_km of the caller's position
 *  - accept the requested amount_mxn (min_trade_mxn ≤ amount ≤ max_trade_mxn)
 *
 * Sorted by haversine distance ascending (nearest first).
 */
export async function getAvailableMerchants(
  query: AvailableMerchantsQuery,
): Promise<AvailableMerchant[]> {
  const { lat, lng, radius_km, amount_mxn, flow } = query;

  const rows = await db.getMany<{
    seller_id: string;
    username: string;
    rate_percent: string;
    min_trade_mxn: number;
    max_trade_mxn: number;
    daily_cap_mxn: number;
    latitude: string;
    longitude: string;
    area_label: string | null;
    storefront_address: string | null;
    distance_km: string;
    trades_completed: string;
    trades_terminal: string;
  }>(
    `SELECT
       u.id            AS seller_id,
       u.username,
       mc.rate_percent,
       mc.min_trade_mxn,
       mc.max_trade_mxn,
       mc.daily_cap_mxn,
       mc.latitude,
       mc.longitude,
       mc.area_label,
       -- RED-3: el punto exacto solo sale si hay consentimiento explicito.
       -- Se resuelve en SQL para que no pueda escaparse por olvido en el map().
       CASE WHEN mc.publish_storefront THEN mc.meeting_point ELSE NULL END AS storefront_address,
       ${HAVERSINE_SQL} AS distance_km,
       COALESCE((SELECT COUNT(*) FROM trades t WHERE t.seller_id = u.id AND t.status = 'completed'), 0) AS trades_completed,
       COALESCE((SELECT COUNT(*) FROM trades t WHERE t.seller_id = u.id AND t.status IN ('completed','cancelled','refunded')), 0) AS trades_terminal
     FROM merchant_configs mc
     JOIN users u ON u.id = mc.user_id
     -- RED-1: el mapa lista agentes, no cuentas. Pertenecer a la Red
     -- (provider_status) es un hecho aparte de estar disponible ahora mismo
     -- (merchant_available). Antes bastaba lo segundo, y como nacia en true,
     -- cualquier persona registrada con ubicacion aparecia como proveedora.
     -- Suspendidos y baneados salen aqui, no al crear la operacion: ofrecer a
     -- alguien que va a rechazar es una promesa que la pantalla no puede cumplir.
     WHERE u.provider_status = 'active'
       AND u.merchant_available = true
       AND u.is_suspended = false
       AND COALESCE(u.is_banned, false) = false
       AND u.deleted_at IS NULL
       AND mc.latitude  IS NOT NULL
       AND mc.longitude IS NOT NULL
       AND mc.min_trade_mxn <= $3
       AND mc.max_trade_mxn >= $3
       AND ${HAVERSINE_SQL} <= $4
     ORDER BY distance_km ASC
     LIMIT 50`,
    [lat, lng, amount_mxn, radius_km],
  );

  return rows.map((r) => {
    const ratePercent = parseFloat(r.rate_percent as unknown as string);
    const distanceKm = parseFloat(r.distance_km as unknown as string);
    // Antes esto anunciaba `monto * (1 - tarifa)`: ignoraba la comision de
    // plataforma, asi que el mapa prometia un neto que la operacion no cumplia.
    // Ahora sale del mismo modulo que usa `createTrade`, para que la cifra que
    // se ve al elegir agente sea exactamente la que se cobra al aceptar.
    // El mismo modulo y el mismo flujo que `createTrade` (H5): la cifra del mapa
    // es la que se liquida.
    const fees = computeTradeFees(amount_mxn, ratePercent, normalizeFeeFlow(flow));
    const payoutMxn = fees.payoutMxn;
    const completed = parseInt(r.trades_completed as unknown as string, 10) || 0;
    const terminal = parseInt(r.trades_terminal as unknown as string, 10) || 0;
    const completionRate = terminal > 0 ? Math.round((completed / terminal) * 100) : null;
    const tier = completed >= 50 ? 'Oro' : completed >= 10 ? 'Plata' : completed >= 1 ? 'Bronce' : 'Nuevo';

    return {
      seller_id: r.seller_id,
      username: r.username,
      rate_percent: ratePercent,
      min_trade_mxn: r.min_trade_mxn,
      max_trade_mxn: r.max_trade_mxn,
      daily_cap_mxn: r.daily_cap_mxn,
      // G1 privacy: coarsen public discovery coordinates to ~110m (3 decimals).
      // Exact coordinates are only revealed to a counterparty inside an
      // accepted trade, never at discovery time. distance_km above is
      // already computed in SQL from the exact, unrounded columns, so it
      // stays accurate — only these two output fields are rounded.
      latitude: Math.round(parseFloat(r.latitude as unknown as string) * 1000) / 1000,
      longitude: Math.round(parseFloat(r.longitude as unknown as string) * 1000) / 1000,
      area_label: r.area_label,
      storefront_address: r.storefront_address,
      distance_km: Math.round(distanceKm * 1000) / 1000,
      payout_mxn: payoutMxn,
      // El desglose viaja completo para que la app no tenga que deducirlo
      // restando, que es como se colo el error anterior.
      provider_fee_mxn: fees.providerFeeMxn,
      platform_fee_mxn: fees.platformFeeMxn,
      effective_fee_percent: fees.effectivePercent,
      // H5: retiro = paga de su saldo / recibe en efectivo; deposito = al reves.
      client_pays_mxn: fees.clientPaysMxn,
      client_receives_mxn: fees.clientReceivesMxn,
      trades_completed: completed,
      completion_rate: completionRate,
      tier,
    };
  });
}
