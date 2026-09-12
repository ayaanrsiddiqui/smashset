export interface GameSelection {
  entrantId: number;
  characterId: number;
}

export interface SetGame {
  orderNum: number;
  winnerId: number | null;
  selections: GameSelection[];
}

function characterIn(game: SetGame, entrantId: number): number | null {
  return game.selections.find((s) => s.entrantId === entrantId)?.characterId ?? null;
}

/**
 * The character to show first for an entrant in a completed set — the one that
 * headlines the row when several are rendered beside it.
 *
 * Simply whichever they played most. A set is not one character, because people
 * counterpick, and it is tempting to headline whichever character won the set
 * instead: pick Fox, Fox, Fox, Falco, Falco and it was the Falco that closed
 * it. But position can only carry one fact, and the one a viewer decodes from
 * it is how much of the set each character was. Headlining Falco there does not
 * say "the counterpick won it" — nothing about being first says that — it says
 * "mainly Falco", which is false. What won the set is a separate fact and wants
 * a separate visual channel, not an overloaded sort order.
 *
 * Being purely a count also means both players are read the same way, and that
 * the character shown first is always one of the most-played — which a rule
 * mixing in wins cannot promise.
 *
 * Returns null when start.gg carries no character data for the set, which is
 * common — plenty of TOs never report selections — so the caller must be able
 * to show nothing.
 */
export function pickSetCharacter(games: SetGame[], entrantId: number): number | null {
  // start.gg does not promise play order, and the tie-break below is
  // meaningless if that is assumed.
  const played = [...games]
    .sort((a, b) => a.orderNum - b.orderNum)
    .filter((game) => characterIn(game, entrantId) != null);
  if (played.length === 0) return null;

  const counts = new Map<number, number>();
  for (const game of played) {
    const character = characterIn(game, entrantId)!;
    counts.set(character, (counts.get(character) ?? 0) + 1);
  }

  const most = Math.max(...counts.values());
  const tied = [...counts].flatMap(([character, n]) => (n === most ? [character] : []));
  if (tied.length === 1) return tied[0];

  // An even split says nothing about which character the set was, so fall back
  // to whichever of them they were playing by the end.
  for (let i = played.length - 1; i >= 0; i--) {
    const character = characterIn(played[i], entrantId)!;
    if (tied.includes(character)) return character;
  }
  return tied[0];
}
