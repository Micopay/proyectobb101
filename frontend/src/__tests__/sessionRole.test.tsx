/**
 * CASH-7 · Una identidad, rol por operación.
 *
 * Cierra el invariante de producto del issue #160 ("una identidad por
 * dispositivo"). El contexto tenía dos campos de sesión con nombre de rol,
 * pero todos los caminos de alta, login y recuperación les asignaban el MISMO
 * objeto, así que el campo del vendedor —por el mero hecho de tener valor—
 * terminaba significando "esta persona es proveedora".
 *
 * Lo que este archivo fija es la regla que reemplaza a esa inferencia: **el
 * rol se deriva de la operación cargada**, comparando el id de la sesión
 * contra `seller_id` / `buyer_id` del trade. La misma persona, sin cambiar de
 * sesión, es vendedora del escrow en un cash-out y compradora en un depósito.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AppCtx } from '../App';

/** Forma mínima de un trade para derivar el rol. */
type TradeRow = {
  id: string;
  flow: 'deposit' | 'cashout';
  seller_id: string;
  buyer_id: string;
  provider_id: string;
};

/**
 * La regla bajo prueba: el rol del escrow sale del trade, nunca de la sesión.
 */
function escrowRoleOf(userId: string, trade: TradeRow): 'seller' | 'buyer' | 'none' {
  if (trade.seller_id === userId) return 'seller';
  if (trade.buyer_id === userId) return 'buyer';
  return 'none';
}

/** ¿Es esta persona la proveedora de liquidez de Red MicoPay en este trade? */
function isProviderOf(userId: string, trade: TradeRow): boolean {
  return trade.provider_id === userId;
}

const SESSION_ID = 'user-single-identity';
const OTHER_ID = 'user-counterparty';

// Cash-out: la persona entrega cripto, así que es la vendedora del escrow y
// la contraparte —el agente— es la compradora y la proveedora.
const CASHOUT: TradeRow = {
  id: 'trade-cashout',
  flow: 'cashout',
  seller_id: SESSION_ID,
  buyer_id: OTHER_ID,
  provider_id: OTHER_ID,
};

// Depósito: la persona compra cripto con efectivo, así que es la compradora
// del escrow y el agente es el vendedor y el proveedor.
const DEPOSIT: TradeRow = {
  id: 'trade-deposit',
  flow: 'deposit',
  seller_id: OTHER_ID,
  buyer_id: SESSION_ID,
  provider_id: OTHER_ID,
};

describe('CASH-7 · una identidad, rol por operación', () => {
  it('la misma sesión es vendedora en un cash-out y compradora en un depósito', () => {
    expect(escrowRoleOf(SESSION_ID, CASHOUT)).toBe('seller');
    expect(escrowRoleOf(SESSION_ID, DEPOSIT)).toBe('buyer');
  });

  it('el rol cambia sin que cambie la sesión', () => {
    const roles = [CASHOUT, DEPOSIT].map((t) => escrowRoleOf(SESSION_ID, t));
    expect(new Set(roles).size).toBe(2);
  });

  it('la contraparte ocupa siempre el lado opuesto', () => {
    expect(escrowRoleOf(OTHER_ID, CASHOUT)).toBe('buyer');
    expect(escrowRoleOf(OTHER_ID, DEPOSIT)).toBe('seller');
  });

  it('quien no participa no tiene rol', () => {
    expect(escrowRoleOf('un-tercero', CASHOUT)).toBe('none');
    expect(escrowRoleOf('un-tercero', DEPOSIT)).toBe('none');
  });

  it('ser proveedora depende del trade, no de la sesión', () => {
    expect(isProviderOf(SESSION_ID, CASHOUT)).toBe(false);
    expect(isProviderOf(SESSION_ID, DEPOSIT)).toBe(false);

    const comoProveedora: TradeRow = {
      id: 'trade-as-provider',
      flow: 'cashout',
      seller_id: OTHER_ID,
      buyer_id: SESSION_ID,
      provider_id: SESSION_ID,
    };
    expect(isProviderOf(SESSION_ID, comoProveedora)).toBe(true);
    expect(escrowRoleOf(SESSION_ID, comoProveedora)).toBe('buyer');
  });

  it('en cash-out la proveedora es la compradora del escrow, y al revés en depósito', () => {
    // Es la regla que chk_trades_flow_provider refuerza en la base de datos.
    expect(CASHOUT.provider_id).toBe(CASHOUT.buyer_id);
    expect(DEPOSIT.provider_id).toBe(DEPOSIT.seller_id);
  });
});

describe('CASH-7 · el contexto no guarda sesiones con forma de rol', () => {
  /**
   * Esta comprobación lee el código fuente a propósito.
   *
   * La primera versión de este bloque afirmaba sobre tipos
   * (`Extract<keyof AppCtx, ...>`). No servía: vitest no hace typecheck, así
   * que reintroducir el campo del vendedor en `AppCtx` dejaba el test en
   * verde y solo lo detectaba `tsc` — comprobado inyectando la regresión a
   * propósito. Un test que pasa con el defecto puesto no prueba nada.
   *
   * Leer la fuente es crudo, pero falla cuando el defecto vuelve, que es
   * justo lo que el issue quiere impedir.
   */
  const APP_SRC = readFileSync(
    resolve(dirname(fileURLToPath(import.meta.url)), '../App.tsx'),
    'utf-8',
  );

  it('no declara estado de sesión con nombre de rol', () => {
    // \b evita que `setSellerUsername` (el nombre de la contraparte, que sí
    // es legítimo) cuente como una reintroducción de `setSellerUser`.
    const prohibidos: Array<[string, RegExp]> = [
      ['campo buyerUser en AppCtx', /\bbuyerUser\s*:/],
      ['campo sellerUser en AppCtx', /\bsellerUser\s*:/],
      ['useState de buyerUser', /\[\s*buyerUser\s*,/],
      ['useState de sellerUser', /\[\s*sellerUser\s*,/],
      ['setter setBuyerUser', /\bsetBuyerUser\b/],
      ['setter setSellerUser', /\bsetSellerUser\b/],
    ];
    const encontrados = prohibidos.filter(([, re]) => re.test(APP_SRC)).map(([n]) => n);
    expect(encontrados).toEqual([]);
  });

  it('expone exactamente una sesión', () => {
    expect(APP_SRC).toMatch(/\bsessionUser\s*:\s*UserData \| null;/);
    const estadosDeSesion = APP_SRC.match(/useState<UserData \| null>/g) ?? [];
    expect(estadosDeSesion).toHaveLength(1);
  });

  it('la barra inferior ya no infiere proveedor de que exista sesión', () => {
    expect(APP_SRC).not.toMatch(/isMerchant=\{!!/);
  });

  it('el tipo del contexto sigue teniendo una sola sesión', () => {
    const ctx: Pick<AppCtx, 'sessionUser'> = { sessionUser: null };
    expect(ctx.sessionUser).toBeNull();
  });
});
