import db from "../db/schema.js";

export interface AuditEventInput {
  action: string;
  actorUserId: string | null;
  entityType: string;
  entityId: string;
  details?: Record<string, unknown>;
}

/** Platform-wide risk and admin audit trail (#82). */
export async function logAuditEvent(input: AuditEventInput) {
  const { action, actorUserId, entityType, entityId, details = {} } = input;

  await db.execute(
    `INSERT INTO platform_risk_events (action, actor_user_id, entity_type, entity_id, details)
     VALUES ($1, $2, $3, $4, $5)`,
    [action, actorUserId, entityType, entityId, details],
  );
}
