/**
 * CASH-5A · Un solo contrato de estados entre base de datos, API y UI.
 *
 * Seguimiento correctivo del issue cerrado #19.
 *
 * El contrato del frontend inventaba `pending_cash` y `revealed` —que ningún
 * backend emite— y omitía `pending` y `revealing`, que sí ocurren. El efecto
 * era que un estado real caía en la vista de respaldo y la pantalla mostraba
 * una etiqueta que no correspondía; peor, un estado desconocido se rotulaba
 * como "Pendiente", que sí habilita acciones.
 *
 * La fuente autoritativa es el CHECK de `trades.status` en
 * `micopay/sql/init.sql`. Este archivo verifica contra ella, leyendo el SQL,
 * para que el contrato no pueda separarse de la base sin que algo falle.
 */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import TradeStateBadge, {
  TRADE_STATE_COPY,
  TRADE_STATES,
  parseTradeState,
  normalizeTradeState,
  isTradeState,
  type TradeState,
} from '../components/TradeStateBadge';

const HERE = dirname(fileURLToPath(import.meta.url));

/** Los estados que la base de datos realmente permite. */
function statesFromSchema(): string[] {
  const sql = readFileSync(resolve(HERE, '../../../sql/init.sql'), 'utf-8');
  const check = sql.match(/status\s+VARCHAR\(\d+\)[\s\S]*?CHECK \(status IN \(([\s\S]*?)\)\)/);
  if (!check) throw new Error('No se encontró el CHECK de trades.status en init.sql');
  return [...check[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
}

describe('CASH-5A · el contrato coincide con la base de datos', () => {
  it('cubre exactamente los estados persistidos, sin inventar ninguno', () => {
    expect([...TRADE_STATES].sort()).toEqual(statesFromSchema().sort());
  });

  it('no conserva los estados inventados', () => {
    expect(TRADE_STATES).not.toContain('pending_cash' as never);
    expect(TRADE_STATES).not.toContain('revealed' as never);
  });

  it('incluye los dos que faltaban', () => {
    expect(TRADE_STATES).toContain('pending');
    expect(TRADE_STATES).toContain('revealing');
  });
});

describe('CASH-5A · parseo', () => {
  it('acepta cada estado canónico', () => {
    for (const state of TRADE_STATES) {
      expect(parseTradeState(state)).toBe(state);
      expect(isTradeState(state)).toBe(true);
    }
  });

  it('devuelve null ante un estado desconocido, en vez de inventar uno', () => {
    for (const bogus of ['pending_cash', 'revealed', 'settled', '', 'PENDING']) {
      expect(parseTradeState(bogus)).toBeNull();
    }
    expect(parseTradeState(null)).toBeNull();
    expect(parseTradeState(undefined)).toBeNull();
  });

  it('normalizeTradeState sigue dando un respaldo explícito cuando se pide', () => {
    expect(normalizeTradeState('revealing', 'locked')).toBe('revealing');
    expect(normalizeTradeState('lo-que-sea', 'locked')).toBe('locked');
  });
});

describe('CASH-5A · presentación', () => {
  it.each([...TRADE_STATES])('%s tiene una etiqueta deliberada', (state: TradeState) => {
    render(<TradeStateBadge state={state} />);
    // Ninguno cae en la tarjeta de estado desconocido.
    expect(screen.queryByTestId('trade-state-unknown')).toBeNull();
  });

  it('pending y revealing dejaron de caer en un respaldo', () => {
    for (const state of ['pending', 'revealing'] as TradeState[]) {
      const { unmount } = render(<TradeStateBadge state={state} />);
      expect(screen.queryByTestId('trade-state-unknown')).toBeNull();
      unmount();
    }
  });

  it('un estado desconocido se muestra y no ofrece ninguna acción', () => {
    const onRecover = () => {
      throw new Error('un estado desconocido no debe poder desbloquear una acción');
    };
    render(<TradeStateBadge state="algo_que_no_existe" onRecover={onRecover} />);

    expect(screen.getByTestId('trade-state-unknown')).toBeTruthy();
    expect(screen.getByText(/algo_que_no_existe/)).toBeTruthy();
    // La acción de recuperación existe para expired/cancelled/refunded; un
    // estado fuera del contrato no puede alcanzarla.
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('los estados recuperables sí ofrecen su acción', () => {
    for (const state of ['expired', 'cancelled', 'refunded'] as TradeState[]) {
      const { unmount } = render(<TradeStateBadge state={state} onRecover={() => {}} />);
      expect(screen.queryByRole('button')).not.toBeNull();
      unmount();
    }
  });
});

describe('CASH-5A · la UI no reintroduce estados inventados', () => {
  /**
   * Lee el archivo SIN comentarios. Sin esto la comprobación se dispara con
   * la prosa que describe el defecto —los comentarios que explican qué se
   * quitó contienen el patrón— y no con el código, que es lo que importa.
   */
  const read = (rel: string) =>
    readFileSync(resolve(HERE, rel), 'utf-8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');

  it('QRReveal no convierte revealing en revealed', () => {
    const src = read('../pages/QRReveal.tsx');
    expect(src).not.toMatch(/'revealed'/);
  });

  it('las pantallas de solicitud no usan pending_cash', () => {
    for (const page of ['../pages/CashoutRequest.tsx', '../pages/DepositRequest.tsx']) {
      expect(read(page)).not.toMatch(/pending_cash/);
    }
  });

  it('TradeDetail no rotula un estado desconocido como pendiente', () => {
    const src = read('../pages/TradeDetail.tsx');
    expect(src).not.toMatch(/STATUS_CONFIG\[status\]\s*\|\|\s*STATUS_CONFIG\.pending/);
  });
});

/**
 * El chat mostraba "Operación: revealing" —el identificador interno del
 * sistema— porque solo tenía redacción para `locked` y `pending`, y todo lo
 * demás caía a un texto plantilla con el estado crudo dentro.
 *
 * Los textos humanos YA existían en `TRADE_STATE_COPY` desde CASH-5A, pero solo
 * los usaba la insignia. Dos listas paralelas garantizan que una se quede atrás,
 * y la que se quedó atrás fue la que ve el usuario en mitad de una operación con
 * su dinero dentro.
 */
describe('el chat no enseña identificadores internos', () => {
  const source = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../pages/ChatRoom.tsx'), 'utf8');

  it('usa el diccionario compartido en vez de la plantilla con el estado crudo', () => {
    expect(source).toContain('TRADE_STATE_COPY');
    // `chatRoom.tradeStatus` es la plantilla "Operación: {{status}}".
    expect(source).not.toContain("t('chatRoom.tradeStatus'");
  });

  it('todos los estados canónicos tienen redacción humana', () => {
    for (const state of TRADE_STATES) {
      const copy = TRADE_STATE_COPY[state];
      expect(copy?.label, `falta la etiqueta de "${state}"`).toBeTruthy();
      // Ninguna debe ser el identificador tal cual.
      expect(copy.label.toLowerCase()).not.toBe(state);
    }
  });
});

/**
 * Las pantallas de monto pintaban la insignia de estado con `pending` fijado a
 * mano, DOS PANTALLAS antes de confirmar. Decia "Operación creada · la solicitud
 * se registró" —en pasado— cuando no existía ninguna operación: aún no se elige
 * agente ni se confirma nada.
 *
 * Es la misma clase de fallo que el cartel de "estamos bloqueando tu saldo": la
 * interfaz afirmando un hecho que no ocurrió. En una app de dinero eso no es un
 * detalle de copy — es decirle a alguien que su solicitud existe cuando no.
 */
describe('no se anuncia una operación que no existe', () => {
  const dir = dirname(fileURLToPath(import.meta.url));

  for (const screen of ['CashoutRequest', 'DepositRequest']) {
    it(`${screen} no pinta la insignia de estado`, () => {
      const source = readFileSync(resolve(dir, `../pages/${screen}.tsx`), 'utf8');
      expect(source).not.toContain('<TradeStateBadge');
      // Y no fija un estado a mano: no hay operación de la que hablar.
      expect(source).not.toContain("getTradeStateDebugOverride('pending')");
    });
  }

  it('el estado `pending` sigue describiendo algo ya creado', () => {
    // El texto no estaba mal: estaba en la pantalla equivocada. Sigue siendo el
    // correcto cuando la operación SÍ existe, así que no se toca.
    expect(TRADE_STATE_COPY.pending.happened).toMatch(/se registró/i);
  });
});
