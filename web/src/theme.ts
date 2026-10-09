/**
 * Which palette the app shows.
 *
 * Three states rather than a switch, because "follow the phone" and "always
 * dark" are different answers and a two-way toggle cannot tell them apart.
 * The override matters at a venue: a TO outdoors in daylight wants the light
 * palette whatever their phone is set to, and a TO in a dark hall wants the
 * dark one at noon.
 *
 * Stored per device, not on the account. It is a property of the screen you
 * are looking at — the same TO wants dark on the laptop at the desk and light
 * on the phone in the sun — so syncing it across devices would be wrong.
 */
export type ThemeChoice = 'system' | 'light' | 'dark';

export const THEME_KEY = 'smashset.theme';

function isChoice(value: unknown): value is ThemeChoice {
  return value === 'system' || value === 'light' || value === 'dark';
}

/** What the TO picked, defaulting to following the device. */
export function storedTheme(): ThemeChoice {
  try {
    const raw = localStorage.getItem(THEME_KEY);
    return isChoice(raw) ? raw : 'system';
  } catch {
    // Safari in private mode throws on access rather than returning null.
    return 'system';
  }
}

/** The palette a choice actually resolves to right now. */
export function resolveTheme(choice: ThemeChoice): 'light' | 'dark' {
  if (choice !== 'system') return choice;
  return typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

/**
 * Puts the resolved palette on <html>, where the CSS looks for it, and keeps
 * the browser chrome in step — on an installed home-screen app the status bar
 * is painted from theme-color, so leaving it behind is a dark band above a
 * light page.
 */
export function applyTheme(choice: ThemeChoice): void {
  const resolved = resolveTheme(choice);
  document.documentElement.dataset.theme = resolved;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) {
    meta.setAttribute('content', getComputedStyle(document.documentElement).getPropertyValue('--bg').trim());
  }
}

export function setTheme(choice: ThemeChoice): void {
  try {
    localStorage.setItem(THEME_KEY, choice);
  } catch {
    // Not fatal: the choice still applies for this session.
  }
  applyTheme(choice);
}
