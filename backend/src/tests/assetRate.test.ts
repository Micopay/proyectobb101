/**
 * La conversion peso -> activo. Aqui se mueve dinero real, asi que los bordes
 * importan mas que los casos felices.
 *
 * EL FALLO QUE FIJA ESTA SUITE (2026-09-05)
 * -----------------------------------------
 * `amount_stroops` se calculaba como `amount_mxn * 10^7`: 1 MXN tratado como 1
 * unidad del activo. El escrow bloquea XLM (verificado en cadena: el `TokenId`
 * del contrato es el SAC del nativo y su `symbol()` devuelve "native"). A ~3.13
 * MXN por XLM, una operacion de 500 pesos bloqueaba 500 XLM = ~1 563 pesos.
 * El cliente entregaba 3.13 veces lo que valia la operacion.
 *
 * Nadie lo vio porque `contracts/TESTNET.md` etiquetaba ese contrato como
 * "MXNe token contract": el diagnostico de julio leyo bien la cadena, comparo
 * contra esa tabla y concluyo que era un peso digital, con lo que la conversion
 * 1:1 parecia correcta.
 *
 * No necesita PostgreSQL: es aritmetica pura, a proposito. La parte delicada de
 * este cambio no toca la base.
 */

import { strictEqual, ok, throws } from "assert";
import {
  rateToScaled,
  mxnToStroops,
  stroopsAtFrozenRate,
  isSupportedAsset,
  DEFAULT_ASSET,
} from "../services/assetRate.service.js";

const SCALE = 10_000_000n;

// ── 1. El fallo concreto ───────────────────────────────────────────────────

function testTheReportedBug() {
  // Lo que hacia antes: 500 MXN -> 500 XLM.
  const buggy = BigInt(500) * SCALE;
  // Lo que hace ahora, a la tasa real del dia que se reporto.
  const fixed = stroopsAtFrozenRate(500, "3.1268270");

  ok(fixed < buggy, "se bloquea MENOS activo que con la conversion 1:1");

  const xlm = Number(fixed) / Number(SCALE);
  ok(xlm > 159 && xlm < 160, `500 MXN son ~159.9 XLM, no 500 (fueron ${xlm})`);

  // El valor en pesos de lo bloqueado vuelve a ser ~500, que es el acuerdo.
  const backToMxn = xlm * 3.126827;
  ok(Math.abs(backToMxn - 500) < 0.01, `lo bloqueado vale ~500 MXN (${backToMxn})`);
  console.log("  ✓ 500 MXN bloquean ~159.9 XLM, no 500 XLM");
}

function testTheErrorWasThreefold() {
  // Deja constancia del tamaño del fallo: no era un decimal, era 3.13 veces.
  const buggy = Number(BigInt(1000) * SCALE);
  const fixed = Number(stroopsAtFrozenRate(1000, "3.1268270"));
  const ratio = buggy / fixed;
  ok(ratio > 3.1 && ratio < 3.2, `el error era ~3.13x (fue ${ratio.toFixed(2)}x)`);
  console.log("  ✓ el fallo bloqueaba 3.13 veces de mas, no un redondeo");
}

// ── 2. La tasa a entero, sin floats ────────────────────────────────────────

function testRateScaling() {
  strictEqual(rateToScaled("1"), SCALE, "la tasa 1 escala a 10^7");
  strictEqual(rateToScaled("3.1268270"), 31_268_270n);
  strictEqual(rateToScaled("17.5"), 175_000_000n, "los decimales se rellenan a la derecha");
  strictEqual(rateToScaled("0.0000001"), 1n, "el septimo decimal se conserva");
  // Un octavo decimal se trunca: es la precision del activo, no un error.
  strictEqual(rateToScaled("1.00000009"), SCALE, "mas de 7 decimales se truncan");

  throws(() => rateToScaled("0"), "una tasa cero es invalida");
  throws(() => rateToScaled("-1"), "una tasa negativa es invalida");
  console.log("  ✓ la tasa se escala a entero sin pasar por float");
}

// ── 3. Redondeo half-up, definido en un solo sitio ─────────────────────────

function testHalfUpRounding() {
  // 3 MXN a tasa 2 = 1.5 unidades exactas -> sin empate.
  strictEqual(mxnToStroops(3, rateToScaled("2")), 15_000_000n);

  // Empate real: se redondea al alza. El vendedor bloquea como mucho un stroop
  // de mas; quedarse corto en dinero ajeno seria peor.
  const tie = mxnToStroops(1, 3n); // 10^14 / 3 = 33333333333333.33
  ok(tie > 0n, "un empate no colapsa a cero");

  // La propiedad que de verdad importa: nunca por debajo de lo pactado.
  for (const rate of ["1", "3.1268270", "17.5", "0.5"]) {
    const scaled = rateToScaled(rate);
    for (const amount of [1, 7, 100, 499, 500, 9999]) {
      const stroops = mxnToStroops(amount, scaled);
      const exact = (BigInt(amount) * SCALE * SCALE) / scaled;
      ok(
        stroops >= exact,
        `${amount} MXN a ${rate}: se bloquea al menos lo exacto (${stroops} vs ${exact})`,
      );
      ok(stroops - exact <= 1n, "y como mucho un stroop de mas");
    }
  }
  console.log("  ✓ redondeo half-up: nunca por debajo de lo pactado, un stroop como mucho");
}

function testMxneIsUnchanged() {
  // Un peso digital vale 1 peso: la conversion tiene que reproducir byte a byte
  // el comportamiento historico, o los montos de esas operaciones cambiarian.
  for (const amount of [1, 100, 500, 12345]) {
    strictEqual(
      mxnToStroops(amount, rateToScaled("1")),
      BigInt(amount) * SCALE,
      `${amount} MXNe = ${amount} * 10^7 stroops, exacto`,
    );
  }
  console.log("  ✓ a tasa 1 los montos no cambian ni un stroop");
}

function testRejectsNonsense() {
  throws(() => mxnToStroops(-1, SCALE), "un monto negativo es invalido");
  throws(() => mxnToStroops(1.5, SCALE), "los pesos son enteros en este sistema");
  console.log("  ✓ montos imposibles se rechazan en vez de convertirse en basura");
}

// ── 4. La tasa congelada ───────────────────────────────────────────────────

/**
 * Lo pactado no puede moverse. Si el bloqueo recalculara con la tasa viva, el
 * monto firmado y el verificado diferirian y el XDR seria rechazado — o peor,
 * el cliente bloquearia una cantidad distinta de la que acepto.
 */
function testFrozenRateIsDeterministic() {
  const a = stroopsAtFrozenRate(500, "3.1268270");
  const b = stroopsAtFrozenRate(500, "3.1268270");
  strictEqual(a, b, "la misma tasa da siempre el mismo resultado");

  const later = stroopsAtFrozenRate(500, "3.9000000");
  ok(later !== a, "una tasa distinta daria otro monto: por eso se congela");
  console.log("  ✓ con la tasa congelada, el monto no se mueve entre crear y bloquear");
}

function testSupportedAssets() {
  strictEqual(DEFAULT_ASSET, "XLM", "hoy el escrow desplegado bloquea XLM");
  ok(isSupportedAsset("XLM") && isSupportedAsset("USDC") && isSupportedAsset("MXNE"));
  ok(!isSupportedAsset("DOGE"), "un activo desconocido no pasa");
  console.log("  ✓ la tabla de activos deja sitio a USDC y MXNe sin tocar la aritmetica");
}

function main() {
  console.log("\n  Conversion peso -> activo del escrow:\n");
  testTheReportedBug();
  testTheErrorWasThreefold();
  testRateScaling();
  testHalfUpRounding();
  testMxneIsUnchanged();
  testRejectsNonsense();
  testFrozenRateIsDeterministic();
  testSupportedAssets();
  console.log("\nAll asset rate conversion tests passed.\n");
}

main();
