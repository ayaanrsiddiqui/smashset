import { fuzzyScore } from './fuzzy';

interface AliasRule {
  /** Matches a character's official name. */
  test: (name: string) => boolean;
  /** Extra search terms that should find this character, beyond its official name. */
  terms: string[];
}

// Add more of these as they come up — one rule per character that players
// commonly refer to by something other than their official start.gg name.
const ALIAS_RULES: AliasRule[] = [
  { test: (n) => /donkey\s*kong/i.test(n), terms: ['dk'] },
  { test: (n) => /^dr\.?\s*mario$/i.test(n), terms: ['doc'] },
  // The 7 Koopaling alt costumes — "roy" also matches the real Roy (Fire
  // Emblem) below, and that one needs to win the tie; see PRIORITY_ORDER.
  {
    test: (n) => /^bowser\s*jr\.?$/i.test(n),
    terms: ['larry', 'roy', 'lemmy', 'wendy', 'iggy', 'morton', 'ludwig'],
  },
  { test: (n) => /game\s*(&|and)?\s*watch/i.test(n), terms: ['gnw'] },
  { test: (n) => /pok[eé]mon\s*trainer/i.test(n), terms: ['pt'] },
  { test: (n) => /wii\s*fit\s*trainer/i.test(n), terms: ['wf'] },
  // Pyra and Mythra share a single roster slot (one combined entry, e.g.
  // "Pyra / Mythra"), not two separate characters — match on either name
  // appearing anywhere in it rather than requiring an exact "Pyra"/"Mythra".
  { test: (n) => /pyra/i.test(n) || /mythra/i.test(n), terms: ['aegis'] },
  // "rob" doesn't naturally prefix-match "R.O.B." because of the periods —
  // without this it'd only reach it via a much weaker subsequence match,
  // well behind "Robin". Paired with the priority rule below.
  { test: (n) => /^r\.?\s*o\.?\s*b\.?$/i.test(n), terms: ['rob'] },
  // "alph" is Olimar's alt costume, and players call the character by it.
  { test: (n) => /^olimar$/i.test(n), terms: ['alph'] },
];

// When two characters tie on fuzzy score, the one with the lower priority
// index sorts first. Everything not listed shares the same (last) tier, so
// it's untouched — this only ever breaks ties for the pairs listed here.
const PRIORITY_ORDER: ((name: string) => boolean)[] = [
  (n) => /^bowser$/i.test(n), // over Bowser Jr.
  (n) => /^r\.?\s*o\.?\s*b\.?$/i.test(n), // over Robin
  (n) => /^roy$/i.test(n), // the real Roy (Fire Emblem) over Bowser Jr.'s "Roy" costume alias
];

function searchTerms(name: string): string[] {
  const extra = ALIAS_RULES.filter((rule) => rule.test(name)).flatMap((rule) => rule.terms);
  return [name, ...extra];
}

function priorityOf(name: string): number {
  const idx = PRIORITY_ORDER.findIndex((test) => test(name));
  return idx === -1 ? PRIORITY_ORDER.length : idx;
}

/** Same idea as fuzzyMatchSets, but alias- and priority-aware for character names specifically. */
export function fuzzyMatchCharacters<T extends { name: string }>(query: string, items: T[]): T[] {
  if (!query.trim()) return items;

  const scored: { item: T; score: number; priority: number }[] = [];
  for (const item of items) {
    let best: number | null = null;
    for (const term of searchTerms(item.name)) {
      const score = fuzzyScore(query, term);
      if (score !== null && (best === null || score < best)) best = score;
    }
    if (best !== null) scored.push({ item, score: best, priority: priorityOf(item.name) });
  }
  scored.sort((a, b) => a.score - b.score || a.priority - b.priority);
  return scored.map((s) => s.item);
}
