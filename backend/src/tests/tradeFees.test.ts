/**
 * Las comisiones que se anuncian tienen que ser las que se cobran.
 *
 * Reportado desde el APK el 2026-09-05: "los fees de agente y plataforma no son
 * correctos". Al mirarlo, eran tres fallos encadenados:
 *
 *   1. El descubrimiento anunciaba `payout = monto * (1 - tarifa)` e IGNORABA
 *      la comision de plataforma. El mapa prometia un neto que la operacion no
 *      cumplia.
 *   2. La pantalla de confirmacion deducia la parte del agente RESTANDO la de
 *      plataforma de ese total. Un agente al 1.5% acababa cobrando 0.7%, sin
 *      saberlo y sin haberlo aceptado.
 *   3. `trades` no guardaba la comision del agente en ninguna columna: al
 *      liquidar no habia ningun numero que dijera cuanto le tocaba.
 *
 * DECISION DE PRODUCTO (2026-09-05): el cliente paga las dos. El agente cobra
 * su tarifa integra y la plataforma la suya aparte.
 *
 * NECESITA POSTGRESQL REAL para los casos que tocan la base: el shim en memoria
 * no evalua el JOIN de la consulta de descubrimiento.
 *
 *   DATABASE_URL=postgres://... npx tsx src/tests/tradeFees.test.ts
 */

import { strictEqual, ok } from "assert";
import db, { pool } from "../db/schema.js";
import { computeTradeFees, PLATFORM_FEE_PERCENT } from "../services/tradeFees.js";
import { getAvailableMerchants } from "../services/merchant.service.js";

const RUN = Math.random().toString(36).slice(2, 8);
let seq = 0;
const CENTER = { lat: 21.0 + Math.random() * 0.8, lng: -101.6 + Math.random() * 0.8 };

async function createProvider(ratePercent: number): Promise<string> {
  seq++;
  const suffix = `${RUN}${String(seq).padStart(2, "0")}`;
  const row = await db.getOne<{ id: string }>(
    `INSERT INTO users (stellar_address, username, phone_hash, merchant_available,
                        availability, is_suspended, provider_status)
     VALUES ($1, $2, $3, true, 'online', false, 'active')
     RETURNING id`,
    [`G${"F".repeat(47)}${suffix}`, `fee_${suffix}`, `h_fee_${suffix}`],
  );
  await db.execute(
    `INSERT INTO merchant_configs
       (user_id, rate_percent, min_trade_mxn, max_trade_mxn, daily_cap_mxn,
        latitude, longitude, terms_confirmed_at, updated_at)
     VALUES ($1, $2, 100, 50000, 250000, $3, $4, NOW(), NOW())`,
    [row!.id, ratePercent, CENTER.lat, CENTER.lng],
  );
  return row!.id;
}

// ── 1. El desglose ─────────────────────────────────────────────────────────

function testClientPaysBothFees() {
  const f = computeTradeFees(500, 1.5);

  strictEqual(f.providerFeeMxn, 8, "el agente cobra su 1.5% integro (redondeado al alza)");
  strictEqual(f.platformFeeMxn, 4, "la plataforma cobra su 0.8% aparte");
  strictEqual(f.payoutMxn, 488, "el cliente recibe el monto menos AMBAS");

  // El fallo concreto que se reporto: antes el agente veia su comision
  // reducida por la de plataforma.
  ok(
    f.providerFeeMxn > f.platformFeeMxn,
    "la comision del agente no se recorta con la de plataforma",
  );
  console.log("  ✓ el cliente paga las dos; la del agente no se recorta");
}

function testAgentRateIsRespectedExactly() {
  // Un agente que pone 2% tiene que cobrar 2%, no 2% menos lo que se lleve la
  // plataforma. Esta es la promesa que el codigo anterior rompia en silencio.
  for (const [rate, amount, expected] of [
    [2, 1000, 20],
    [0.5, 1000, 5],
    [0, 1000, 0],
    [3, 250, 8], // 7.5 redondeado al alza
  ] as const) {
    const f = computeTradeFees(amount, rate);
    strictEqual(f.providerFeeMxn, expected, `${rate}% de ${amount} = ${expected}`);
  }
  console.log("  ✓ la tarifa del agente se respeta al pie de la letra");
}

function testRoundingNeverFavoursNobody() {
  // Los dos redondeos van al alza, asi que el cliente absorbe los centavos.
  // Lo que NO puede pasar es que la suma no cuadre.
  for (let amount = 1; amount <= 1000; amount += 7) {
    for (const rate of [0, 0.3, 1, 1.5, 2.75, 5]) {
      const f = computeTradeFees(amount, rate);
      strictEqual(
        f.payoutMxn + f.providerFeeMxn + f.platformFeeMxn,
        amount,
        `las tres partes suman el monto (${amount} al ${rate}%)`,
      );
      ok(f.payoutMxn >= 0, "el neto nunca es negativo");
    }
  }
  console.log("  ✓ neto + agente + plataforma = monto, siempre, sin negativos");
}

function testTinyAmountsDoNotGoNegative() {
  // Con montos minusculos los dos redondeos al alza podrian comerse el
  // principal entero. Anunciar un neto negativo seria absurdo.
  const f = computeTradeFees(1, 50);
  ok(f.payoutMxn >= 0, "el neto no baja de cero");
  console.log("  ✓ un monto minusculo no produce un neto negativo");
}

function testEffectivePercentIsTheRealCost() {
  const f = computeTradeFees(1000, 1.5);
  // 15 + 8 = 23 sobre 1000 = 2.3%
  strictEqual(f.effectivePercent, 2.3, "el coste efectivo suma las dos comisiones");
  ok(
    f.effectivePercent > PLATFORM_FEE_PERCENT,
    "y siempre es mayor que la comision de plataforma sola",
  );
  console.log("  ✓ el coste efectivo es el total, no una de las dos partes");
}

// ── 2. Lo que anuncia el mapa ──────────────────────────────────────────────

async function testDiscoveryAnnouncesWhatTheTradeCharges() {
  const providerId = await createProvider(1.5);

  const found = (
    await getAvailableMerchants({
      lat: CENTER.lat,
      lng: CENTER.lng,
      radius_km: 5,
      amount_mxn: 500,
    })
  ).find((m) => m.seller_id === providerId);
  ok(found, "el agente aparece en el mapa");

  const expected = computeTradeFees(500, 1.5);
  strictEqual(found!.payout_mxn, expected.payoutMxn, "el neto anunciado ya descuenta las dos");
  strictEqual(found!.provider_fee_mxn, expected.providerFeeMxn, "y viaja el desglose del agente");
  strictEqual(found!.platform_fee_mxn, expected.platformFeeMxn, "y el de la plataforma");

  // El fallo original: el mapa prometia 492.50 y la operacion cobraba 4 mas.
  ok(
    found!.payout_mxn < 500 * (1 - 1.5 / 100),
    "el neto anunciado es MENOR que descontando solo la tarifa del agente",
  );
  console.log("  ✓ el mapa anuncia exactamente lo que la operacion va a cobrar");
}

/**
 * La app no debe tener que deducir ninguna parte restando: fue asi como se colo
 * el error. El servidor manda las tres cifras.
 */
async function testBreakdownTravelsWhole() {
  const providerId = await createProvider(2);
  const found = (
    await getAvailableMerchants({
      lat: CENTER.lat,
      lng: CENTER.lng,
      radius_km: 5,
      amount_mxn: 1000,
    })
  ).find((m) => m.seller_id === providerId)!;

  strictEqual(
    found.payout_mxn + found.provider_fee_mxn + found.platform_fee_mxn,
    1000,
    "las tres cifras cuadran solas, sin que la app calcule nada",
  );
  ok(found.effective_fee_percent > 0, "y viaja el coste efectivo ya calculado");
  console.log("  ✓ el desglose llega entero; la app no deduce nada restando");
}

async function main() {
  console.log("\n  Comisiones de agente y plataforma:\n");

  testClientPaysBothFees();
  testAgentRateIsRespectedExactly();
  testRoundingNeverFavoursNobody();
  testTinyAmountsDoNotGoNegative();
  testEffectivePercentIsTheRealCost();

  if (!pool) {
    console.error(
      "\n  ✗ Los casos de descubrimiento NO se verificaron: necesitan PostgreSQL real.\n" +
        "    El shim en memoria no evalua el JOIN de la consulta.\n",
    );
    process.exit(1);
  }

  await testDiscoveryAnnouncesWhatTheTradeCharges();
  await testBreakdownTravelsWhole();

  console.log("\nAll trade fee tests passed.\n");
  await pool.end();
}

main().catch(async (err) => {
  console.error(err);
  await pool?.end().catch(() => {});
  process.exit(1);
});
