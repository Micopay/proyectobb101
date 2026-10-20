/**
 * RED-1 · Alta explicita en Red MicoPay.
 *
 * Cuatro hechos que el codigo trataba como uno solo:
 *
 *   tener cuenta  ≠  pertenecer a la Red  ≠  estar verificado  ≠  estar disponible
 *
 * Aqui vive el segundo. El alta es una decision de la persona, se puede repetir
 * sin efecto (idempotente) y NO crea un modo permanente: un agente activo sigue
 * pudiendo pedir un cash-out como cliente sin cambiar de modo.
 *
 * La activacion falla cerrada: si falta perfil, ubicacion, limites o el KYC
 * general, no se activa. Ningun flujo efectivo↔cripto puede correr en nivel 0
 * (Art. 17 fr. XVI LFPIORPI, ver config.ts), y un agente maneja justamente eso,
 * asi que el minimo es nivel 1.
 */

import db from "../db/schema.js";
import { AppError, NotFoundError } from "../utils/errors.js";

export type ProviderStatus =
  | "not_enrolled"
  | "pending_verification"
  | "active"
  | "suspended";

/**
 * Nivel de KYC general exigido para operar como agente. Configurable sin tocar
 * codigo; el suelo de 1 no es una preferencia de producto sino la regla
 * verificada: identificacion desde el primer peso en activos virtuales.
 */
export const REQUIRED_PROVIDER_KYC_LEVEL = Math.max(
  1,
  parseInt(process.env.PROVIDER_REQUIRED_KYC_LEVEL || "1", 10) || 1,
);

export interface ReadinessItem {
  /** Identificador estable para que la app no dependa del texto. */
  key: "kyc" | "location" | "limits";
  done: boolean;
  /** Por que falta, cuando falta. */
  detail: string | null;
}

export interface ProviderReadiness {
  status: ProviderStatus;
  /** true solo si TODO esta completo; la app no debe deducirlo sumando items. */
  can_activate: boolean;
  items: ReadinessItem[];
  availability: string | null;
  merchant_available: boolean;
  required_kyc_level: number;
  kyc_level: number;
  kyc_provider: string | null;
}

interface UserRow {
  id: string;
  provider_status: ProviderStatus | null;
  availability: string | null;
  merchant_available: boolean | null;
  is_suspended: boolean | null;
  kyc_level: number | null;
  kyc_provider: string | null;
}

interface ConfigRow {
  rate_percent: string | number | null;
  min_trade_mxn: number | null;
  max_trade_mxn: number | null;
  daily_cap_mxn: number | null;
  latitude: string | number | null;
  longitude: string | number | null;
  area_label: string | null;
  terms_confirmed_at: string | Date | null;
}

async function loadUser(userId: string): Promise<UserRow> {
  const user = await db.getOne<UserRow>(
    `SELECT id, provider_status, availability, merchant_available, is_suspended,
            kyc_level, kyc_provider
       FROM users
      WHERE id = $1 AND deleted_at IS NULL`,
    [userId],
  );
  if (!user) throw new NotFoundError("USER_NOT_FOUND", "Usuario no encontrado", `User ${userId}`);
  return user;
}

/** El estado nulo de una fila vieja se lee como "no inscrito", nunca como activo. */
function statusOf(user: UserRow): ProviderStatus {
  return (user.provider_status as ProviderStatus) ?? "not_enrolled";
}

/**
 * Solo el KYC general de MicoPay (Didit) habilita la Red. La aprobacion de
 * Etherfuse es para CETES/SPEI y no dice nada sobre manejar efectivo ajeno:
 * aceptarla aqui seria dar por verificada a una persona por un tramite distinto.
 */
function kycSatisfied(user: UserRow): boolean {
  const level = user.kyc_level ?? 0;
  return user.kyc_provider === "didit" && level >= REQUIRED_PROVIDER_KYC_LEVEL;
}

function buildItems(user: UserRow, config: ConfigRow | null): ReadinessItem[] {
  const level = user.kyc_level ?? 0;

  const kycDetail = (() => {
    if (kycSatisfied(user)) return null;
    if (user.kyc_provider && user.kyc_provider !== "didit") {
      return `La verificacion de ${user.kyc_provider} no habilita Red MicoPay; falta la de MicoPay.`;
    }
    return `Se necesita verificacion de identidad nivel ${REQUIRED_PROVIDER_KYC_LEVEL} (actual: ${level}).`;
  })();

  const hasLocation =
    config?.latitude !== null &&
    config?.latitude !== undefined &&
    config?.longitude !== null &&
    config?.longitude !== undefined;

  // No basta con que HAYA numeros: los limites son NOT NULL con valores por
  // defecto y la base impide combinaciones incoherentes, asi que "tiene
  // limites" seria cierto siempre y la casilla no verificaria nada. Lo que se
  // exige es que la persona haya visto y guardado SUS terminos.
  const hasLimits = !!config?.terms_confirmed_at;

  return [
    { key: "kyc", done: kycSatisfied(user), detail: kycDetail },
    {
      key: "location",
      done: hasLocation,
      detail: hasLocation ? null : "Falta la zona donde puedes entregar o recibir efectivo.",
    },
    {
      key: "limits",
      done: hasLimits,
      detail: hasLimits
        ? null
        : "Revisa y confirma tu comision, tus montos minimo y maximo y tu tope diario.",
    },
  ];
}

export async function getProviderReadiness(userId: string): Promise<ProviderReadiness> {
  const user = await loadUser(userId);
  const config = await db.getOne<ConfigRow>(
    `SELECT rate_percent, min_trade_mxn, max_trade_mxn, daily_cap_mxn,
            latitude, longitude, area_label, terms_confirmed_at
       FROM merchant_configs WHERE user_id = $1`,
    [userId],
  );

  const status = statusOf(user);
  const items = buildItems(user, config);
  const complete = items.every((i) => i.done);

  return {
    status,
    // Una cuenta suspendida no se "reactiva" completando la lista: eso lo
    // resuelve soporte, no el propio usuario.
    can_activate: complete && status === "pending_verification" && !user.is_suspended,
    items,
    availability: user.availability,
    merchant_available: user.merchant_available === true,
    required_kyc_level: REQUIRED_PROVIDER_KYC_LEVEL,
    kyc_level: user.kyc_level ?? 0,
    kyc_provider: user.kyc_provider,
  };
}

/**
 * Inicia el alta. Idempotente: repetirlo no crea una segunda cuenta ni una
 * segunda wallet, y no degrada a quien ya esta activo.
 */
export async function enrollProvider(userId: string): Promise<ProviderReadiness> {
  const user = await loadUser(userId);
  const status = statusOf(user);

  if (user.is_suspended || status === "suspended") {
    throw new AppError(
      "PROVIDER_SUSPENDED",
      "Tu cuenta no puede unirse a Red MicoPay en este momento.",
      `User ${userId} is suspended`,
      403,
    );
  }

  if (status === "not_enrolled") {
    await db.execute(
      `UPDATE users
          SET provider_status = 'pending_verification',
              provider_enrolled_at = COALESCE(provider_enrolled_at, NOW())
        WHERE id = $1 AND provider_status = 'not_enrolled'`,
      [userId],
    );

    // La configuracion existe para que la persona pueda rellenar la lista. No
    // la publica: la publicacion la decide `provider_status` + disponibilidad.
    await db.execute(
      `INSERT INTO merchant_configs (user_id, updated_at)
       VALUES ($1, NOW())
       ON CONFLICT (user_id) DO NOTHING`,
      [userId],
    );
  }

  return getProviderReadiness(userId);
}

/**
 * Activa al agente. Falla cerrada: recalcula la elegibilidad contra la base en
 * este mismo momento, sin confiar en lo que la app crea saber.
 */
export async function activateProvider(userId: string): Promise<ProviderReadiness> {
  const readiness = await getProviderReadiness(userId);

  if (readiness.status === "active") return readiness;

  if (readiness.status === "not_enrolled") {
    throw new AppError(
      "PROVIDER_NOT_ENROLLED",
      "Primero unete a Red MicoPay.",
      `User ${userId} is not enrolled`,
      409,
    );
  }

  if (!readiness.can_activate) {
    const missing = readiness.items.filter((i) => !i.done).map((i) => i.key);
    throw new AppError(
      "PROVIDER_NOT_READY",
      "Te faltan pasos para activarte como agente.",
      `User ${userId} missing: ${missing.join(", ") || "none"}`,
      409,
    );
  }

  // Se activa, pero NO se pone disponible: empezar a recibir operaciones es una
  // segunda decision consciente.
  await db.execute(
    `UPDATE users
        SET provider_status = 'active',
            provider_activated_at = COALESCE(provider_activated_at, NOW()),
            availability = 'paused',
            merchant_available = false
      WHERE id = $1 AND provider_status = 'pending_verification'`,
    [userId],
  );

  return getProviderReadiness(userId);
}

/**
 * Escritura canonica de disponibilidad. `availability` y `merchant_available`
 * son el mismo hecho contado dos veces, y se separaron en algun punto: la
 * columna quedaba obsoleta mientras el booleano cambiaba, asi que el mapa podia
 * mostrar a alguien en pausa. Aqui se escriben siempre juntos.
 */
export async function setProviderAvailability(
  userId: string,
  availability: "online" | "offline" | "paused",
): Promise<{ availability: string; merchant_available: boolean }> {
  const user = await loadUser(userId);

  if (statusOf(user) !== "active") {
    throw new AppError(
      "PROVIDER_NOT_ACTIVE",
      "Solo los agentes activos de Red MicoPay pueden cambiar su disponibilidad.",
      `User ${userId} provider_status=${statusOf(user)}`,
      403,
    );
  }

  // Una cuenta suspendida no vuelve sola al mapa por tocar un interruptor.
  const merchantAvailable = availability === "online" && !user.is_suspended;

  await db.execute(
    `UPDATE users SET availability = $2, merchant_available = $3 WHERE id = $1`,
    [userId, availability, merchantAvailable],
  );

  return { availability, merchant_available: merchantAvailable };
}
