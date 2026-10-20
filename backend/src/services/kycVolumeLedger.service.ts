/**
 * CASH-10 · Ledger idempotente de volumen mensual KYC.
 *
 * Reemplaza el acumulado `user_monthly_volume` + mutex en proceso para el
 * camino P2P. Tres problemas que cierra:
 *
 *   1. **Volumen fantasma.** El acumulado se incrementaba antes de que la
 *      operacion existiera; si la creacion fallaba despues, ese volumen se
 *      quedaba cargado y nadie lo devolvia. Aqui la reserva vive en la MISMA
 *      transaccion que la operacion: o entran las dos, o ninguna.
 *
 *   2. **Doble conteo al reintentar.** No habia nada que identificara "esta
 *      operacion, este usuario". La llave primaria (trade_id, user_id) lo
 *      hace idempotente por construccion.
 *
 *   3. **Concurrencia entre procesos.** `keyedMutex` solo protege dentro de
 *      un proceso: con dos instancias del backend, dos peticiones podian
 *      pasar el tope juntas. Aqui se toma un lock de aviso de PostgreSQL,
 *      que es del cluster, no del proceso.
 *
 * El total del mes deja de ser un numero acumulado y pasa a ser la SUMA de
 * las reservas vivas: un dato reconstruible y auditable operacion por
 * operacion.
 */

import type { PoolClient } from 'pg';
import db from '../db/schema.js';

export type ReservationStatus = 'reserved' | 'finalized' | 'released';

/** Estados que consumen tope. `released` no cuenta. */
const COUNTING_STATUSES: ReservationStatus[] = ['reserved', 'finalized'];

export interface VolumeReservation {
  trade_id: string;
  user_id: string;
  month_key: string;
  amount_mxn: number;
  status: ReservationStatus;
}

/** Mes calendario UTC, igual que el acumulado anterior. */
export function currentMonthKey(now: Date = new Date()): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
}

/**
 * Volumen que esta persona ya tiene comprometido este mes.
 * Suma reservas vivas; las liberadas no cuentan.
 */
export async function getMonthlyReservedMxn(
  userId: string,
  monthKey: string = currentMonthKey(),
  client?: PoolClient,
): Promise<number> {
  const sql = `SELECT COALESCE(SUM(amount_mxn), 0)::text AS total
               FROM kyc_volume_reservations
               WHERE user_id = $1 AND month_key = $2 AND status = ANY($3)`;
  const params = [userId, monthKey, COUNTING_STATUSES];

  const row = client
    ? (await client.query(sql, params)).rows[0]
    : await db.getOne<{ total: string }>(sql, params);

  return Number(row?.total ?? 0);
}

/**
 * Toma un lock por usuario dentro de la transaccion en curso.
 *
 * Se ordenan los ids antes de pedirlos: dos operaciones que involucren a las
 * mismas dos personas en orden inverso se bloquearian mutuamente si cada una
 * pidiera "su" lock primero. Ordenar hace imposible ese interbloqueo.
 *
 * El lock se suelta solo al terminar la transaccion, sin necesidad de
 * liberarlo a mano ni de un `finally`.
 */
export async function lockUsersForVolume(client: PoolClient, userIds: string[]): Promise<void> {
  for (const id of [...new Set(userIds)].sort()) {
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [id]);
  }
}

/**
 * Aparta volumen para un participante dentro de una transaccion abierta.
 *
 * Idempotente: si ya existe una reserva para esta operacion y esta persona,
 * no se crea otra ni se suma de nuevo. Devuelve la reserva vigente.
 */
export async function reserveVolume(
  client: PoolClient,
  input: { tradeId: string; userId: string; amountMxn: number; monthKey?: string },
): Promise<VolumeReservation> {
  const monthKey = input.monthKey ?? currentMonthKey();

  const { rows } = await client.query(
    `INSERT INTO kyc_volume_reservations (trade_id, user_id, month_key, amount_mxn, status)
     VALUES ($1, $2, $3, $4, 'reserved')
     ON CONFLICT (trade_id, user_id) DO UPDATE
       -- No-op deliberado: DO NOTHING no devolveria la fila existente, y la
       -- necesitamos para responder con la reserva vigente.
       SET updated_at = kyc_volume_reservations.updated_at
     RETURNING trade_id, user_id, month_key, amount_mxn::text AS amount_mxn, status`,
    [input.tradeId, input.userId, monthKey, input.amountMxn],
  );

  const r = rows[0];
  return { ...r, amount_mxn: Number(r.amount_mxn) };
}

/**
 * Cierra el ciclo de vida de una operacion.
 *
 * `finalized` para completadas y `released` para las que murieron sin
 * completarse. Se aplica a los dos participantes de una vez y es idempotente:
 * volver a llamarlo con el mismo estado no cambia nada.
 *
 * Se deja como adaptador para que CASH-2 (cancelacion), CASH-4 (completado),
 * CASH-6 (reembolso) y SAFE-1 (disputas) lo invoquen sin que CASH-10 tenga
 * que tocar sus cuerpos.
 */
export async function settleTradeVolume(
  tradeId: string,
  status: Extract<ReservationStatus, 'finalized' | 'released'>,
): Promise<number> {
  const result = await db.execute(
    `UPDATE kyc_volume_reservations
     SET status = $2, updated_at = NOW()
     WHERE trade_id = $1 AND status = 'reserved'`,
    [tradeId, status],
  );
  return (result as { rowCount?: number })?.rowCount ?? 0;
}

/** Reservas de una operacion; util para auditar y para las pruebas. */
export async function getTradeReservations(tradeId: string): Promise<VolumeReservation[]> {
  const rows = await db.getMany<VolumeReservation & { amount_mxn: string }>(
    `SELECT trade_id, user_id, month_key, amount_mxn::text AS amount_mxn, status
     FROM kyc_volume_reservations WHERE trade_id = $1 ORDER BY user_id`,
    [tradeId],
  );
  return rows.map((r) => ({ ...r, amount_mxn: Number(r.amount_mxn) }));
}
