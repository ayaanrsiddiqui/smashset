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
 * Scores for [slotA, slotB], or nulls when the string carries no usable score.
 *
 * Returns nulls rather than guessing for a disqualification (start.gg gives the
 * bare string "DQ", with no names and no numbers), for a set that has not been
 * played, and for anything else that doesn't match — the bracket already
 * renders a set with no score, so degrading is safe where a wrong score is not.
 */
export function parseDisplayScore(
  displayScore: string | null | undefined,
  nameA: string | null | undefined,
  nameB: string | null | undefined
): [number | null, number | null] {
  if (!displayScore || !nameA || !nameB) return [null, null];
  const text = displayScore.trim();

  const inOrder = matchInOrder(text, nameA, nameB);
  if (inOrder) return inOrder;

  // start.gg does not promise the string lists the entrants in slot order.
  const reversed = matchInOrder(text, nameB, nameA);
  return reversed ? [reversed[1], reversed[0]] : [null, null];
}
