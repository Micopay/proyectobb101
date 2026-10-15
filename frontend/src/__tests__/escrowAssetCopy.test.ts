/**
 * WP-E · el flujo de operacion no afirma un activo que no es el del escrow.
 *
 * El escrow bloquea XLM, pero la app decia "bloqueo USDC", "tu USDC sera
 * reembolsado" o "Tus MXNE ya estan en tu billetera". Las tres pantallas con
 * USDC (TradeCancelled, CancelTradeDialog y components/TradeConfirmation) eran
 * codigo muerto y se eliminaron; "Tus MXNE" si se mostraba al terminar un
 * deposito.
 *
 * El activo real ahora llega de la operacion (`asset_code`, WP-D) o del
 * catalogo (WP-B), nunca escrito en el texto. Esta suite lo fija sobre lo que
 * de verdad se pinta:
 *   - las secciones i18n que usan las pantallas del flujo;
 *   - los literales de esas pantallas, SIN comentarios. Un grep sobre el
 *     archivo entero daria falsos positivos: hay comentarios tecnicos legitimos
 *     que explican por que se quito USDC.
 *
 * USDC y MXNe siguen siendo legitimos fuera del flujo (cartera, CETES, Blend,
 * ClaimQR) y en el catalogo `constants/escrowAssets.ts`, que no se revisan aqui.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = dirname(fileURLToPath(import.meta.url));
const read = (p: string) => readFileSync(resolve(dir, p), 'utf8');

const HARDCODED_ASSET = /\b(USDC|MXNe|MXNE)\b/;

/** Secciones i18n que usan las pantallas del flujo de operacion. */
const FLOW_SECTIONS = ['cashout', 'deposit', 'confirm', 'chatRoom', 'qrReveal', 'success', 'inbox', 'map', 'escrowAsset'];

/** Pantallas del flujo de operacion. */
const FLOW_FILES = [
  '../pages/CashoutRequest.tsx',
  '../pages/DepositRequest.tsx',
  '../pages/ExploreMap.tsx',
  '../pages/DepositMap.tsx',
  '../pages/TradeConfirmation.tsx',
  '../pages/ChatRoom.tsx',
  '../pages/DepositChat.tsx',
  '../pages/QRReveal.tsx',
  '../pages/DepositQR.tsx',
  '../pages/TradeDetail.tsx',
  '../pages/SuccessScreen.tsx',
  '../pages/MerchantInbox.tsx',
  '../components/MerchantOfferCard.tsx',
  '../components/AssetSelector.tsx',
  '../components/TradeEscrowSummary.tsx',
];

/** Quita comentarios de bloque, de JSX y de linea (sin tocar `https://`). */
export function stripComments(src: string): string {
  return src
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:"'`])\/\/.*$/gm, '$1');
}

function offendingStrings(value: unknown, path: string, out: string[] = []): string[] {
  if (typeof value === 'string') {
    if (HARDCODED_ASSET.test(value)) out.push(`${path}: ${value}`);
  } else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) offendingStrings(v, `${path}.${k}`, out);
  }
  return out;
}

describe('i18n del flujo de operacion', () => {
  it.each(['es', 'en'])('%s: ninguna seccion del flujo nombra USDC o MXNe', (lang) => {
    const dict = JSON.parse(read(`../i18n/${lang}.json`));
    const offending = FLOW_SECTIONS.flatMap((section) => {
      expect(dict[section], `seccion ${section} en ${lang}`).toBeDefined();
      return offendingStrings(dict[section], section);
    });
    expect(offending).toEqual([]);
  });
});

describe('pantallas del flujo de operacion', () => {
  it.each(FLOW_FILES)('%s no escribe USDC/MXNe fuera de comentarios', (file) => {
    const lines = stripComments(read(file))
      .split('\n')
      .filter((line) => HARDCODED_ASSET.test(line))
      .map((line) => line.trim());
    expect(lines).toEqual([]);
  });

  it('stripComments no borra codigo real', () => {
    const src = `const a = "USDC"; // USDC en comentario\n/* MXNe */\n{/* MXNE */}\nconst url = "https://x";`;
    const out = stripComments(src);
    expect(out).toContain('const a = "USDC";');
    expect(out).toContain('https://x');
    expect(out).not.toContain('MXNe');
    expect(out).not.toContain('MXNE');
  });
});
