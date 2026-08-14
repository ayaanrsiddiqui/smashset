import type { Character } from './types';

/** Entrant tag (lowercased) -> their main character's name. Fill in as needed. */
export const mainCharacters: Record<string, string> = {};

export function lookupMain(entrantName: string, characters: Character[]): Character | null {
  const charName = mainCharacters[entrantName.trim().toLowerCase()];
  if (!charName) return null;
  return characters.find((c) => c.name.toLowerCase() === charName.toLowerCase()) ?? null;
}
