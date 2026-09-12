// start.gg reports a finished set's result as one rendered string, e.g.
// "JL | Zoruya 3 - JL | FireSlam23 2". We read scores from it because it is a
// scalar and therefore nearly free against start.gg's 1000-object request cap,
// where the structured standing.stats.score path costs 10 objects per set —
// about half the entire cost of fetching a bracket.
//
// The parse anchors on the two entrant names we already hold rather than
// splitting on the separator, because neither end of the string is reliable on
// its own. Real names (sampled from live brackets) contain "|", ".", "!", "?"
// and spaces, and — the case that defeats a naive trailing-number match — end
// in digits: "hwon 3 - Curve_Ball917 0" contains three numbers, only two of
// which are scores.

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function matchInOrder(text: string, first: string, second: string): [number, number] | null {
  const pattern = new RegExp(`^${escapeRegExp(first)}\\s+(-?\\d+)\\s+-\\s+${escapeRegExp(second)}\\s+(-?\\d+)$`);
  const found = text.match(pattern);
  return found ? [Number(found[1]), Number(found[2])] : null;
}

/**
 * Settles which slot each score belongs to using the winner, which is known
 * independently of the string.
 *
 * Anchoring on names cannot tell slot order apart when both entrants share a
 * name — the forward pattern always matches first, so the reversed check never
 * runs and a same-name set gets a coin flip presented as fact. A completed
 * set's winner always has the higher score, which settles it.
 *
 * When the names differ the anchor is already reliable, so the winner is used
 * only to detect a contradiction, never to reorder: swapping there would turn
 * a correct reading into a wrong one.
 */
function orientToWinner(
  scores: [number, number],
  winnerSlot: 0 | 1 | null | undefined,
  sameName: boolean
): [number | null, number | null] {
  if (winnerSlot !== 0 && winnerSlot !== 1) return scores;
  const [a, b] = scores;
  // A set with a winner cannot have ended level, so the string and the bracket
  // disagree and neither reading is worth reporting.
  if (a === b) return [null, null];
  if (winnerSlot === 0 ? a > b : b > a) return scores;

  // Both slots carry the same name, so the string never said which side was
  // which — the winner is the only thing that can, and it says this way round.
  if (sameName) return [b, a];
  // Distinct names *did* resolve the order, reliably. A disagreement with the
  // winner therefore means the two sources are inconsistent, not that the
  // order is backwards — so swapping here would corrupt a correct reading.
  return [null, null];
}

/**
 * Scores for [slotA, slotB], or nulls when the string carries no usable score.
 *
 * Returns nulls rather than guessing for a disqualification (start.gg gives the
 * bare string "DQ", with no names and no numbers), for a set that has not been
 * played, and for anything else that doesn't match — the bracket already
 * renders a set with no score, so degrading is safe where a wrong score is not.
 *
 * `winnerSlot` is which slot won, when the set has a winner. Without it the
 * string's own order is trusted, which start.gg does not actually promise.
 */
export function parseDisplayScore(
  displayScore: string | null | undefined,
  nameA: string | null | undefined,
  nameB: string | null | undefined,
  winnerSlot?: 0 | 1 | null
): [number | null, number | null] {
  if (!displayScore || !nameA || !nameB) return [null, null];
  const text = displayScore.trim();

  const sameName = nameA === nameB;

  const inOrder = matchInOrder(text, nameA, nameB);
  if (inOrder) return orientToWinner(inOrder, winnerSlot, sameName);

  // start.gg does not promise the string lists the entrants in slot order.
  const reversed = matchInOrder(text, nameB, nameA);
  return reversed ? orientToWinner([reversed[1], reversed[0]], winnerSlot, sameName) : [null, null];
}
