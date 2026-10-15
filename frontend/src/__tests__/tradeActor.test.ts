/**
 * CASH-5B · El papel es de la operación, no de la sesión.
 *
 * Seguimiento correctivo del issue cerrado #18.
 *
 * El papel en el escrow se invierte entre los dos flujos, así que no se puede
 * leer de `seller_id` a secas, y tampoco de un rol global de la app —eso lo
 * cerró CASH-7—. Lo único constante es que **quien libera es siempre el
 * comprador del escrow**, porque el contrato exige su firma y la cripto se le
 * entrega a él.
 *
 * Esta es la tabla que el issue pide cubrir:
 *
 *   cash-out + cliente   -> vendedor del escrow  -> muestra su código, espera
 *   cash-out + proveedor -> comprador del escrow -> escanea y libera
 *   depósito + cliente   -> comprador del escrow -> confirma y libera
 *   depósito + proveedor -> vendedor del escrow  -> espera
 */

import { describe, it, expect } from 'vitest';
import { resolveTradeActor } from '../utils/tradeActor';

const CLIENT = 'user-client';
const PROVIDER = 'user-provider';
const STRANGER = 'user-stranger';

// Cash-out: el cliente entrega cripto (vendedor), el proveedor entrega
// efectivo y recibe la cripto (comprador).
const CASHOUT = {
  flow: 'cashout' as const,
  seller_id: CLIENT,
  buyer_id: PROVIDER,
  provider_id: PROVIDER,
};

// Depósito: el proveedor entrega cripto (vendedor), el cliente entrega
// efectivo y recibe la cripto (comprador).
const DEPOSIT = {
  flow: 'deposit' as const,
  seller_id: PROVIDER,
  buyer_id: CLIENT,
  provider_id: PROVIDER,
};

describe('CASH-5B · las cuatro combinaciones', () => {
  it('cash-out + cliente: vendedor del escrow, no libera', () => {
    const actor = resolveTradeActor(CLIENT, CASHOUT);
    expect(actor).toMatchObject({ party: 'client', escrowRole: 'seller', flow: 'cashout' });
    expect(actor.canRelease).toBe(false);
  });

  it('cash-out + proveedor: comprador del escrow, libera', () => {
    const actor = resolveTradeActor(PROVIDER, CASHOUT);
    expect(actor).toMatchObject({ party: 'provider', escrowRole: 'buyer', flow: 'cashout' });
    expect(actor.canRelease).toBe(true);
  });

  it('depósito + cliente: comprador del escrow, libera', () => {
    const actor = resolveTradeActor(CLIENT, DEPOSIT);
    expect(actor).toMatchObject({ party: 'client', escrowRole: 'buyer', flow: 'deposit' });
    expect(actor.canRelease).toBe(true);
  });

  it('depósito + proveedor: vendedor del escrow, no libera', () => {
    const actor = resolveTradeActor(PROVIDER, DEPOSIT);
    expect(actor).toMatchObject({ party: 'provider', escrowRole: 'seller', flow: 'deposit' });
    expect(actor.canRelease).toBe(false);
  });
});

describe('CASH-5B · el papel se invierte sin que cambie la sesión', () => {
  it('la misma persona es vendedora en cash-out y compradora en depósito', () => {
    expect(resolveTradeActor(CLIENT, CASHOUT).escrowRole).toBe('seller');
    expect(resolveTradeActor(CLIENT, DEPOSIT).escrowRole).toBe('buyer');
  });

  it('y es cliente en una operación y proveedora en otra', () => {
    const comoProveedora = {
      flow: 'cashout' as const,
      seller_id: STRANGER,
      buyer_id: CLIENT,
      provider_id: CLIENT,
    };
    expect(resolveTradeActor(CLIENT, CASHOUT).party).toBe('client');
    expect(resolveTradeActor(CLIENT, comoProveedora).party).toBe('provider');
  });

  it('liberar depende del flujo, no de ser proveedora', () => {
    // El proveedor libera en cash-out pero NO en depósito. Un rol global
    // habría dado la misma respuesta en los dos.
    expect(resolveTradeActor(PROVIDER, CASHOUT).canRelease).toBe(true);
    expect(resolveTradeActor(PROVIDER, DEPOSIT).canRelease).toBe(false);
  });
});

describe('CASH-5B · nadie ajeno obtiene una acción', () => {
  it('un tercero no tiene papel ni puede liberar', () => {
    for (const trade of [CASHOUT, DEPOSIT]) {
      const actor = resolveTradeActor(STRANGER, trade);
      expect(actor.party).toBe('observer');
      expect(actor.escrowRole).toBe('none');
      expect(actor.canRelease).toBe(false);
    }
  });

  it('sin sesión tampoco', () => {
    for (const id of [null, undefined, '']) {
      const actor = resolveTradeActor(id, CASHOUT);
      expect(actor.escrowRole).toBe('none');
      expect(actor.canRelease).toBe(false);
    }
  });

  it('sin provider_id no se adivina quién es el proveedor', () => {
    // Antes de CASH-1 no existía la columna. Preferimos no atribuir a
    // inventarlo desde los roles del escrow, que es el error original.
    const sinProveedor = { flow: 'cashout' as const, seller_id: CLIENT, buyer_id: PROVIDER };
    const actor = resolveTradeActor(CLIENT, sinProveedor);
    expect(actor.party).toBe('observer');
    expect(actor.escrowRole).toBe('seller');
  });
});
