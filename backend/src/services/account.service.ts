import db, { pool } from "../db/schema.js";
import { logAuditEvent } from "./audit.service.js";
import { ConflictError, NotFoundError } from "../utils/errors.js";

interface ActiveUserRow {
  id: string;
  username: string;
  stellar_address: string;
  phone_hash: string | null;
  deleted_at: string | null;
}

const ACTIVE_TRADE_STATUSES = ["pending", "locked", "revealing"] as const;

export async function deleteAccount(userId: string, confirmUsername: string) {
  const user = await db.getOne<ActiveUserRow>(
    "SELECT id, username, stellar_address, phone_hash, deleted_at FROM users WHERE id = $1 AND deleted_at IS NULL",
    [userId],
  );

  if (!user) {
    throw new NotFoundError("User not found");
  }

  if (user.username !== confirmUsername) {
    throw new ConflictError(
      "Confirmation username does not match the current account",
    );
  }

  const activeTrades = await db.getMany<{ id: string }>(
    `SELECT id FROM trades
     WHERE (seller_id = $1 OR buyer_id = $1)
       AND status IN ('pending', 'locked', 'revealing')`,
    [userId],
  );

  if (activeTrades.length > 0) {
    throw new ConflictError(
      "Finish or cancel all active trades before deleting your account",
    );
  }

  // Define anonymized representations for PII minimization
  const idPrefix = userId.substring(0, 8);
  const anonymizedUsername = `deleted_${idPrefix}`;
  const anonymizedStellarAddress = user.stellar_address
    ? `${user.stellar_address.substring(0, 4)}...${user.stellar_address.substring(52)}`
    : null;
  const anonymizedPhoneHash = user.phone_hash ? `anonymized_${idPrefix}` : null;

  // Todo el borrado va en una sola transacción. Antes no: cada paso corría
  // suelto, y como los pasos 4, 5 y 7 apuntaban a tablas que no existen en
  // este esquema, la petición reventaba con un 500 DESPUÉS de haber
  // anonimizado la fila de users y borrado la wallet. El usuario veía "no se
  // pudo eliminar la cuenta" con la cuenta ya medio destruida.
  const client = pool ? await pool.connect() : null;
  const exec = client
    ? (text: string, params: unknown[]) => client.query(text, params)
    : (text: string, params: unknown[]) => db.execute(text, params as any[]);

  try {
    if (client) await exec("BEGIN", []);

    // 1. Anonymize primary user table and clear active flags
    await exec(
      `UPDATE users
       SET deleted_at = NOW(),
           deleted_username = $2,
           deleted_stellar_address = $3,
           deleted_phone_hash = $4,
           username = NULL,
           stellar_address = NULL,
           phone_hash = NULL,
           merchant_available = false
       WHERE id = $1`,
      [userId, anonymizedUsername, anonymizedStellarAddress, anonymizedPhoneHash],
    );

    // 2. wallets — Delete the user's wallet record for complete PII deletion
    await exec("DELETE FROM wallets WHERE user_id = $1", [userId]);

    // 3. user_devices — Delete the user's push tokens
    await exec("DELETE FROM user_devices WHERE user_id = $1", [userId]);

    // 4. trade_messages — Delete messages sent by this user to clear sender PII.
    //    (Apuntaba a `chat_messages`, que no existe: la tabla de mensajes de
    //    este esquema es `trade_messages`.)
    await exec("DELETE FROM trade_messages WHERE sender_id = $1", [userId]);

    // 5. trade_disputes — Anonymize disputes opened by this user. (Apuntaba a
    //    `dispute_events.reported_by` y a una columna `evidence_urls`; ninguna
    //    de las dos existe. La tabla real es `trade_disputes` y la columna que
    //    identifica a quien abrió la disputa es `opener_id`.)
    await exec(
      `UPDATE trade_disputes
       SET reason = 'Anonymized due to account deletion'
       WHERE opener_id = $1`,
      [userId],
    );

    // 6. secret_access_log — Anonymize IP address and User Agent
    await exec(
      `UPDATE secret_access_log
       SET ip_address = '0.0.0.0',
           user_agent = 'Anonymized'
       WHERE user_id = $1`,
      [userId],
    );

    // (El paso que anonimizaba `account_funding_log` se eliminó: esa tabla no
    // existe en el esquema ni hay migración que la cree.)

    if (client) await exec("COMMIT", []);
  } catch (err) {
    if (client) await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client?.release();
  }

  await logAuditEvent({
    action: "account.deleted",
    actorUserId: userId,
    entityType: "user",
    entityId: userId,
    details: {
      activeTradeCount: activeTrades.length,
      deletedUsername: user.username,
    },
  });

  return { status: "deleted" as const };
}
