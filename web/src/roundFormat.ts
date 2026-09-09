/**
 * Best-of-N guess for a set. If the TO has set a "Top X -> Bo5" cutoff and
 * this set's lPlacement (the place its loser will finish — start.gg computes
 * this from the real bracket, so it works regardless of bracket shape) is
 * within that cutoff, it's a bo5. Otherwise falls back to guessing from the
 * round text, since the API doesn't expose best-of directly.
 */
export function guessRequiredWins(
  fullRoundText: string,
  lPlacement: number | null,
  topXBo5: number | null
): number {
  if (topXBo5 != null && lPlacement != null && lPlacement <= topXBo5) return 3;
  const t = fullRoundText.toLowerCase();
  if (t.includes('grand final')) return 3;
  return 2;
}

export const BO_OPTIONS = [
  { label: 'Bo1', requiredWins: 1 },
  { label: 'Bo3', requiredWins: 2 },
  { label: 'Bo5', requiredWins: 3 },
];

/** requiredWins -> "BoN" label, for formats beyond the BO_OPTIONS shortcuts (Bo7, Bo9, ...). */
export function boLabel(requiredWins: number): string {
  return `Bo${requiredWins * 2 - 1}`;
}
