/**
 * What a report contributes to the record beyond the result itself — how long
 * it took, and whether characters went in — sanitised at the one place
 * untrusted numbers from a browser reach the database.
 *
 * Out-of-range values become null rather than being clamped to the bound.
 * Clamping would stack every junk value at the cap and pull the distribution
 * toward it; null leaves it out, and the median it is read through needs no
 * help from either.
 */

/**
 * Panel opened to report pressed. Ten minutes is far past any real report — a
 * set takes seconds to enter — so anything longer is a panel left open while
 * the TO did something else, which is not what this number measures.
 */
export const MAX_OPEN_TO_REPORT_MS = 10 * 60_000;

/**
 * Report pressed to start.gg confirming. The outbox never gives up, so an
 * hour-long venue outage is real and is exactly the case worth seeing; days
 * means a device clock moved underneath the measurement.
 */
export const MAX_DELIVERY_MS = 24 * 60 * 60_000;

/** A duration from a client, or null if it cannot be one. */
export function acceptDuration(value: unknown, max: number): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  if (value < 0 || value > max) return null;
  return Math.round(value);
}

interface CharacterSelection {
  gameNum: number;
  winnerCharacterId?: number | null;
  loserCharacterId?: number | null;
}

/**
 * Games, out of those actually played, with a character entered for one side.
 *
 * Bounded by the played games rather than by whatever the form sent: the
 * all-games box fills every row up to the best-of, so a 2-0 in a best-of-five
 * can arrive carrying picks for games three to five that were never played.
 */
export function gamesWithCharacter(
  characters: CharacterSelection[] | undefined,
  side: 'winner' | 'loser',
  playedGames: number
): number {
  const games = new Set<number>();
  for (const pick of characters ?? []) {
    if (!Number.isInteger(pick.gameNum) || pick.gameNum < 1 || pick.gameNum > playedGames) continue;
    const characterId = side === 'winner' ? pick.winnerCharacterId : pick.loserCharacterId;
    if (characterId != null) games.add(pick.gameNum);
  }
  return games.size;
}
