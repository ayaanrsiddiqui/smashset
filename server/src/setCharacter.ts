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

function tally(games: SetGame[], entrantId: number): Map<number, number> {
  const counts = new Map<number, number>();
  for (const game of games) {
    const character = characterIn(game, entrantId);
    if (character != null) counts.set(character, (counts.get(character) ?? 0) + 1);
  }
  return counts;
}

/**
 * The single most-frequent character, or null when several tie and nothing
 * separates them.
 *
 * `lastWon` breaks a tie: a player who split games between two characters and
 * closed with one of them was, for display purposes, playing that one.
 */
function leader(counts: Map<number, number>, lastWon: number | null): number | null {
  if (counts.size === 0) return null;
  const best = Math.max(...counts.values());
  const tied = [...counts].flatMap(([character, n]) => (n === best ? [character] : []));
  if (tied.length === 1) return tied[0];
  return lastWon != null && tied.includes(lastWon) ? lastWon : null;
}

/**
 * The one character to show beside an entrant's tag for a completed set.
 *
 * A set is not one character: people counterpick. So rather than showing the
 * first or last pick, this asks which character the set should be credited to.
 *
 * For the winner that is their most-used character when the set also ended on
 * it, and otherwise whichever character actually won them games. The two
 * clauses pull apart in a reverse 3-0: picking C1/C1/C2/C2/C1 wins more games
 * on C2, but the set belongs to C1, which they played most and closed on —
 * while C1/C1/C1/C2/C2 belongs to the counterpick that finished the job.
 *
 * The loser is simply their most-used character. Neither clause above means
 * anything for them — they never won the last game, and crediting the one game
 * they might have stolen overstates it — so what they spent the set playing is
 * the safer answer.
 *
 * Returns null when start.gg carries no character data for the set, which is
 * common — plenty of TOs never report selections — so the caller must be able
 * to show nothing.
 */
export function pickSetCharacter(games: SetGame[], entrantId: number, setWinnerId: number | null): number | null {
  // start.gg does not promise play order, and "the last game" is meaningless
  // if that is assumed.
  const ordered = [...games].sort((a, b) => a.orderNum - b.orderNum);
  const played = ordered.filter((game) => characterIn(game, entrantId) != null);
  if (played.length === 0) return null;

  const won = played.filter((game) => game.winnerId === entrantId);
  const lastPick = characterIn(played[played.length - 1], entrantId);
  const closedWith = entrantId === setWinnerId ? characterIn(ordered[ordered.length - 1], entrantId) : null;

  const mostUsed = leader(tally(played, entrantId), closedWith);
  if (entrantId !== setWinnerId) {
    // Ties fall to wins and then to their last pick, so the icon still resolves
    // to something rather than blinking out on an even split.
    return mostUsed ?? leader(tally(won, entrantId), null) ?? lastPick;
  }

  if (closedWith != null && mostUsed === closedWith) return mostUsed;

  const mostWins = leader(tally(won, entrantId), closedWith);
  // They won nothing, or their wins split evenly with nothing to break the
  // tie: show what they played most, and failing that their last pick. Still
  // an answer, because an icon that vanishes reads as missing data.
  return mostWins ?? mostUsed ?? lastPick;
}
