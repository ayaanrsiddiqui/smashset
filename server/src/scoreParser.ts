export interface ParsedGame {
  gameNum: number;
  winnerWonGame: boolean;
}

/**
 * Parses TO shorthand for a set's game-by-game outcome, from the perspective
 * of the entrant who won the overall set.
 *
 *   "124"  -> winner won games 1, 2, 4 (so lost game 3) — self-describing,
 *             the digit count IS the number of games the winner needed.
 *   "-3"   -> winner lost only game 3 (so won every other game up to the
 *             clinch) — this form can't tell bo3 from bo5 on its own, so
 *             requiredWins (from the UI's bo3/bo5 toggle) fills that in.
 *   "WWLW" -> a direct per-game sequence (from typing w/l, or arrow keys —
 *             up/left = W, down/right = L), also self-describing.
 *   "+", "-", or "0" alone -> a clean sweep for the winner, sized by
 *             requiredWins (2-0 for bo3, 3-0 for bo5, ...).
 *
 * All three main forms above describe the same bo5 result: 3-1, sequence
 * W W L W. Assumes best-of-N: the set ends the instant either side reaches
 * requiredWins, so no valid score can give the winner more than
 * requiredWins game wins, or the loser requiredWins or more — either would
 * mean a game was recorded after the set had already been decided.
 */
export function parseScoreShorthand(raw: string, requiredWins: number): ParsedGame[] {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error('Enter a score, e.g. "124", "-3", or "WWLW"');
  }

  let totalGames: number;
  let winnerGameNumbers: Set<number>;

  if (trimmed === '+' || trimmed === '-' || trimmed === '0') {
    totalGames = requiredWins;
    winnerGameNumbers = new Set(Array.from({ length: requiredWins }, (_, i) => i + 1));
  } else if (/^[wl]+$/i.test(trimmed)) {
    const chars = trimmed.toUpperCase().split('');
    if (chars[chars.length - 1] !== 'W') {
      throw new Error('The last game of the set has to be a win for the set winner');
    }
    totalGames = chars.length;
    winnerGameNumbers = new Set<number>();
    chars.forEach((c, i) => {
      if (c === 'W') winnerGameNumbers.add(i + 1);
    });
  } else {
    const isLossMode = trimmed.startsWith('-');
    const digitsStr = isLossMode ? trimmed.slice(1) : trimmed;

    if (!/^[1-9]+$/.test(digitsStr)) {
      throw new Error('Use digits 1-9, "w"/"l", or arrow keys, e.g. "124", "-3", "WWLW"');
    }

    const digits = digitsStr.split('').map(Number);
    for (let i = 1; i < digits.length; i++) {
      if (digits[i] <= digits[i - 1]) {
        throw new Error('Game numbers must be strictly increasing, e.g. "124"');
      }
    }

    if (isLossMode) {
      const lossNumbers = new Set(digits);
      totalGames = requiredWins + lossNumbers.size;
      if (lossNumbers.has(totalGames)) {
        throw new Error('The last game of the set has to be a win for the set winner');
      }
      winnerGameNumbers = new Set<number>();
      for (let g = 1; g <= totalGames; g++) {
        if (!lossNumbers.has(g)) winnerGameNumbers.add(g);
      }
    } else {
      // Win-list mode is self-describing about which games were wins, but
      // the count is still bounded by requiredWins — checked below.
      winnerGameNumbers = new Set(digits);
      totalGames = digits[digits.length - 1];
    }
  }

  const loserGameCount = totalGames - winnerGameNumbers.size;
  if (winnerGameNumbers.size > requiredWins || loserGameCount >= requiredWins) {
    const win = requiredWins === 1 ? 'win' : 'wins';
    throw new Error(
      `Best of ${requiredWins * 2 - 1} ends the moment someone reaches ${requiredWins} ${win} — "${trimmed}" has a game past that`
    );
  }

  const games: ParsedGame[] = [];
  for (let g = 1; g <= totalGames; g++) {
    games.push({ gameNum: g, winnerWonGame: winnerGameNumbers.has(g) });
  }
  return games;
}
