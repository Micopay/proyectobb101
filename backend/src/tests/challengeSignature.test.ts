/**
 * Verificación criptográfica real del reto de posesión de llave.
 *
 * `challenge.service.test.ts` corre con MOCK_STELLAR=true y cubre lo que
 * aplica en ambos modos: binding de dirección, expiración y uso único. Este
 * archivo cubre la otra mitad —que la firma se verifique de verdad— y por eso
 * vive aparte: `config` se construye al importarse y Node lo cachea, así que
 * no se puede tener los dos modos en el mismo proceso. Un truco de query en el
 * import dinámico no basta: crea un módulo nuevo de challenge.service, pero
 * este sigue resolviendo al mismo `config.js` ya cacheado, la verificación se
 * salta igual y el test pasa sin probar nada.
 *
 * Cubre el hueco de docs/AUDIT_MOBILE_MAINNET.md, "Registro sin prueba de
 * posesión de llave": sin esto, cualquiera puede registrar la dirección
 * Stellar de otra persona antes que ella, porque las direcciones son públicas.
 *
 * Pedido explícitamente por docs/PLAN_ORDEN_REPO_2026-08-25.md, tarea A-2.
 */

import { strictEqual, ok } from "assert";
import { AuthError } from "../utils/errors.js";

// Antes de cualquier import que arrastre config.
process.env.MOCK_STELLAR = "false";

const { issueChallenge, verifyAndConsumeChallenge } = await import(
  "../services/challenge.service.js"
);
const { Keypair } = await import("@stellar/stellar-sdk");

async function assertAuthError(
  fn: () => Promise<unknown>,
  expectedCode: string,
  label: string,
) {
  let threw = false;
  try {
    await fn();
  } catch (err) {
    threw = true;
    ok(
      err instanceof AuthError,
      `${label}: expected AuthError, got ${(err as Error)?.constructor?.name}`,
    );
    strictEqual(
      (err as any).code,
      expectedCode,
      `${label}: expected code ${expectedCode}, got ${(err as any).code}`,
    );
  }
  ok(threw, `${label}: expected an error to be thrown but none was`);
}

async function testValidSignatureIsAccepted() {
  const kp = Keypair.random();
  const addr = kp.publicKey();
  const { challenge } = issueChallenge(addr);
  const signature = kp.sign(Buffer.from(challenge, "utf8")).toString("base64");

  await verifyAndConsumeChallenge(addr, challenge, signature);
  console.log("  ✓ una firma válida del titular de la llave es aceptada");
}

async function testSignatureFromAnotherKeyIsRejected() {
  // El caso que permitía el squatting: alguien pide un reto para la dirección
  // de otra persona y lo firma con SU propia llave.
  const victim = Keypair.random();
  const attacker = Keypair.random();
  const { challenge } = issueChallenge(victim.publicKey());
  const forged = attacker
    .sign(Buffer.from(challenge, "utf8"))
    .toString("base64");

  await assertAuthError(
    () => verifyAndConsumeChallenge(victim.publicKey(), challenge, forged),
    "AUTH_INVALID_CREDENTIALS",
    "firma hecha con otra llave",
  );
  console.log("  ✓ una firma hecha con otra llave es rechazada");
}

async function testMalformedSignatureIsRejected() {
  const kp = Keypair.random();
  const { challenge } = issueChallenge(kp.publicKey());

  await assertAuthError(
    () => verifyAndConsumeChallenge(kp.publicKey(), challenge, "no-es-base64"),
    "AUTH_INVALID_CREDENTIALS",
    "firma malformada",
  );
  console.log("  ✓ una firma malformada es rechazada sin excepción sin capturar");
}

async function testSignatureForADifferentChallengeIsRejected() {
  // Firma válida en sí misma, pero de otro reto: no debe servir.
  const kp = Keypair.random();
  const addr = kp.publicKey();
  const { challenge } = issueChallenge(addr);
  const otherSig = kp
    .sign(Buffer.from("micopay-auth-otro-reto-cualquiera", "utf8"))
    .toString("base64");

  await assertAuthError(
    () => verifyAndConsumeChallenge(addr, challenge, otherSig),
    "AUTH_INVALID_CREDENTIALS",
    "firma de un reto distinto",
  );
  console.log("  ✓ una firma válida pero de otro reto es rechazada");
}

async function main() {
  console.log("\nVerificación de firma real (MOCK_STELLAR=false)\n");
  await testValidSignatureIsAccepted();
  await testSignatureFromAnotherKeyIsRejected();
  await testMalformedSignatureIsRejected();
  await testSignatureForADifferentChallengeIsRejected();
  console.log("\nAll challenge signature tests passed.\n");
}

main().catch((err) => {
  console.error("❌ challenge signature tests failed:", err);
  process.exit(1);
});
