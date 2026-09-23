import type { Character } from './types';

/** Entrant tag (lowercased) -> their main character's name. Fill in as needed. */
export const mainCharacters: Record<string, string> = {};

export function lookupMain(entrantName: string, characters: Character[]): Character | null {
  const charName = mainCharacters[entrantName.trim().toLowerCase()];
  if (!charName) return null;
  return characters.find((c) => c.name.toLowerCase() === charName.toLowerCase()) ?? null;
}

/** Games played on each character id, for one player. */
export type CharacterCounts = Record<number, number>;

/**
 * The character list reordered to put what this player actually plays first.
 *
 * Most-played first, then everyone else in the order the list already had.
 * Array.sort is stable, so characters on equal counts keep that order too
 * rather than shuffling between renders.
 *
 * No counts means no opinion: the list comes back untouched, so a player
 * nobody has looked up yet reads exactly as the dropdown always did.
 */
export function orderCharactersByTally<T extends { id: number }>(items: T[], counts: CharacterCounts | undefined): T[] {
  if (!counts) return items;
  const played = (item: T) => counts[item.id] ?? 0;
  const tallied = items.filter((item) => played(item) > 0).sort((a, b) => played(b) - played(a));
  if (tallied.length === 0) return items;
  return [...tallied, ...items.filter((item) => played(item) === 0)];
}
