/**
 * RED-1 · Pertenecer a Red MicoPay es una decision, no un efecto secundario.
 *
 * Antes de esto, `merchant_available` nacia en true — por defecto del esquema y
 * ademas explicito en el registro — asi que CUALQUIER persona que abria una
 * cuenta quedaba publicada como proveedora de efectivo en un endpoint publico y
 * enumerable, sin haberlo decidido nunca. Cuatro hechos distintos vivian en un
 * booleano: tener cuenta, pertenecer a la Red, estar verificado y estar
 * disponible ahora mismo.
 *
 * Esta suite fija los cuatro por separado, y sobre todo fija que la activacion
 * FALLA CERRADA: sin KYC general, sin ubicacion o sin limites, no hay agente.
 *
 * NECESITA POSTGRESQL REAL. El shim en memoria no evalua el WHERE compuesto del
 * descubrimiento ni la restriccion CHECK de `provider_status`: pasaria en verde
 * sin probar nada, que es peor que no tener test.
 *
 *   docker run -d --name mp-pg -e POSTGRES_PASSWORD=x -e POSTGRES_DB=micopay \
 *     -p 55432:5432 postgres:16-alpine
 *   DATABASE_URL=postgres://postgres:x@localhost:55432/micopay npm run migrate
 *   DATABASE_URL=postgres://postgres:x@localhost:55432/micopay \
 *     npx tsx src/tests/providerEnrollment.test.ts
 */

import { strictEqual, ok } from "assert";
import db, { pool } from "../db/schema.js";
import {
  enrollProvider,
  activateProvider,
  getProviderReadiness,
  setProviderAvailability,
  REQUIRED_PROVIDER_KYC_LEVEL,
} from "../services/providerEnrollment.service.js";
import { getAvailableMerchants, updateMerchantConfig } from "../services/merchant.service.js";
import { pauseUser, unpauseUser } from "../services/abuse.service.js";
import { AppError } from "../utils/errors.js";

const RUN = Math.random().toString(36).slice(2, 8);
let seq = 0;

// Cada corrida se aisla en su propia zona: contra PostgreSQL real la base
// persiste, y con un centro fijo todos los proveedores de todas las corridas
// caen en el mismo punto y el LIMIT del descubrimiento acaba dejando fuera a
// los recien creados. La suite empezaria a fallar por acumulacion, no por el
// codigo. (Aprendido en RED-3, donde paso exactamente eso.)
const CENTER = { lat: 18.0 + Math.random() * 0.8, lng: -100.6 + Math.random() * 0.8 };

/** Crea una cuenta tal y como la crea el registro real. */
async function createUser(label: string): Promise<string> {
  seq++;
  const suffix = `${RUN}${String(seq).padStart(2, "0")}`;
  const row = await db.getOne<{ id: string }>(
    `INSERT INTO users (stellar_address, username, phone_hash)
     VALUES ($1, $2, $3)
     RETURNING id`,
    [`G${"R".repeat(47)}${suffix}`, `red1_${label}_${suffix}`, `h_red1_${label}_${suffix}`],
  );
  if (!row?.id) throw new Error(`Failed to seed ${label}`);
  return row.id;
}

async function setKyc(userId: string, level: number, provider: string | null) {
  await db.execute(`UPDATE users SET kyc_level = $2, kyc_provider = $3 WHERE id = $1`, [
    userId,
    level,
    provider,
  ]);
}

async function setLocationAndLimits(userId: string) {
  await db.execute(
    `UPDATE merchant_configs
        SET latitude = $2, longitude = $3, area_label = 'Zona de prueba',
            rate_percent = 1.5, min_trade_mxn = 100, max_trade_mxn = 50000,
            daily_cap_mxn = 250000, terms_confirmed_at = NOW(), updated_at = NOW()
      WHERE user_id = $1`,
    [userId, CENTER.lat, CENTER.lng],
  );
}

/** Camino completo hasta agente activo y disponible. */
async function makeActiveProvider(label: string): Promise<string> {
  const id = await createUser(label);
  await enrollProvider(id);
  await setKyc(id, REQUIRED_PROVIDER_KYC_LEVEL, "didit");
  await setLocationAndLimits(id);
  await activateProvider(id);
  await setProviderAvailability(id, "online");
  return id;
}

const discover = () =>
  getAvailableMerchants({ lat: CENTER.lat, lng: CENTER.lng, radius_km: 5, amount_mxn: 500 });

const isListed = async (id: string) => (await discover()).some((m) => m.seller_id === id);

async function expectAppError(fn: () => Promise<unknown>, code: string, what: string) {
  try {
    await fn();
  } catch (err) {
    if (err instanceof AppError && err.code === code) return;
    throw new Error(`${what}: se esperaba ${code} y llego ${(err as Error).message}`);
  }
  throw new Error(`${what}: se esperaba ${code} y no hubo error`);
}

// ── 1. Abrir cuenta no te mete en la Red ───────────────────────────────────

async function testRegistrationDoesNotEnroll() {
  const id = await createUser("nuevo");

  const r = await getProviderReadiness(id);
  strictEqual(r.status, "not_enrolled", "una cuenta nueva no pertenece a la Red");
  strictEqual(r.merchant_available, false, "y no esta publicada");
  strictEqual(r.can_activate, false);

  // Aunque tuviera ubicacion y limites, sin alta no aparece. Esto es el defecto
  // original: el mapa deducia "es proveedor" de tener config + disponibilidad.
  await db.execute(
    `INSERT INTO merchant_configs (user_id, latitude, longitude, min_trade_mxn, max_trade_mxn, daily_cap_mxn, updated_at)
     VALUES ($1, $2, $3, 100, 50000, 250000, NOW())`,
    [id, CENTER.lat, CENTER.lng],
  );
  await db.execute(`UPDATE users SET merchant_available = true WHERE id = $1`, [id]);

  strictEqual(await isListed(id), false, "con config y disponible, pero sin alta, sigue fuera");
  console.log("  ✓ registrarse no te publica como agente, ni con ubicacion y limites puestos");
}

// ── 2. El alta es explicita e idempotente ──────────────────────────────────

async function testEnrollmentIsExplicitAndIdempotent() {
  const id = await createUser("alta");

  const first = await enrollProvider(id);
  strictEqual(first.status, "pending_verification", "unirse deja la cuenta pendiente, no activa");
  strictEqual(first.merchant_available, false, "unirse no publica");

  const second = await enrollProvider(id);
  strictEqual(second.status, "pending_verification", "repetirlo no cambia nada");

  const wallets = await db.getMany(`SELECT id FROM wallets WHERE user_id = $1`, [id]);
  ok(wallets.length <= 1, "y no crea una segunda wallet");

  const configs = await db.getMany(`SELECT user_id FROM merchant_configs WHERE user_id = $1`, [id]);
  strictEqual(configs.length, 1, "ni una segunda configuracion");
  console.log("  ✓ el alta es explicita, idempotente y no crea cuentas ni wallets duplicadas");
}

// ── 3. La activacion falla cerrada ─────────────────────────────────────────

async function testActivationFailsClosedWithoutKyc() {
  const id = await createUser("sinkyc");
  await enrollProvider(id);
  await setLocationAndLimits(id);

  const r = await getProviderReadiness(id);
  strictEqual(r.can_activate, false, "sin KYC no se puede activar");
  strictEqual(r.items.find((i) => i.key === "kyc")!.done, false);

  await expectAppError(() => activateProvider(id), "PROVIDER_NOT_READY", "sin KYC");
  strictEqual(await isListed(id), false);
  console.log("  ✓ sin verificacion de identidad no hay activacion");
}

/**
 * El KYC de Etherfuse es para CETES/SPEI. Aceptarlo aqui seria dar por
 * verificada a una persona por un tramite que no dice nada sobre manejar
 * efectivo ajeno.
 */
async function testEtherfuseKycDoesNotEnableTheNetwork() {
  const id = await createUser("etherfuse");
  await enrollProvider(id);
  await setLocationAndLimits(id);
  await setKyc(id, 2, "etherfuse");

  const r = await getProviderReadiness(id);
  strictEqual(r.can_activate, false, "Etherfuse no habilita Red MicoPay");
  ok(
    r.items.find((i) => i.key === "kyc")!.detail?.includes("etherfuse"),
    "y se dice por que, en vez de un 'falta KYC' generico",
  );
  await expectAppError(() => activateProvider(id), "PROVIDER_NOT_READY", "con KYC de Etherfuse");
  console.log("  ✓ la verificacion de Etherfuse no sirve para entrar a la Red");
}

async function testActivationFailsClosedWithoutLocation() {
  const id = await createUser("sinubi");
  await enrollProvider(id);
  await setKyc(id, REQUIRED_PROVIDER_KYC_LEVEL, "didit");
  await db.execute(`UPDATE merchant_configs SET terms_confirmed_at = NOW() WHERE user_id = $1`, [id]);

  const r = await getProviderReadiness(id);
  strictEqual(r.items.find((i) => i.key === "location")!.done, false, "falta la ubicacion");
  await expectAppError(() => activateProvider(id), "PROVIDER_NOT_READY", "sin ubicacion");
  console.log("  ✓ sin zona de entrega no hay activacion");
}

/**
 * Los limites y la comision son NOT NULL con valores por defecto, y la propia
 * base impide combinaciones incoherentes (`daily_cap >= max_trade`, comprobado:
 * el INSERT revienta). Asi que "tiene limites" seria cierto SIEMPRE en cuanto
 * existe la fila, y la casilla no verificaria nada.
 *
 * Lo que se exige es otra cosa: que la persona haya visto y guardado sus propios
 * terminos. Eso si puede ser falso, y este test lo fija.
 */
async function testDefaultLimitsDoNotCountAsConfirmed() {
  const id = await createUser("terminos");
  await enrollProvider(id);
  await setKyc(id, REQUIRED_PROVIDER_KYC_LEVEL, "didit");
  await db.execute(
    `UPDATE merchant_configs SET latitude = $2, longitude = $3, updated_at = NOW() WHERE user_id = $1`,
    [id, CENTER.lat, CENTER.lng],
  );

  const withDefaults = await getProviderReadiness(id);
  const limitsRow = await db.getOne<{ min_trade_mxn: number; daily_cap_mxn: number }>(
    `SELECT min_trade_mxn, daily_cap_mxn FROM merchant_configs WHERE user_id = $1`,
    [id],
  );
  ok(limitsRow!.min_trade_mxn > 0 && limitsRow!.daily_cap_mxn > 0, "los numeros por defecto existen");
  strictEqual(
    withDefaults.items.find((i) => i.key === "limits")!.done,
    false,
    "pero existir no es haberlos aceptado",
  );
  await expectAppError(() => activateProvider(id), "PROVIDER_NOT_READY", "sin confirmar terminos");

  await updateMerchantConfig(id, {
    ratePercent: 2,
    minTradeMxn: 200,
    maxTradeMxn: 10000,
    dailyCapMxn: 50000,
  });
  const confirmed = await getProviderReadiness(id);
  strictEqual(confirmed.items.find((i) => i.key === "limits")!.done, true, "al guardarlos, si");
  strictEqual(confirmed.can_activate, true);
  console.log("  ✓ los limites por defecto no cuentan: hay que revisarlos y guardarlos");
}

async function testActivationWorksWhenComplete() {
  const id = await createUser("completo");
  await enrollProvider(id);
  await setKyc(id, REQUIRED_PROVIDER_KYC_LEVEL, "didit");
  await setLocationAndLimits(id);

  const before = await getProviderReadiness(id);
  strictEqual(before.can_activate, true, "con todo completo si se puede");

  const after = await activateProvider(id);
  strictEqual(after.status, "active");

  // Activarse NO es ponerse disponible: empezar a recibir operaciones es una
  // segunda decision consciente.
  strictEqual(after.merchant_available, false, "activarse no te publica de golpe");
  strictEqual(await isListed(id), false, "y por tanto todavia no sale en el mapa");

  await setProviderAvailability(id, "online");
  strictEqual(await isListed(id), true, "al ponerse disponible, ya sale");
  console.log("  ✓ activarse y ponerse disponible son dos decisiones distintas");
}

async function testActivationIsIdempotent() {
  const id = await makeActiveProvider("reactiva");
  const again = await activateProvider(id);
  strictEqual(again.status, "active", "activar dos veces no rompe nada");
  console.log("  ✓ activar de nuevo a quien ya esta activo no cambia su estado");
}

// ── 4. Disponibilidad: un solo hecho, escrito en un solo sitio ─────────────

async function testAvailabilityRequiresBeingAnActiveProvider() {
  const id = await createUser("nodisp");
  await expectAppError(
    () => setProviderAvailability(id, "online"),
    "PROVIDER_NOT_ACTIVE",
    "sin alta",
  );

  await enrollProvider(id);
  await expectAppError(
    () => setProviderAvailability(id, "online"),
    "PROVIDER_NOT_ACTIVE",
    "solo inscrito",
  );
  console.log("  ✓ quien no es agente activo no tiene disponibilidad que cambiar");
}

/**
 * `availability` y `merchant_available` son el mismo hecho contado dos veces.
 * El endpoint escribia solo el booleano y dejaba la columna obsoleta, asi que
 * el mapa podia mostrar disponible a quien se habia puesto en pausa.
 */
async function testAvailabilityWritesBothColumns() {
  const id = await makeActiveProvider("doscolumnas");

  for (const [availability, expected] of [
    ["paused", false],
    ["offline", false],
    ["online", true],
  ] as const) {
    await setProviderAvailability(id, availability);
    const row = await db.getOne<{ availability: string; merchant_available: boolean }>(
      `SELECT availability, merchant_available FROM users WHERE id = $1`,
      [id],
    );
    strictEqual(row!.availability, availability, `availability queda en ${availability}`);
    strictEqual(row!.merchant_available, expected, `y merchant_available en ${expected}`);
    strictEqual(await isListed(id), expected, `el mapa coincide con el estado real`);
  }
  console.log("  ✓ las dos columnas se escriben juntas; el mapa nunca contradice el estado");
}

// ── 5. Suspension y baneo salen del mapa ───────────────────────────────────

async function testSuspensionRemovesFromDiscovery() {
  const id = await makeActiveProvider("suspender");
  strictEqual(await isListed(id), true, "empieza visible");

  await pauseUser(id, "test_suspend", null);
  strictEqual(await isListed(id), false, "suspendido desaparece del mapa");

  // Y reactivar no lo devuelve solo al mapa: vuelve en pausa.
  await unpauseUser(id, null);
  strictEqual(await isListed(id), false, "levantar la suspension no re-publica sola");

  await setProviderAvailability(id, "online");
  strictEqual(await isListed(id), true, "vuelve cuando la persona lo decide");
  console.log("  ✓ suspender saca del mapa; reactivar no vuelve a publicar sin decision");
}

async function testBannedProviderIsNotListed() {
  const id = await makeActiveProvider("baneado");
  await db.execute(`UPDATE users SET is_banned = true WHERE id = $1`, [id]);
  strictEqual(await isListed(id), false, "un baneado no se ofrece");
  console.log("  ✓ los baneados no aparecen, en vez de fallar al crear la operacion");
}

async function testPendingProviderIsNotListed() {
  const id = await createUser("pendiente");
  await enrollProvider(id);
  await setLocationAndLimits(id);
  await db.execute(`UPDATE users SET merchant_available = true WHERE id = $1`, [id]);
  strictEqual(await isListed(id), false, "pendiente de verificacion no se ofrece");
  console.log("  ✓ estar pendiente no basta para salir en el mapa");
}

// ── 6. El estado es legible sin adivinar ───────────────────────────────────

async function testStatusIsReadableWithoutGuessing() {
  const id = await makeActiveProvider("legible");
  await setProviderAvailability(id, "paused");

  const r = await getProviderReadiness(id);
  strictEqual(r.status, "active", "pertenecer sigue siendo cierto...");
  strictEqual(r.availability, "paused", "...aunque ahora mismo no este disponible");
  strictEqual(r.merchant_available, false);
  // Los dos hechos viajan por separado: la app no tiene que inferir uno del otro
  // ni leer un `verification_status` que no existe.
  console.log("  ✓ pertenencia y disponibilidad se leen por separado, sin inferencias");
}

async function main() {
  console.log("\n  RED-1 · alta explicita en Red MicoPay:\n");

  if (!pool) {
    console.error(
      "\n  ✗ NO VERIFICADO: esta suite necesita PostgreSQL real.\n" +
        "    El shim en memoria no evalua el WHERE compuesto del descubrimiento\n" +
        "    ni la restriccion CHECK de provider_status: pasaria en verde sin\n" +
        "    probar nada.\n",
    );
    process.exit(1);
  }

  await testRegistrationDoesNotEnroll();
  await testEnrollmentIsExplicitAndIdempotent();
  await testActivationFailsClosedWithoutKyc();
  await testEtherfuseKycDoesNotEnableTheNetwork();
  await testActivationFailsClosedWithoutLocation();
  await testDefaultLimitsDoNotCountAsConfirmed();
  await testActivationWorksWhenComplete();
  await testActivationIsIdempotent();
  await testAvailabilityRequiresBeingAnActiveProvider();
  await testAvailabilityWritesBothColumns();
  await testSuspensionRemovesFromDiscovery();
  await testBannedProviderIsNotListed();
  await testPendingProviderIsNotListed();
  await testStatusIsReadableWithoutGuessing();

  console.log("\nAll RED-1 provider enrollment tests passed.\n");
  await pool.end();
}

main().catch(async (err) => {
  console.error(err);
  await pool?.end().catch(() => {});
  process.exit(1);
});
