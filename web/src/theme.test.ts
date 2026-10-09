import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// ?raw rather than node:fs on purpose: web/tsconfig.app.json declares only
// vite/client types, so a node import here typechecks nowhere and breaks the
// build while the suite stays green — which has happened before.
import appCss from './App.css?raw';
import indexCss from './index.css?raw';
import { applyTheme, resolveTheme, setTheme, storedTheme, THEME_KEY } from './theme';

function tokensIn(selector: string): Record<string, string> {
  const start = indexCss.indexOf(selector);
  if (start === -1) throw new Error(`no ${selector} block in index.css`);
  const open = indexCss.indexOf('{', start);
  const close = indexCss.indexOf('\n}', open);
  const block = indexCss.slice(open, close);
  const out: Record<string, string> = {};
  for (const [, name, value] of block.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) out[name] = value.trim();
  return out;
}

const DARK = tokensIn(':root {');
const LIGHT = tokensIn(":root[data-theme='light']");

function channels(hex: string): [number, number, number] {
  const h = hex.replace('#', '').slice(0, 6);
  const full = h.length === 3 ? [...h].map((c) => c + c).join('') : h;
  return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16)) as [number, number, number];
}

function luminance(hex: string): number {
  const [r, g, b] = channels(hex).map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * Every pair where one token is read against another. 4.5:1 is WCAG AA for
 * body text, and a TO reads this on a phone at a bracket table — often
 * outdoors, which is the whole reason the light palette exists.
 */
const PAIRS: [string, string][] = [
  ['--text', '--bg'],
  ['--text', '--surface'],
  ['--text', '--surface-raised'],
  ['--text-soft', '--surface'],
  ['--text-muted', '--surface'],
  ['--text-muted', '--bg'],
  ['--text-dim', '--surface'],
  ['--text-dim', '--bg'],
  ['--accent-fg', '--surface'],
  ['--success-fg', '--surface'],
  ['--danger-fg', '--surface'],
  ['--on-success', '--success'],
  ['--on-danger', '--danger'],
  ['--on-accent', '--accent'],
  ['--accent-text', '--accent-surface'],
  ['--danger-text', '--danger-surface'],
  ['--warn-text', '--warn-surface'],
];

describe('the palette', () => {
  it('defines the same tokens in both themes', () => {
    // The likeliest future break: a token added to one block and forgotten in
    // the other, which falls back to the dark value on a white page.
    expect(Object.keys(LIGHT).sort()).toEqual(Object.keys(DARK).sort());
  });

  it.each(PAIRS)('reads %s on %s in both themes', (fg, bg) => {
    for (const [name, theme] of [['dark', DARK], ['light', LIGHT]] as const) {
      const ratio = contrast(theme[fg], theme[bg]);
      expect(ratio, `${name}: ${fg} (${theme[fg]}) on ${bg} (${theme[bg]}) is ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('defines every token the app actually uses', () => {
    const used = new Set([...appCss.matchAll(/var\((--[a-z0-9-]+)\)/g)].map((m) => m[1]));
    expect([...used].filter((t) => !(t in DARK)).sort()).toEqual([]);
    expect([...used].filter((t) => !(t in LIGHT)).sort()).toEqual([]);
  });

  it('defines nothing the app does not use', () => {
    // A palette is a closed set. An unused colour is one nobody is checking
    // the contrast of, and the next person assumes it means something.
    const used = new Set([...appCss.matchAll(/var\((--[a-z0-9-]+)\)/g)].map((m) => m[1]));
    expect(Object.keys(DARK).filter((t) => !used.has(t)).sort()).toEqual([]);
  });

  it('actually read the stylesheets, rather than passing on empty ones', () => {
    expect(Object.keys(DARK).length).toBeGreaterThan(30);
    expect(appCss.length).toBeGreaterThan(1000);
  });
});

describe('theme choice', () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute('data-theme');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('follows the device until someone says otherwise', () => {
    expect(storedTheme()).toBe('system');
  });

  it('remembers an explicit choice', () => {
    setTheme('light');
    expect(storedTheme()).toBe('light');
    expect(document.documentElement.dataset.theme).toBe('light');
  });

  it('ignores a stored value that is not a theme', () => {
    localStorage.setItem(THEME_KEY, 'chartreuse');
    expect(storedTheme()).toBe('system');
  });

  it('resolves "system" against what the device actually reports', () => {
    const light = (matches: boolean) => () => ({ matches }) as MediaQueryList;
    vi.stubGlobal('matchMedia', light(true));
    expect(resolveTheme('system')).toBe('light');
    vi.stubGlobal('matchMedia', light(false));
    expect(resolveTheme('system')).toBe('dark');
  });

  it('keeps an explicit choice whatever the device says', () => {
    vi.stubGlobal('matchMedia', () => ({ matches: true }) as MediaQueryList);
    expect(resolveTheme('dark')).toBe('dark');
    expect(resolveTheme('light')).toBe('light');
  });

  it('still applies the theme when storage refuses to take it', () => {
    // Safari in private mode throws on setItem rather than failing quietly.
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });

    expect(() => setTheme('light')).not.toThrow();
    expect(document.documentElement.dataset.theme).toBe('light');
    setItem.mockRestore();
  });

  it('puts the resolved palette on the document, not the choice', () => {
    vi.stubGlobal('matchMedia', () => ({ matches: true }) as MediaQueryList);
    applyTheme('system');
    // "system" is not a palette; the attribute has to name one.
    expect(document.documentElement.dataset.theme).toBe('light');
  });
});
