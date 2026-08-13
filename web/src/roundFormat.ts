/** Best-of-N guess from round text, since the API doesn't expose it directly. */
export function guessRequiredWins(fullRoundText: string): number {
  const t = fullRoundText.toLowerCase();
  if (t.includes('grand final')) return 3;
  return 2;
}

export const BO_OPTIONS = [
  { label: 'Bo1', requiredWins: 1 },
  { label: 'Bo3', requiredWins: 2 },
  { label: 'Bo5', requiredWins: 3 },
];
