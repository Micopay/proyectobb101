/**
 * Todo icono que la app use tiene que estar en la fuente empaquetada.
 *
 * Los Material Symbols se escriben como TEXTO y la fuente los convierte en
 * dibujo con una ligadura. Si el icono no esta en el subconjunto local, el
 * navegador pinta el nombre crudo, en el tamaño del icono, desbordando su
 * recuadro.
 *
 * Ha pasado tres veces, siempre por lo mismo — el subconjunto se mantuvo a mano:
 *
 *   1. La fuente venia del CDN de Google; sin señal, todos los usos salian como
 *      palabras. Se arreglo empaquetandola en local.
 *   2. Ese subconjunto se genero UNA vez y nadie lo regenero. Doce iconos rotos,
 *      entre ellos `screenshot_monitor` sobre la pantalla de respaldo de la llave.
 *   3. Al arreglar el (2) se intento reconocer las formas SINTACTICAS en que el
 *      codigo escribe un icono, y se dejaron fuera los que BottomNav pasa como
 *      argumento — `btn('home', 'home', ...)`. La barra de navegacion acabo
 *      mostrando HOME y EXPLORE como texto gigante.
 *
 * La leccion del (3) es la que gobierna este archivo: **no se adivina la forma
 * sintactica**. Se toma cualquier literal en minusculas del codigo, se cruza con
 * la lista de nombres REALES de Material Symbols, y lo que resulte tiene que
 * estar empaquetado. Empaquetar de mas cuesta unos kilobytes; empaquetar de
 * menos rompe la pantalla.
 *
 * Si este test falla, la solucion es una sola orden:
 *
 *     python scripts/build-icon-subset.py
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** Literal entrecomillado: `btn('home', ...)`, `icon: 'lock'`, `icon="x"`. */
const QUOTED = /['"`]([a-z][a-z0-9_]{2,40})['"`]/g;
/** Texto JSX sin comillas: `<span className="material-symbols-outlined">arrow_back</span>`. */
const BARE = /material-symbols-outlined[^>]*>\s*([a-z][a-z0-9_]{2,40})\s*</g;

function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry !== '__tests__') sourceFiles(full, acc);
    } else if (/\.tsx?$/.test(entry)) {
      acc.push(full);
    }
  }
  return acc;
}

/** Todo lo que podria ser un nombre de icono, con el fichero donde aparece. */
function candidates(): Map<string, string> {
  const found = new Map<string, string>();
  for (const file of sourceFiles(join(process.cwd(), 'src'))) {
    const src = readFileSync(file, 'utf8');
    const rel = file.replace(process.cwd(), '').replace(/\\/g, '/');
    for (const re of [QUOTED, BARE]) {
      for (const m of src.matchAll(re)) {
        if (!found.has(m[1])) found.set(m[1], rel);
      }
    }
  }
  return found;
}

function lines(path: string): Set<string> {
  return new Set(
    readFileSync(join(process.cwd(), path), 'utf8')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#')),
  );
}

/** Los 4277 nombres reales de Material Symbols, generados por el script. */
const validIconNames = () => lines('scripts/material-symbols-names.txt');
/** Los que la fuente empaquetada contiene de verdad. */
const packaged = () => lines('public/fonts/ICONOS.txt');

describe('el subconjunto de iconos empaquetado', () => {
  it('contiene todos los iconos que el código usa', () => {
    const valid = validIconNames();
    const inFont = packaged();

    // Un literal solo cuenta como icono si Material Symbols lo reconoce. Asi
    // `cashout` o `locked` —valores de condicion, no iconos— se descartan sin
    // necesidad de una lista de excepciones que envejezca.
    const missing = [...candidates().entries()]
      .filter(([name]) => valid.has(name) && !inFont.has(name))
      .map(([name, file]) => `${name}  (${file})`);

    expect(
      missing,
      'Estos iconos se renderizarán como TEXTO CRUDO sobre la pantalla.\n' +
        'Solución: python scripts/build-icon-subset.py\n\n' +
        missing.join('\n'),
    ).toEqual([]);
  });

  it('cubre los iconos de la barra de navegación', () => {
    // Caso concreto del fallo (3): BottomNav los pasa como argumentos, no como
    // texto JSX ni como prop. Se fijan por nombre para que no vuelva a colarse.
    const inFont = packaged();
    for (const icon of ['home', 'swap_horiz', 'inbox', 'savings', 'explore', 'person']) {
      expect(inFont.has(icon), `la barra inferior usa "${icon}"`).toBe(true);
    }
  });

  it('el extractor sigue viendo las dos formas de escribir un icono', () => {
    // Guarda sobre el propio extractor: si un cambio lo rompe, dejaria de ver
    // iconos y el primer test pasaria en verde sin comprobar nada. Ya ocurrio,
    // con un `\b` convertido en carácter de retroceso que anuló el patrón.
    const found = candidates();
    expect(found.size).toBeGreaterThan(200);
    expect(found.has('arrow_back')).toBe(true); // texto JSX sin comillas
    expect(found.has('home')).toBe(true); // argumento entrecomillado
  });

  it('la lista de nombres válidos es la de Material Symbols, no un resumen', () => {
    // Si se truncara, el primer test dejaria de reconocer iconos como iconos y
    // volveria a pasar en verde con la pantalla rota.
    expect(validIconNames().size).toBeGreaterThan(3000);
  });
});
