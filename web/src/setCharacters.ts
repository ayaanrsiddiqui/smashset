/**
 * How many characters a row shows for one player.
 *
 * Three covers a counterpick war without letting the icons crowd out the tag
 * beside them — the bracket row is 188px wide and the name has to stay
 * readable. The order guarantees the three shown are the three the set was
 * most about, so what a fourth would add is the least of it.
 */
export const MAX_SET_CHARACTERS = 3;

/**
 * The same ordering the server applies to a finished set (see the server's
 * rankSetCharacters), over the picks being typed into the report screen.
 *
 * Deliberately a second copy rather than a shared module: the server ranks a
 * start.gg games response and this ranks a half-filled form, and the two
 * shapes have nothing else in common. What must not drift is the *rule*, so
 * both sides pin it in tests — the same arrangement the score shorthand parser
 * already has.
 *
 * `picks` is one entry per game **in game order**; null for a game with no
 * character chosen yet, which on this screen is most of them most of the time.
 */
export function rankCharacters(picks: (number | null | undefined)[]): number[] {
  const counts = new Map<number, number>();
  const lastPlayedAt = new Map<number, number>();
  picks.forEach((characterId, index) => {
    if (characterId == null) return;
    counts.set(characterId, (counts.get(characterId) ?? 0) + 1);
    lastPlayedAt.set(characterId, index);
  });

  return [...counts.keys()].sort((a, b) => counts.get(b)! - counts.get(a)! || lastPlayedAt.get(b)! - lastPlayedAt.get(a)!);
}
