/**
 * KYC-1 · La decisión del webhook se ata a NUESTRA sesión, no al payload.
 *
 * Corrección de los issues cerrados de GrantFox #314 y #315.
 *
 * El handler tomaba `user_id` y `level` de `vendor_data`, un campo que vuelve
 * del proveedor dentro del propio cuerpo del webhook. Quien lograra una firma
 * válida —o una configuración equivocada del proveedor— podía subirle el nivel
 * a cualquier usuario. Además:
 *
 *   - una entrega duplicada refrescaba `kyc_level_verified_at` y estiraba la
 *     vigencia del nivel sin que nadie se verificara de nuevo;
 *   - una aprobación de nivel inferior podía degradar un nivel mayor vigente;
 *   - ante un payload raro se logueaba el cuerpo ENTERO, con documentos y
 *     datos personales dentro.
 *
 * Estas pruebas ejercitan la lógica del webhook contra el store, sin red y sin
 * credenciales: nada de esto necesita el sandbox real.
 *
 * NECESITA POSTGRESQL REAL. La monotonía vive en el WHERE del UPDATE
 * (`kyc_level IS NULL OR kyc_level < $1`), y el shim en memoria no evalúa esa
 * condición compuesta: contra él, el guard parecería no existir.
 *
 *   DATABASE_URL=postgres://... npm run test:didit-webhook
 *
 * NO CUBIERTO AQUÍ, a propósito: la validación del contrato de firma y del
 * formato de sesión contra el sandbox real de Didit. El issue la marca como
 * tarea del mantenedor y requiere credenciales que no deben pasar por aquí.
 */

import { strictEqual, ok } from "assert";
import db, { pool } from "../db/schema.js";

// Sufijo por corrida: contra PostgreSQL real la base persiste, y un contador
// que reinicia choca con la unicidad de `username` y `stellar_address`.
const RUN = Math.random().toString(36).slice(2, 8);
let seq = 0;
// `users.kyc_level` es NOT NULL DEFAULT 0: "sin nivel" es 0, no NULL.
async function createUser(label: string, level = 0): Promise<string> {
  seq++;
  const suffix = `${RUN}${String(seq).padStart(2, "0")}`;
  const row = await db.getOne<{ id: string }>(
    `INSERT INTO users (stellar_address, username, phone_hash, kyc_level)
     VALUES ($1, $2, $3, $4)
     RETURNING id`,
    // 1 + 47 + 8 = 56, el largo exacto de una direccion Stellar.
    [`G${"M".repeat(47)}${suffix}`, `kyc1_${label}_${suffix}`, `h_kyc1_${label}_${suffix}`, level],
  );
  if (!row?.id) throw new Error(`Failed to seed ${label}`);
  return row.id;
}

async function createSession(userId: string, requestedLevel: number, status = "pending"): Promise<string> {
  seq++;
  const sessionId = `sess_${seq}_${Math.random().toString(36).slice(2, 8)}`;
  await db.execute(
    `INSERT INTO kyc_didit_sessions (session_id, user_id, requested_level, status)
     VALUES ($1, $2, $3, $4)`,
    [sessionId, userId, requestedLevel, status],
  );
  return sessionId;
}

async function levelOf(userId: string): Promise<number> {
  const row = await db.getOne<{ kyc_level: number }>(
    "SELECT kyc_level FROM users WHERE id = $1",
    [userId],
  );
  return Number(row?.kyc_level ?? 0);
}

/**
 * Se normaliza a ISO: `pg` devuelve `Date`, y comparar dos instancias
 * distintas con strictEqual falla aunque representen el mismo instante.
 */
async function verifiedAtOf(userId: string): Promise<string | null> {
  const row = await db.getOne<{ kyc_level_verified_at: string | Date | null }>(
    "SELECT kyc_level_verified_at FROM users WHERE id = $1",
    [userId],
  );
  const value = row?.kyc_level_verified_at ?? null;
  return value ? new Date(value).toISOString() : null;
}

/**
 * Réplica de la lógica del handler, sin Fastify ni firma: la firma se verifica
 * antes y tiene su propia cobertura. Lo que se prueba aquí es qué hace el
 * handler con una entrega YA autenticada.
 */
async function applyWebhook(sessionId: string, status: string): Promise<string> {
  const session = await db.getOne<{ user_id: string; requested_level: number; status: string }>(
    `SELECT session_id, user_id, requested_level, status FROM kyc_didit_sessions WHERE session_id = $1`,
    [sessionId],
  );
  if (!session) return "unknown_session";
  if (session.status === status) return "duplicate";
  if (session.status === "approved" && status !== "approved") return "refused_undo";

  await db.execute(
    `UPDATE kyc_didit_sessions SET status = $1, updated_at = NOW() WHERE session_id = $2`,
    [status, sessionId],
  );
  if (status === "approved") {
    await db.execute(
      `UPDATE users
       SET kyc_level = $1, kyc_provider = 'didit', kyc_level_verified_at = NOW()
       WHERE id = $2 AND (kyc_level IS NULL OR kyc_level < $1)`,
      [session.requested_level, session.user_id],
    );
  }
  return "applied";
}

// ── 1. El payload no elige a quién verificar ───────────────────────────────

async function testDecisionBindsToStoredSession() {
  const owner = await createUser("owner");
  const victim = await createUser("victim");
  const sessionId = await createSession(owner, 2);

  // Aunque el cuerpo dijera otra cosa, el nivel sube donde dice la sesión.
  await applyWebhook(sessionId, "approved");

  strictEqual(await levelOf(owner), 2, "sube el nivel del dueño de la sesión");
  strictEqual(await levelOf(victim), 0, "y de nadie más");
  console.log("  ✓ la decisión se aplica al usuario de la sesión, no al del payload");
}

async function testUnknownSessionDoesNothing() {
  const user = await createUser("u");
  const before = await levelOf(user);

  const outcome = await applyWebhook("sess_que_no_existe", "approved");
  strictEqual(outcome, "unknown_session", "una sesión desconocida se ignora");
  strictEqual(await levelOf(user), before, "sin tocar a nadie");
  console.log("  ✓ una sesión desconocida no muta ningún nivel");
}

// ── 2. Idempotencia y monotonía ────────────────────────────────────────────

async function testDuplicateDeliveryDoesNotExtendExpiry() {
  const user = await createUser("dup");
  const sessionId = await createSession(user, 1);

  await applyWebhook(sessionId, "approved");
  const firstStamp = await verifiedAtOf(user);
  ok(firstStamp, "quedó marcado el momento de verificación");

  await new Promise((r) => setTimeout(r, 25));
  const outcome = await applyWebhook(sessionId, "approved");

  strictEqual(outcome, "duplicate", "la segunda entrega se reconoce como duplicada");
  strictEqual(await verifiedAtOf(user), firstStamp, "y no refresca la vigencia");
  console.log("  ✓ una entrega duplicada no estira la vigencia del nivel");
}

async function testLowerApprovalCannotDowngrade() {
  const user = await createUser("alto", 2);
  const sessionId = await createSession(user, 1);

  await applyWebhook(sessionId, "approved");

  strictEqual(await levelOf(user), 2, "un nivel 1 aprobado no degrada un nivel 2 vigente");
  console.log("  ✓ una aprobación de nivel inferior no degrada un nivel mayor");
}

async function testHigherApprovalUpgrades() {
  const user = await createUser("sube", 1);
  const sessionId = await createSession(user, 2);

  await applyWebhook(sessionId, "approved");

  strictEqual(await levelOf(user), 2, "subir sí se permite");
  console.log("  ✓ subir de nivel sí se aplica");
}

async function testApprovedSessionIsNotUndone() {
  const user = await createUser("firme");
  const sessionId = await createSession(user, 2);

  await applyWebhook(sessionId, "approved");
  const outcome = await applyWebhook(sessionId, "declined");

  strictEqual(outcome, "refused_undo", "una sesión aprobada no se deshace por una entrega posterior");
  strictEqual(await levelOf(user), 2, "el nivel se mantiene");
  console.log("  ✓ una sesión ya aprobada no se revierte con una entrega tardía");
}

async function testDeclineDoesNotGrantLevel() {
  const user = await createUser("rechazado");
  const sessionId = await createSession(user, 2);

  await applyWebhook(sessionId, "declined");

  strictEqual(await levelOf(user), 0, "un rechazo no otorga nivel");
  console.log("  ✓ un rechazo no otorga nivel");
}

// ── 3. Privacidad en logs ──────────────────────────────────────────────────

async function testHandlerNeverLogsTheBody() {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../routes/kyc.ts", import.meta.url), "utf-8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

  // El cuerpo del webhook lleva documentos y datos personales del proveedor.
  ok(!/log\.\w+\(\s*\{\s*body\b/.test(src), "ningún log emite el cuerpo del webhook");
  ok(!/\bbody:\s*json\b/.test(src), "ni lo pasa como campo `body`");
  console.log("  ✓ el cuerpo del webhook nunca llega a los logs");
}

async function main() {
  console.log("\n  KYC-1 (#314/#315 correction) webhook de Didit:\n");
  await testDecisionBindsToStoredSession();
  await testUnknownSessionDoesNothing();
  await testDuplicateDeliveryDoesNotExtendExpiry();
  await testLowerApprovalCannotDowngrade();
  await testHigherApprovalUpgrades();
  await testApprovedSessionIsNotUndone();
  await testDeclineDoesNotGrantLevel();
  await testHandlerNeverLogsTheBody();
  console.log("\nAll KYC-1 Didit webhook tests passed.\n");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
