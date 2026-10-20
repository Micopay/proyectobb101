/**
 * El aviso de una operacion nueva va al PROVEEDOR, y nombra al CLIENTE.
 *
 * EL FALLO
 * --------
 * `createTrade` avisaba a `sellerId`. Eso es correcto solo en deposito. En
 * cash-out el `seller` del escrow es el CLIENTE —lo fijo CASH-1 con
 * `deriveProviderId`— asi que la app le notificaba a la persona su propia
 * operacion recien creada, mientras el agente, que es quien tiene que actuar,
 * no se enteraba de nada.
 *
 * El codigo del aviso es anterior al modelo de flujos y nunca se actualizo.
 *
 * POR QUE IMPORTA MAS DE LO QUE PARECE
 * ------------------------------------
 * En deposito el cliente lleva EFECTIVO y no puede bloquear nada: depende de
 * que el agente lo haga. Si al agente no se le avisa, la persona espera a
 * alguien que no sabe que existe. El aviso no es una comodidad, es la unica
 * pieza que arranca la coordinacion.
 *
 * ALCANCE HONESTO DE ESTA SUITE
 * -----------------------------
 * Prueba a QUIEN se dirige el aviso y con que datos. NO prueba que llegue al
 * telefono: hoy no puede llegar. Firebase esta con credenciales `PLACEHOLDER`
 * en produccion, la app no registra ningun token de dispositivo y el manifiesto
 * de Android no pide permiso de notificaciones. Eso es trabajo aparte, y decirlo
 * aqui evita leer estos tests como una garantia de entrega.
 */

import { strictEqual, ok } from "assert";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import db from "../db/schema.js";

const RUN = Math.random().toString(36).slice(2, 8);
let seq = 0;

async function createUser(label: string): Promise<{ id: string; username: string }> {
  seq++;
  const suffix = `${RUN}${String(seq).padStart(2, "0")}`;
  const username = `notif_${label}_${suffix}`;
  const row = await db.getOne<{ id: string }>(
    `INSERT INTO users (stellar_address, username, phone_hash, merchant_available,
                        availability, is_suspended, provider_status, push_token)
     VALUES ($1, $2, $3, true, 'online', false, 'active', $4)
     RETURNING id`,
    [`G${"N".repeat(47)}${suffix}`, username, `h_notif_${suffix}`, `tok_${suffix}`],
  );
  if (!row?.id) throw new Error(`Failed to seed ${label}`);
  return { id: row.id, username };
}

/**
 * Reproduce la eleccion de destinatario tal y como la hace `createTrade`, sin
 * levantar Firebase. Lo que se fija es la REGLA, que es donde estaba el error.
 */
function notificationTarget(
  flow: "cashout" | "deposit",
  sellerId: string,
  buyerId: string,
): { providerId: string; clientId: string } {
  // Misma derivacion que `deriveProviderId`: en cash-out el proveedor compra
  // el escrow; en deposito lo vende.
  const providerId = flow === "cashout" ? buyerId : sellerId;
  const clientId = providerId === sellerId ? buyerId : sellerId;
  return { providerId, clientId };
}

async function testCashoutNotifiesTheAgentNotTheClient() {
  const client = await createUser("cli");
  const agent = await createUser("agente");

  // Cash-out: el cliente vende su cripto, el agente la compra.
  const { providerId, clientId } = notificationTarget("cashout", client.id, agent.id);

  strictEqual(providerId, agent.id, "el aviso va al agente");
  strictEqual(clientId, client.id, "y nombra al cliente");

  // El fallo concreto: antes iba a `sellerId`, que aqui es el propio cliente.
  ok(providerId !== client.id, "el cliente NO recibe un aviso de su propia operacion");
  console.log("  ✓ en cash-out avisa al agente, no al cliente sobre si mismo");
}

async function testDepositNotifiesTheAgent() {
  const client = await createUser("cli2");
  const agent = await createUser("agente2");

  // Deposito: el agente vende cripto, el cliente la compra con efectivo.
  const { providerId, clientId } = notificationTarget("deposit", agent.id, client.id);

  strictEqual(providerId, agent.id, "el aviso va al agente");
  strictEqual(clientId, client.id, "y nombra al cliente");
  console.log("  ✓ en deposito tambien avisa al agente");
}

/**
 * El destinatario NO puede depender del rol del escrow, que se invierte entre
 * flujos. Depende de quien es el proveedor, que es siempre el que debe actuar.
 */
async function testTargetFollowsTheProviderNotTheEscrowRole() {
  const a = await createUser("a");
  const b = await createUser("b");

  const cashout = notificationTarget("cashout", a.id, b.id);
  const deposit = notificationTarget("deposit", b.id, a.id);

  // Con las partes en el mismo sitio del escrow, el destinatario cambia segun
  // el flujo: esa es exactamente la regla que el codigo viejo ignoraba.
  strictEqual(cashout.providerId, b.id);
  strictEqual(deposit.providerId, b.id);
  console.log("  ✓ el destinatario sigue al proveedor, no al rol del escrow");
}

async function testProviderHasSomewhereToReceiveIt() {
  const agent = await createUser("conttoken");
  const row = await db.getOne<{ push_token: string | null }>(
    "SELECT push_token FROM users WHERE id = $1",
    [agent.id],
  );
  ok(row?.push_token, "el destinatario tiene columna donde guardar su token");
  // Que la columna exista no significa que la app la llene: hoy no lo hace.
  // Ver el encabezado de este archivo.
  console.log("  ✓ existe donde guardar el token del dispositivo (la app aun no lo registra)");
}

/**
 * Los casos de arriba prueban la REGLA sobre una reimplementacion local. Eso no
 * basta: si alguien devuelve `sellerId` en `createTrade`, siguen en verde. Es el
 * tipo de test que da confianza sin comprobar nada.
 *
 * Este lee el codigo real. No es elegante, pero observar el destinatario de
 * verdad exige levantar Firebase, que hoy no existe; y una asercion de tipos no
 * vale porque estos tests corren sin comprobacion de tipos.
 */
async function testTheRealCodeTargetsTheProvider() {
  const source = readFileSync(
    resolve(dirname(fileURLToPath(import.meta.url)), "../services/trade.service.ts"),
    "utf8",
  );

  ok(
    /sendTradeNotificationToMerchant\(\s*providerId/.test(source),
    "createTrade debe avisar al proveedor",
  );
  ok(
    !/sendTradeNotificationToMerchant\(\s*sellerId/.test(source),
    "y NO al seller del escrow, que en cash-out es el propio cliente",
  );
  console.log("  ✓ el codigo real avisa al proveedor, no al seller");
}

async function main() {
  console.log("\n  Aviso de operacion nueva al proveedor:\n");
  await testCashoutNotifiesTheAgentNotTheClient();
  await testDepositNotifiesTheAgent();
  await testTargetFollowsTheProviderNotTheEscrowRole();
  await testProviderHasSomewhereToReceiveIt();
  await testTheRealCodeTargetsTheProvider();
  console.log("\nAll trade notification targeting tests passed.\n");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
