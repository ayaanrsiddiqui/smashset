/**
 * Lightweight fuzzy match for TO-desk name search: prioritizes prefix and
 * substring hits, falls back to an in-order subsequence match so partial /
 * typo'd tags still surface. Returns null for no match, else a score where
 * lower is better.
 */
export function fuzzyScore(query: string, target: string): number | null {
  const q = query.trim().toLowerCase();
  const t = target.toLowerCase();
  if (!q) return 0;

  if (t.startsWith(q)) return 0;

  const idx = t.indexOf(q);
  if (idx !== -1) return 10 + idx;

  // Subsequence match: every char of q appears in order within t.
  let ti = 0;
  let gaps = 0;
  for (let qi = 0; qi < q.length; qi++) {
    const found = t.indexOf(q[qi], ti);
    if (found === -1) return null;
    gaps += found - ti;
    ti = found + 1;
  }
  return 100 + gaps;
}

export function fuzzyMatchSets<T>(
  query: string,
  items: T[],
  getNames: (item: T) => string[]
): T[] {
  if (!query.trim()) return items;

  const scored: { item: T; score: number }[] = [];
  for (const item of items) {
    let best: number | null = null;
    for (const name of getNames(item)) {
      const score = fuzzyScore(query, name);
      if (score !== null && (best === null || score < best)) best = score;
    }
    if (best !== null) scored.push({ item, score: best });
  }
  scored.sort((a, b) => a.score - b.score);
  return scored.map((s) => s.item);
}
