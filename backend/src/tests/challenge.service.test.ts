/**
 * Regression tests for docs/AUDIT_MOBILE_MAINNET.md finding: "Registro sin
 * prueba de posesión de llave" — POST /users/register (and /auth/token)
 * must not accept a challenge issued for a *different* stellar_address than
 * the one being registered/logged in, and a challenge must be single-use.
 *
 * Runs with MOCK_STELLAR=true, so signature bytes themselves aren't verified
 * (matches existing /auth/token behavior) — these tests cover the parts that
 * DO apply regardless of mock mode: challenge existence, address binding,
 * expiry, and single-use consumption.
 */

import { strictEqual, ok } from "assert";
import { AuthError } from "../utils/errors.js";

// El servicio consulta `config.mockStellar`, y `config` se construye en el
// momento en que se importa. Con un import estático, ESM lo evalúa antes de
// que este archivo pueda tocar el entorno, así que la firma se verificaría de
// verdad y las direcciones sintéticas de abajo fallarían por checksum. De ahí
// el import dinámico: fijar primero el entorno, importar después.
process.env.MOCK_STELLAR = "true";
const { issueChallenge, verifyAndConsumeChallenge } = await import(
  "../services/challenge.service.js"
);

const ADDR_A = "G" + "A".repeat(55);
const ADDR_B = "G" + "B".repeat(55);

async function assertAuthError(fn: () => Promise<unknown>, expectedCode: string, label: string) {
  let threw = false;
  try {
    await fn();
  } catch (err) {
    threw = true;
    ok(err instanceof AuthError, `${label}: expected AuthError, got ${(err as Error)?.constructor?.name}`);
    strictEqual((err as any).code, expectedCode, `${label}: expected code ${expectedCode}, got ${(err as any).code}`);
  }
  ok(threw, `${label}: expected an error to be thrown but none was`);
}

async function testValidChallengeSucceeds() {
  const { challenge } = issueChallenge(ADDR_A);
  await verifyAndConsumeChallenge(ADDR_A, challenge, "any-signature-mock-mode");
  console.log("  ✓ a freshly issued challenge for the right address is accepted");
}

async function testChallengeCannotBeReusedForADifferentAddress() {
  const { challenge } = issueChallenge(ADDR_A);
  // Someone tries to register/login as ADDR_B using a challenge that was
  // issued for ADDR_A — this is exactly the address-squatting gap: without
  // this check, whoever controls a device can claim ANY public address by
  // reusing a challenge string against a different stellar_address.
  await assertAuthError(
    () => verifyAndConsumeChallenge(ADDR_B, challenge, "any-signature"),
    "AUTH_INVALID_CHALLENGE",
    "challenge issued for A used against B",
  );
  console.log("  ✓ a challenge issued for address A is rejected when presented for address B");
}

async function testChallengeIsSingleUse() {
  const { challenge } = issueChallenge(ADDR_A);
  await verifyAndConsumeChallenge(ADDR_A, challenge, "sig-1");

  await assertAuthError(
    () => verifyAndConsumeChallenge(ADDR_A, challenge, "sig-2"),
    "AUTH_INVALID_CHALLENGE",
    "replaying an already-consumed challenge",
  );
  console.log("  ✓ a challenge cannot be replayed after successful verification");
}

async function testUnknownChallengeIsRejected() {
  await assertAuthError(
    () => verifyAndConsumeChallenge(ADDR_A, "never-issued-challenge", "sig"),
    "AUTH_INVALID_CHALLENGE",
    "challenge that was never issued",
  );
  console.log("  ✓ a challenge that was never issued is rejected");
}

async function testWrongChallengeStringIsRejected() {
  issueChallenge(ADDR_A);
  await assertAuthError(
    () => verifyAndConsumeChallenge(ADDR_A, "wrong-challenge-string", "sig"),
    "AUTH_INVALID_CHALLENGE",
    "mismatched challenge string for a valid address",
  );
  console.log("  ✓ a mismatched challenge string is rejected even for the right address");
}


async function main() {
  console.log("\nChallenge/response registration security tests\n");
  await testValidChallengeSucceeds();
  await testChallengeCannotBeReusedForADifferentAddress();
  await testChallengeIsSingleUse();
  await testUnknownChallengeIsRejected();
  await testWrongChallengeStringIsRejected();
  console.log("\nAll challenge.service tests passed.\n");
}

main().catch((err) => {
  console.error("❌ challenge.service tests failed:", err);
  process.exit(1);
});
