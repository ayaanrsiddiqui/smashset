/**
 * The shape of one game, shared with the set-detail endpoint's richer
 * SetDetailGame so the same start.gg response is not modelled twice. Only what
 * this rule reads is required — notably not the game's winner, which it
 * deliberately ignores.
 */
export interface SetGame {
  orderNum: number;
  /** Character each entrant picked, keyed by that entrant's id. */
  characterIdByEntrantId: Record<number, number>;
}

/**
 * Every character an entrant played in a completed set, in the order they are
 * shown — most of the set first.
 *
 * Position can only carry one fact, and the one a viewer decodes from it is how
 * much of the set each character was. It is tempting to lead with whichever
 * character won the set instead: pick Fox, Fox, Fox, Falco, Falco and it was
 * the Falco that closed it. But leading with Falco there does not say "the
 * counterpick won it" — nothing about being first says that — it says "mainly
 * Falco", which is false. What won the set is a separate fact and wants a
 * separate visual channel, not an overloaded sort order.
 *
 * Ordering by count alone also means both players of a set are read the same
 * way, and that the character shown first is always one of the most-played —
 * which a rule mixing in wins cannot promise.
 *
 * An even split says nothing about which character the set was, so it falls to
 * whichever of them they were playing by the end. That is the only place order
 * of play matters, and start.gg does not promise games arrive in it.
 *
 * Returns an empty list when start.gg carries no character data for the set,
 * which is common — plenty of TOs never report selections — so every caller
 * must be able to show nothing.
 */
export function rankSetCharacters(games: SetGame[], entrantId: number): number[] {
  const played = games.filter((game) => game.characterIdByEntrantId[entrantId] != null);

  const counts = new Map<number, number>();
  const lastPlayedAt = new Map<number, number>();
  for (const game of played) {
    const character = game.characterIdByEntrantId[entrantId];
    counts.set(character, (counts.get(character) ?? 0) + 1);
    lastPlayedAt.set(character, Math.max(lastPlayedAt.get(character) ?? -Infinity, game.orderNum));
  }

  return [...counts.keys()].sort((a, b) => counts.get(b)! - counts.get(a)! || lastPlayedAt.get(b)! - lastPlayedAt.get(a)!);
}

