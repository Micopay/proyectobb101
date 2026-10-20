/**
 * RED-3 · La zona es pública; el punto de encuentro no.
 *
 * `GET /merchants/available` es público y sin autenticar. El arreglo `905cf77`
 * le puso rate limit y redondeó las coordenadas a ~110 m, pero seguía
 * devolviendo `address_text` tal cual: un campo de texto libre que lo mismo
 * decía "Centro, CDMX" que una dirección con número. Redondear las
 * coordenadas no protege nada si al lado viaja el domicilio escrito.
 *
 * Los proveedores de Red MicoPay pueden ser comercios, trabajadores
 * informales o particulares. Un local quizá quiere publicarse; una persona no
 * puede acabar publicando su casa en un endpoint enumerable sin elegirlo.
 *
 * NECESITA POSTGRESQL REAL: el shim en memoria no evalúa el JOIN ni el CASE
 * de la consulta de discovery, así que pasaría en verde sin probar nada.
 *
 *   docker run -d --name mp-pg -e POSTGRES_PASSWORD=x -e POSTGRES_DB=micopay \
 *     -p 55432:5432 postgres:16-alpine
 *   DATABASE_URL=postgres://postgres:x@localhost:55432/micopay npm run migrate
 *   DATABASE_URL=postgres://postgres:x@localhost:55432/micopay npm run test:meeting-point
 */

import { strictEqual, ok } from "assert";
import db, { pool } from "../db/schema.js";
import { getAvailableMerchants } from "../services/merchant.service.js";
import { getTradeMeetingPoint } from "../services/trade.service.js";
import { AppError } from "../utils/errors.js";

const fakeRequest = {
  ip: "127.0.0.1",
  headers: {},
  log: { info: () => {}, warn: () => {}, error: () => {} },
} as any;

const RUN = Math.random().toString(36).slice(2, 8);
let seq = 0;

// Únicos por corrida: contra PostgreSQL real la base persiste, y el barrido
// "el domicilio no aparece en ninguna parte" encontraría el de una corrida
// anterior publicada a propósito por otro caso. Sin esto la suite solo sirve
// una vez — comprobado.
const CASA = `Calle Bugambilias 45 int 3, Coyoacán #${RUN}`;
const ZONA = `Coyoacán, CDMX #${RUN}`;
// Cada corrida usa su propia zona. Con un centro fijo, todos los proveedores
// de todas las corridas caen en el mismo punto y el LIMIT 50 de la consulta
// acaba dejando fuera a los recien creados: el test empezaba a fallar por
// acumulacion, no por el codigo. Separar las corridas ~10 km las aisla.
const CENTER = {
  lat: 19.0 + Math.random() * 0.8,
  lng: -99.6 + Math.random() * 0.8,
};

async function createUser(label: string): Promise<string> {
  seq++;
  const suffix = `${RUN}${String(seq).padStart(2, "0")}`;
  // RED-1: los proveedores se dan de alta explicitamente. Desde que pertenecer
  // a Red MicoPay es un estado propio, crear una cuenta "disponible" ya no la
  // convierte en proveedora: esa inferencia era justo el defecto.
  const row = await db.getOne<{ id: string }>(
    `INSERT INTO users (stellar_address, username, phone_hash, merchant_available, availability, is_suspended, provider_status)
     VALUES ($1, $2, $3, true, 'online', false, 'active')
     RETURNING id`,
    [`G${"H".repeat(47)}${suffix}`, `red3_${label}_${suffix}`, `h_red3_${label}_${suffix}`],
  );
  if (!row?.id) throw new Error(`Failed to seed ${label}`);
  return row.id;
}

async function createProvider(opts: {
  areaLabel: string | null;
  meetingPoint: string | null;
  publish: boolean;
}): Promise<string> {
  const id = await createUser("prov");
  await db.execute(
    `INSERT INTO merchant_configs
       (user_id, rate_percent, min_trade_mxn, max_trade_mxn, daily_cap_mxn,
        latitude, longitude, area_label, meeting_point, publish_storefront, updated_at)
     VALUES ($1, 2.5, 100, 50000, 250000, $2, $3, $4, $5, $6, NOW())`,
    [id, CENTER.lat, CENTER.lng, opts.areaLabel, opts.meetingPoint, opts.publish],
  );
  return id;
}

async function createTrade(clientId: string, providerId: string, status: string): Promise<string> {
  seq++;
  const row = await db.getOne<{ id: string }>(
    `INSERT INTO trades
       (seller_id, buyer_id, flow, provider_id, amount_mxn, amount_stroops, secret_hash, status, expires_at)
     VALUES ($1, $2, 'cashout', $2, 500, 5000000000, $3, $4, NOW() + INTERVAL '2 hours')
     RETURNING id`,
    [clientId, providerId, `h_red3_${RUN}_${seq}`, status],
  );
  if (!row?.id) throw new Error("Failed to insert trade");
  return row.id;
}

const discover = () =>
  getAvailableMerchants({ lat: CENTER.lat, lng: CENTER.lng, radius_km: 5, amount_mxn: 500 });

async function expectForbidden(fn: () => Promise<unknown>, what: string) {
  try {
    await fn();
  } catch (err) {
    if (err instanceof AppError && err.httpStatus === 403) return;
    throw err;
  }
  throw new Error(`${what}: se esperaba 403 y no hubo error`);
}

// ── 1. Enumeración anónima ─────────────────────────────────────────────────

async function testAnonymousDiscoveryNeverLeaksTheAddress() {
  const provider = await createProvider({ areaLabel: ZONA, meetingPoint: CASA, publish: false });

  const results = await discover();
  const mine = results.find((m) => m.seller_id === provider);
  ok(mine, "el proveedor aparece en discovery");

  strictEqual(mine!.area_label, ZONA, "la zona pública sí sale");
  strictEqual(mine!.storefront_address, null, "la dirección exacta NO sale");

  // Barrido sobre la respuesta entera: el domicilio no puede aparecer en
  // ningún campo, ni siquiera por descuido en un map().
  const serialized = JSON.stringify(results);
  ok(!serialized.includes(CASA), "el domicilio no aparece en ninguna parte de la respuesta");
  console.log("  ✓ discovery anónimo nunca devuelve el domicilio");
}

async function testCoordinatesStayRounded() {
  const provider = await createProvider({ areaLabel: ZONA, meetingPoint: CASA, publish: false });
  const mine = (await discover()).find((m) => m.seller_id === provider)!;
  strictEqual(mine.latitude, Math.round(CENTER.lat * 1000) / 1000, "la latitud sigue redondeada");
  strictEqual(mine.longitude, Math.round(CENTER.lng * 1000) / 1000, "y la longitud también");
  console.log("  ✓ el redondeo de coordenadas de 905cf77 sigue en pie");
}

// ── 2. Consentimiento explícito ────────────────────────────────────────────

async function testStorefrontRequiresExplicitConsent() {
  const shy = await createProvider({ areaLabel: ZONA, meetingPoint: CASA, publish: false });
  const shop = await createProvider({ areaLabel: ZONA, meetingPoint: CASA, publish: true });

  const results = await discover();
  strictEqual(
    results.find((m) => m.seller_id === shy)!.storefront_address,
    null,
    "sin consentimiento no se publica",
  );
  strictEqual(
    results.find((m) => m.seller_id === shop)!.storefront_address,
    CASA,
    "con consentimiento sí",
  );
  console.log("  ✓ publicar la dirección exige consentimiento explícito, no se infiere");
}

// ── 3. Solo participantes ──────────────────────────────────────────────────

async function testOnlyParticipantsSeeTheMeetingPoint() {
  const client = await createUser("cli");
  const stranger = await createUser("x");
  const provider = await createProvider({ areaLabel: ZONA, meetingPoint: CASA, publish: false });
  const tradeId = await createTrade(client, provider, "locked");

  const forClient = await getTradeMeetingPoint(tradeId, client);
  strictEqual(forClient.meeting_point, CASA, "el cliente lo ve");
  strictEqual(forClient.reason, "shared");

  const forProvider = await getTradeMeetingPoint(tradeId, provider);
  strictEqual(forProvider.meeting_point, CASA, "el proveedor también");

  await expectForbidden(() => getTradeMeetingPoint(tradeId, stranger), "un tercero");
  console.log("  ✓ solo las dos partes obtienen el punto; un tercero recibe 403");
}

// ── 4. Ciclo de vida ───────────────────────────────────────────────────────

async function testPendingTradeDoesNotRevealIt() {
  const client = await createUser("cli");
  const provider = await createProvider({ areaLabel: ZONA, meetingPoint: CASA, publish: false });
  const tradeId = await createTrade(client, provider, "pending");

  const res = await getTradeMeetingPoint(tradeId, client);
  strictEqual(res.meeting_point, null, "una operación sin aceptar no revela el punto");
  strictEqual(res.reason, "trade_not_accepted");
  // Si `pending` bastara, crear operaciones seria una forma de enumerar
  // direcciones con un paso extra.
  console.log("  ✓ una operación solo creada no basta para obtener la dirección");
}

async function testTerminalTradesStopRevealingIt() {
  for (const terminal of ["completed", "cancelled", "refunded", "expired"] as const) {
    const client = await createUser(`cli_${terminal}`);
    const provider = await createProvider({ areaLabel: ZONA, meetingPoint: CASA, publish: false });
    const tradeId = await createTrade(client, provider, "locked");

    strictEqual((await getTradeMeetingPoint(tradeId, client)).meeting_point, CASA, "mientras vive, sí");

    await db.execute(`UPDATE trades SET status = $2 WHERE id = $1`, [tradeId, terminal]);
    const after = await getTradeMeetingPoint(tradeId, client);
    strictEqual(after.meeting_point, null, `${terminal} deja de revelarlo`);
    strictEqual(after.reason, "trade_terminal");
  }
  console.log("  ✓ completada, cancelada, reembolsada y expirada dejan de revelarlo");
}

async function testAreaLabelStaysVisibleThroughout() {
  const client = await createUser("cli");
  const provider = await createProvider({ areaLabel: ZONA, meetingPoint: CASA, publish: false });
  const tradeId = await createTrade(client, provider, "locked");

  await db.execute(`UPDATE trades SET status = 'cancelled' WHERE id = $1`, [tradeId]);
  const after = await getTradeMeetingPoint(tradeId, client);
  strictEqual(after.area_label, ZONA, "la zona pública sigue disponible; nunca fue el secreto");
  console.log("  ✓ la zona pública no se oculta: no es el dato sensible");
}

async function testProviderWithoutMeetingPoint() {
  const client = await createUser("cli");
  const provider = await createProvider({ areaLabel: ZONA, meetingPoint: null, publish: false });
  const tradeId = await createTrade(client, provider, "revealing");

  const res = await getTradeMeetingPoint(tradeId, client);
  strictEqual(res.meeting_point, null);
  strictEqual(res.reason, "not_set", "se distingue 'no configurado' de 'no autorizado'");
  console.log("  ✓ se distingue no configurado de no permitido");
}

async function main() {
  console.log("\n  RED-3 · privacidad del punto de encuentro:\n");

  if (!pool) {
    console.error(
      "\n  ✗ NO VERIFICADO: esta suite necesita PostgreSQL real.\n" +
        "    El shim en memoria no evalúa el JOIN ni el CASE de la consulta de\n" +
        "    discovery: pasaría en verde sin probar nada.\n",
    );
    process.exit(1);
  }

  await testAnonymousDiscoveryNeverLeaksTheAddress();
  await testCoordinatesStayRounded();
  await testStorefrontRequiresExplicitConsent();
  await testOnlyParticipantsSeeTheMeetingPoint();
  await testPendingTradeDoesNotRevealIt();
  await testTerminalTradesStopRevealingIt();
  await testAreaLabelStaysVisibleThroughout();
  await testProviderWithoutMeetingPoint();
  console.log("\nAll RED-3 meeting point privacy tests passed.\n");
  await pool.end();
}

main().catch(async (err) => {
  console.error(err);
  await pool?.end().catch(() => {});
  process.exit(1);
});
