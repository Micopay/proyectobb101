/**
 * Confirmar ES autorizar: el bloqueo sale en el mismo gesto.
 *
 * EL FALLO (reportado desde el APK el 2026-09-05)
 * -----------------------------------------------
 * El escrow "se quedaba en espera". No era el escrow: la operacion se creaba y
 * el bloqueo NO se disparaba. Comprobado en los registros del servidor — la
 * operacion `b8d0bc25` se creo a las 14:35:30 y desde entonces la app solo
 * consultaba su estado, sin una sola llamada a `/lock/prepare`.
 *
 * El bloqueo vivia escondido detras de "Ver mi QR de operacion", en otra
 * pantalla. Mientras tanto el chat mostraba "Estamos bloqueando tu saldo en
 * cadena, espera la confirmacion antes de moverte" con NADA en marcha. La
 * persona esperaba indefinidamente algo que nadie habia empezado.
 *
 * Dos cosas mal a la vez, y la segunda es la peor: la app afirmaba estar
 * haciendo algo que no hacia. Un estado que miente es peor que un error.
 *
 * Este archivo lee la fuente en vez de montar App entero. Es deliberado: lo que
 * se fija es DONDE vive el disparo del bloqueo, y eso es exactamente lo que se
 * movio. Montar el arbol completo probaria el resultado, no la decision.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');

describe('el bloqueo se dispara al confirmar', () => {
  const app = read('src/App.tsx');

  it('`runTradeFlow` bloquea justo despues de crear la operación', () => {
    const flow = app.slice(app.indexOf('const runTradeFlow'), app.indexOf('const retryTradeFlow'));
    expect(flow).toContain('createTrade(');
    expect(flow, 'el bloqueo debe ocurrir en el mismo gesto que la confirmación').toContain(
      'lockTrade(',
    );
    // Y en ese orden: no se puede bloquear una operación que no existe.
    expect(flow.indexOf('createTrade(')).toBeLessThan(flow.indexOf('lockTrade('));
  });

  it('solo en cash-out, que es cuando el dinero es de quien confirma', () => {
    const flow = app.slice(app.indexOf('const runTradeFlow'), app.indexOf('const retryTradeFlow'));
    // En depósito bloquea el agente, no el cliente: disparar el bloqueo ahí
    // pediría la huella para mover un dinero que no es suyo.
    expect(flow).toMatch(/tradeFlow === 'cashout'/);
  });

  it('si el bloqueo falla no se descarta la operación en silencio', () => {
    const flow = app.slice(app.indexOf('const runTradeFlow'), app.indexOf('const retryTradeFlow'));
    // La operación ya existe en el servidor y el agente la está viendo.
    // Tragarse el error dejaría una operación huérfana y a alguien esperando.
    expect(flow).toMatch(/catch\s*\(lockErr\)/);
    expect(flow).toContain('setTradeError(mapApiError(lockErr))');
  });
});

describe('la pantalla no afirma lo que no está pasando', () => {
  it('el cartel de `pending` ya no dice que se esté bloqueando algo', () => {
    const es = JSON.parse(read('src/i18n/es.json'));
    const desc: string = es.chatRoom.cashoutClientPendingDesc;
    // La frase original —"Estamos bloqueando tu saldo en cadena. Espera la
    // confirmación"— se mostraba sin que hubiera ninguna petición en vuelo.
    expect(desc).not.toMatch(/estamos bloqueando/i);
    expect(desc).not.toMatch(/espera la confirmaci/i);
    // Y dice qué hacer, en vez de pedir que se espere sin más.
    expect(desc).toMatch(/reintent/i);
  });
});

describe('el activo del escrow', () => {
  /**
   * El escrow desplegado bloquea XLM: su `TokenId` es el Stellar Asset Contract
   * del nativo, verificado en cadena. Pedir la trustline de USDC creaba la de
   * un activo que el escrow no usa — el mismo error que el diagnostico de julio
   * dejo abierto.
   */
  it('no vuelve a pedir la trustline de USDC por defecto', () => {
    for (const file of ['src/pages/QRReveal.tsx', 'src/pages/TradeDetail.tsx']) {
      expect(read(file), `${file} no debe usar USDC como activo del escrow`).not.toMatch(
        /VITE_ESCROW_ASSET_CODE \|\| 'USDC'/,
      );
    }
  });

  /**
   * H3: el activo del bloqueo sale de la operacion y el cliente no envia un
   * ChangeTrust antes de pedirlo. Con la configuracion del APK como fuente, un
   * valor discordante firmaba una transaccion innecesaria antes de que el
   * guard del backend pudiera intervenir.
   */
  it('las pantallas de bloqueo no crean trustline ni leen el activo de la configuración', () => {
    for (const file of ['src/pages/QRReveal.tsx', 'src/pages/TradeDetail.tsx']) {
      const src = read(file);
      expect(src, file).not.toContain('ensureTrustline');
      expect(src, file).not.toContain('VITE_ESCROW_ASSET_CODE');
      expect(src, file).toContain('assertNoClientPreparationForLock(');
      expect(src.indexOf('assertNoClientPreparationForLock('), file).toBeLessThan(src.indexOf('await lockTrade('));
    }
  });

  it('está declarado explícitamente en el entorno de testnet', () => {
    // Heredarlo de `.env` en silencio fue como se coló el USDC. Hoy testnet
    // tiene escrow de USDC y de XLM (contracts/TESTNET.md), y los dos se
    // declaran a la vista, junto con el emisor del USDC de pruebas.
    const env = read('.env.testnet');
    expect(env).toMatch(/^VITE_ESCROW_ASSET_CODE=USDC$/m);
    expect(env).toMatch(/^VITE_ESCROW_ASSETS=USDC,XLM$/m);
    expect(env).toMatch(/^VITE_USDC_ISSUER=GADK7SUS7NHIGERQBKF7R67A5DNIEFWG4YKNHLTQM5JN4KP2QISMJSHG$/m);
  });
});

describe('el estado local no se queda atrás tras bloquear', () => {
  const api = read('src/services/api.ts');

  /**
   * `lockTrade` devolvia solo `{ lock_tx_hash }` y tiraba el `status` que el
   * backend si manda. El estado local se quedaba en `pending` despues de un
   * bloqueo EXITOSO, y la pantalla del QR volvia a intentar bloquear: el
   * servidor respondia 409 y la app lo traducia a "otra persona movio esta
   * operacion antes que tu" — hablando de un conflicto entre personas donde
   * solo habia estado desactualizado.
   */
  it('`lockTrade` propaga el estado que devuelve el servidor', () => {
    const fn = api.slice(api.indexOf('export async function lockTrade'), api.indexOf('export async function revealTrade'));
    expect(fn).toContain('status: res.data.status');
  });

  it('la pantalla del QR pregunta al servidor antes de intentar bloquear', () => {
    const qr = read('src/pages/QRReveal.tsx');
    const load = qr.slice(qr.indexOf('const loadSecret'), qr.indexOf('const loadSecret') + 2000);
    // Decidir con el estado local es lo que rompio: se consulta el real.
    expect(load).toContain('await getTrade(');
    expect(load.indexOf('await getTrade(')).toBeLessThan(load.indexOf('await lockTrade('));
  });
});
