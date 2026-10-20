/**
 * CASH-9 · Atribuir los controles de abuso a quien de verdad inicia.
 *
 * Seguimiento correctivo de los issues cerrados #82 y #2.
 *
 * La creacion de operaciones trataba `buyer_id` como el cliente. En cash-out
 * el cliente es el VENDEDOR del escrow, asi que:
 *
 *   - el dispositivo del cliente se guardaba bajo el proveedor;
 *   - todo el volumen de cash-out del proveedor se le cargaba como si fuera un
 *     cliente intensivo, mientras el limite diario del cliente no se medía;
 *   - el mismo cliente no se seguia entre proveedores distintos;
 *   - dos clientes sin relacion que usaran al mismo proveedor podian parecer
 *     la misma persona;
 *   - los eventos de auditoria nombraban al usuario equivocado.
 *
 * AVISO SOBRE COMO CORRERLO. Las comprobaciones de atribucion consultan
 * `((flow='deposit' AND buyer_id=$1) OR (flow='cashout' AND seller_id=$1))`.
 * El shim en memoria de `src/db/schema.ts` NO evalua un WHERE compuesto asi:
 * devuelve todas las filas. Contra el shim, este archivo pasaria sin probar
 * nada, que es exactamente el defecto que este issue corrige en otro lugar.
 *
 * Por eso exige PostgreSQL real y lo dice en voz alta si no lo hay:
 *
 *   docker run -d --name mp-pg -e POSTGRES_PASSWORD=x -e POSTGRES_DB=micopay  *     -p 55432:5432 postgres:16-alpine
 *   DATABASE_URL=postgres://postgres:x@localhost:55432/micopay npm run migrate
 *   DATABASE_URL=postgres://postgres:x@localhost:55432/micopay npm run test:initiator
 */

import { strictEqual, ok } from "assert";
import db from "../db/schema.js";
import { deriveInitiatorId } from "../services/abuse.service.js";

// Sufijo por corrida: contra PostgreSQL real la base persiste entre
// ejecuciones, y un contador que reinicia choca con la unicidad de
// `username`. Sin esto la suite solo se puede correr una vez.
const RUN = Math.random().toString(36).slice(2, 8);
let seq = 0;
async function createUser(label: string): Promise<string> {
  seq++;
  const suffix = `${RUN}${String(seq).padStart(2, "0")}`;
  const row = await db.getOne<{ id: string }>(
    `INSERT INTO users (stellar_address, username, phone_hash, merchant_available, availability, is_suspended)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id`,
    [
      // 1 + 47 + 8 = 56, el largo exacto de una direccion Stellar.
      `G${"E".repeat(47)}${suffix}`,
      `cash9_${label}_${suffix}`,
      `hash_cash9_${label}_${suffix}`,
      true,
      "online",
      false,
    ],
  );
  if (!row?.id) throw new Error(`Failed to seed user ${label}`);
  return row.id;
}

async function insertTrade(
  flow: "deposit" | "cashout",
  clientId: string,
  providerId: string,
  amountMxn = 500,
) {
  const cashout = flow === "cashout";
  const sellerId = cashout ? clientId : providerId;
  const buyerId = cashout ? providerId : clientId;
  const now = new Date().toISOString();
  const expires = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
  await db.execute(
    `INSERT INTO trades
       (seller_id, buyer_id, flow, provider_id, amount_mxn, amount_stroops, secret_hash, status, created_at, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      sellerId,
      buyerId,
      flow,
      providerId,
      amountMxn,
      "5000000000",
      `h_${seq}_${Math.random()}`,
      "pending",
      now,
      expires,
    ],
  );
}

/**
 * Replica la consulta que usa el servicio para contar lo que inicio una
 * persona. Se mide asi porque el conteo real es privado del modulo.
 */
async function countInitiated(userId: string): Promise<{ count: number; volume: number }> {
  const rows = await db.getMany<{ amount_mxn: number }>(
    `SELECT amount_mxn FROM trades
     WHERE ((flow = 'deposit' AND buyer_id = $1)
         OR (flow = 'cashout' AND seller_id = $1))
       AND status IN ('pending', 'locked', 'revealing', 'completed')`,
    [userId],
  );
  return {
    count: rows.length,
    volume: rows.reduce((s, r) => s + Number(r.amount_mxn || 0), 0),
  };
}

/** La forma vieja de contar, para poder mostrar la diferencia. */
async function countAsEscrowBuyer(userId: string): Promise<number> {
  const rows = await db.getMany(
    `SELECT amount_mxn FROM trades WHERE buyer_id = $1
       AND status IN ('pending', 'locked', 'revealing', 'completed')`,
    [userId],
  );
  return rows.length;
}

// ── 1. La derivación ───────────────────────────────────────────────────────

function testInitiatorDependsOnFlow() {
  strictEqual(deriveInitiatorId("deposit", "seller-1", "buyer-1"), "buyer-1", "depósito → comprador");
  strictEqual(deriveInitiatorId("cashout", "seller-1", "buyer-1"), "seller-1", "cash-out → vendedor");
  console.log("  ✓ quién inicia depende del flujo, no del rol del escrow");
}

// ── 2. El mismo cliente entre proveedores distintos ────────────────────────

async function testSameClientAcrossProviders() {
  const client = await createUser("client");
  const providerA = await createUser("provA");
  const providerB = await createUser("provB");

  await insertTrade("cashout", client, providerA, 300);
  await insertTrade("cashout", client, providerB, 400);

  const initiated = await countInitiated(client);
  strictEqual(initiated.count, 2, "las dos operaciones son del mismo cliente");
  strictEqual(initiated.volume, 700, "y su volumen se suma");

  // Antes esto daba 0: en cash-out el cliente nunca es buyer_id, así que su
  // actividad entre proveedores era invisible.
  strictEqual(await countAsEscrowBuyer(client), 0, "la forma vieja no veía nada");
  console.log("  ✓ el mismo cliente se reconoce entre dos proveedores distintos");
}

// ── 3. Dos clientes con un proveedor no se funden ──────────────────────────

async function testTwoClientsOneProviderStaySeparate() {
  const clientA = await createUser("cliA");
  const clientB = await createUser("cliB");
  const provider = await createUser("prov");

  await insertTrade("cashout", clientA, provider, 500);
  await insertTrade("cashout", clientB, provider, 500);

  strictEqual((await countInitiated(clientA)).count, 1, "cada cliente cuenta lo suyo");
  strictEqual((await countInitiated(clientB)).count, 1);
  strictEqual((await countInitiated(provider)).count, 0, "el proveedor no inició nada");

  // Antes las dos caían bajo el proveedor: dos personas sin relación se veían
  // como un solo comprador muy activo.
  strictEqual(await countAsEscrowBuyer(provider), 2, "la forma vieja las fundía en el proveedor");
  console.log("  ✓ dos clientes con un mismo proveedor no se funden");
}

// ── 4. El límite diario cuenta los dos flujos ──────────────────────────────

async function testDailyLimitCountsBothFlows() {
  const client = await createUser("mixto");
  const provider = await createUser("prov");

  await insertTrade("deposit", client, provider, 200);
  await insertTrade("cashout", client, provider, 300);

  const initiated = await countInitiated(client);
  strictEqual(initiated.count, 2, "depósito y cash-out cuentan para el mismo cliente");
  strictEqual(initiated.volume, 500);
  console.log("  ✓ el límite diario del cliente cuenta depósito y cash-out");
}

// ── 5. El volumen del proveedor no se le carga como cliente ────────────────

async function testProviderVolumeIsNotChargedToProvider() {
  const provider = await createUser("prov");
  const clients = [await createUser("c1"), await createUser("c2"), await createUser("c3")];
  for (const c of clients) await insertTrade("cashout", c, provider, 1000);

  strictEqual((await countInitiated(provider)).count, 0, "el proveedor no inició ninguna");
  strictEqual((await countInitiated(provider)).volume, 0, "ni acumula su volumen como cliente");

  // Antes: 3 operaciones y 3000 MXN contra su límite diario de cliente, solo
  // por proveer liquidez. Con suficientes clientes, el proveedor se
  // autobloqueaba.
  strictEqual(await countAsEscrowBuyer(provider), 3, "la forma vieja se lo cargaba todo");
  console.log("  ✓ proveer liquidez ya no consume el límite diario de cliente");
}

// ── 6. El depósito no cambia ───────────────────────────────────────────────

async function testDepositUnchanged() {
  const client = await createUser("dep_cli");
  const provider = await createUser("dep_prov");
  await insertTrade("deposit", client, provider, 250);

  strictEqual((await countInitiated(client)).count, 1, "en depósito el cliente sigue siendo el iniciador");
  strictEqual(await countAsEscrowBuyer(client), 1, "y ahí la forma vieja ya acertaba");
  ok(
    (await countInitiated(provider)).count === 0,
    "el proveedor de un depósito tampoco inicia",
  );
  console.log("  ✓ en depósito la atribución no cambió (ahí ya era correcta)");
}

async function main() {
  console.log("\n  CASH-9 (#82/#2 follow-up) atribución del iniciador:\n");

  // La derivación es pura: se comprueba siempre.
  testInitiatorDependsOnFlow();

  // `db.pool` es null cuando se cayó al store en memoria, aunque DATABASE_URL
  // esté definida pero apunte a una base inalcanzable. Se comprueba el store
  // real, no la variable de entorno.
  if (!db.pool) {
    console.error(
      "\n  ✗ NO VERIFICADO: la atribución necesita PostgreSQL real.\n" +
        "    El store en memoria no evalúa el WHERE compuesto y devuelve TODAS\n" +
        "    las filas, así que estas comprobaciones pasarían sin probar nada.\n" +
        "    Ver el encabezado del archivo para levantarlo.\n",
    );
    process.exit(1);
  }

  await testSameClientAcrossProviders();
  await testTwoClientsOneProviderStaySeparate();
  await testDailyLimitCountsBothFlows();
  await testProviderVolumeIsNotChargedToProvider();
  await testDepositUnchanged();
  console.log("\nAll CASH-9 initiator attribution tests passed.\n");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
