import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * APK-6 regression guard.
 *
 * Every <button> must expose an accessible name: either visible text, an
 * aria-label, or an sr-only span. An icon-only button with none of those is
 * announced as just "button" by TalkBack/VoiceOver, which is the bug this
 * suite exists to prevent from coming back.
 */

const SRC = join(__dirname, '..');
// Chat surfaces are owned by APK-5 and excluded until it merges.
const EXCLUDED = new Set(['ChatRoom.tsx', 'DepositChat.tsx']);

/** Normalize a path to forward slashes so comparisons work on Windows. */
function toPosix(p: string): string {
  return p.replace(/\\/g, '/');
}

function tsxFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return tsxFiles(full);
    return entry.endsWith('.tsx') && !EXCLUDED.has(entry) ? [full] : [];
  });
}

interface Button { file: string; line: number; openTag: string; inner: string }

/** Extract <button> elements with balanced nesting. */
function buttons(source: string, file: string): Button[] {
  const found: Button[] = [];
  let i = 0;
  while (true) {
    const start = source.indexOf('<button', i);
    if (start === -1) break;

    // End of the opening tag, ignoring '>' inside JSX expressions.
    let j = start;
    let depth = 0;
    while (j < source.length) {
      const c = source[j];
      if (c === '{') depth++;
      else if (c === '}') depth--;
      else if (c === '>' && depth === 0) break;
      j++;
    }
    const openTag = source.slice(start, j + 1);
    if (openTag.trimEnd().endsWith('/>')) { i = j + 1; continue; }

    // Matching </button>, accounting for nested buttons.
    let k = j + 1;
    let level = 1;
    let close = -1;
    while (k < source.length) {
      const next = source.indexOf('<button', k);
      const end = source.indexOf('</button>', k);
      if (end === -1) break;
      if (next !== -1 && next < end) { level++; k = next + 7; }
      else if (--level === 0) { close = end; break; }
      else k = end + 9;
    }

    found.push({
      file,
      line: source.slice(0, start).split('\n').length,
      openTag,
      inner: close === -1 ? '' : source.slice(j + 1, close),
    });
    i = close === -1 ? j + 1 : close + 9;
  }
  return found;
}

const ICON_SPAN = /<span[^>]*material-symbols[^>]*>[\s\S]*?<\/span>/g;

/** Does anything inside the button produce text a screen reader announces? */
function hasAccessibleText(inner: string): boolean {
  if (/sr-only/.test(inner)) return true;
  const withoutIcons = inner.replace(ICON_SPAN, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '');
  // A string literal inside an expression, e.g. {loading ? 'Saving…' : 'Save'}
  if (/\{[^{}]*?(?:'[^']{2,}'|"[^"]{2,}"|`[^`]{2,}`)[^{}]*?\}/.test(withoutIcons)) return true;
  if (/\bt\(/.test(withoutIcons)) return true;
  // A bare interpolated value, e.g. {buttonLabel}
  if (/\{\s*[A-Za-z_$][\w$.]*\s*\}/.test(withoutIcons)) return true;
  return withoutIcons.replace(/<[^>]+>/g, '').trim().length > 0;
}

describe('accessible names on buttons (APK-6)', () => {
  const all = tsxFiles(SRC).flatMap((f) =>
    buttons(readFileSync(f, 'utf-8'), toPosix(relative(SRC, f))),
  );

  it('finds buttons to check', () => {
    expect(all.length).toBeGreaterThan(100);
  });

  it('gives every button an accessible name', () => {
    const unnamed = all
      .filter((b) => !b.openTag.includes('aria-label') && !hasAccessibleText(b.inner))
      .map((b) => `${b.file}:${b.line}`);

    expect(unnamed).toEqual([]);
  });

  // The screens named by the issue's acceptance criteria: "a TalkBack pass over at
  // least Map, Profile, Pay and History". A Material Symbols glyph is a ligature, so
  // the span's text content is literally "arrow_upward". Inside a button that has no
  // aria-label, that text joins the accessible name and TalkBack reads it out before
  // the real label. aria-label wins over contents, so the buttons fixed above are
  // immune — these are the ones that carry visible text instead.
  const AC_SCREENS = [
    'pages/PayHub.tsx',
    'pages/Profile.tsx',
    'pages/History.tsx',
    'pages/DepositMap.tsx',
    'pages/ExploreMap.tsx',
  ];

  it('hides decorative icons from the name on the acceptance-criteria screens', () => {
    const on = all.filter((b) => AC_SCREENS.includes(b.file));
    // Guard against a silent pass: the comparison must actually match the
    // expected screens, otherwise this test checks nothing.
    expect(on.length).toBeGreaterThan(0);
    for (const screen of AC_SCREENS) {
      expect(on.some((b) => b.file === screen)).toBe(true);
    }

    const leaking = on
      .filter((b) => !b.openTag.includes('aria-label'))
      .filter((b) =>
        (b.inner.match(ICON_SPAN) ?? []).some((span) => !/aria-hidden/.test(span)),
      )
      .map((b) => `${b.file}:${b.line}`);

    expect(leaking).toEqual([]);
  });

  it('names the action rather than the icon', () => {
    // "arrow_back" as a label would read the glyph name aloud, not the action.
    const iconNamed = all
      .filter((b) => /aria-label=["'][a-z_]+["']/.test(b.openTag))
      .map((b) => `${b.file}:${b.line}`);

    expect(iconNamed).toEqual([]);
  });
});

describe('a11y translation keys', () => {
  const es = JSON.parse(readFileSync(join(SRC, 'i18n/es.json'), 'utf-8'));
  const en = JSON.parse(readFileSync(join(SRC, 'i18n/en.json'), 'utf-8'));

  it('resolves every a11y key referenced in JSX, in both locales', () => {
    const used = new Set<string>();
    for (const file of tsxFiles(SRC)) {
      for (const m of readFileSync(file, 'utf-8').matchAll(/t\(\s*'(a11y\.[\w.]+)'/g)) {
        used.add(m[1]);
      }
    }
    expect(used.size).toBeGreaterThan(0);

    const missing: string[] = [];
    for (const key of used) {
      const leaf = key.split('.')[1];
      if (!(leaf in (es.a11y ?? {}))) missing.push(`es:${key}`);
      if (!(leaf in (en.a11y ?? {}))) missing.push(`en:${key}`);
    }
    expect(missing).toEqual([]);
  });

  it('keeps the two locales in sync', () => {
    expect(Object.keys(es.a11y).sort()).toEqual(Object.keys(en.a11y).sort());
  });
});
