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
  const bestOf = requiredWins * 2 - 1;
  const win = requiredWins === 1 ? 'win' : 'wins';
  if (winnerGameNumbers.size > requiredWins || loserGameCount >= requiredWins) {
    throw new Error(
      `Best of ${bestOf} ends the moment someone reaches ${requiredWins} ${win} — "${trimmed}" has a game past that`
    );
  }
  // The other half of the same rule. Bounding only the top let "WW" through as
  // a finished best-of-five, and a set that has not been won yet would then be
  // reported as final — which is the one thing a TO cannot take back.
  if (winnerGameNumbers.size < requiredWins) {
    throw new Error(
      `Best of ${bestOf} is not over until someone reaches ${requiredWins} ${win} — "${trimmed}" leaves the set unfinished`
    );
  }

  const games: ParsedGame[] = [];
  for (let g = 1; g <= totalGames; g++) {
    games.push({ gameNum: g, winnerWonGame: winnerGameNumbers.has(g) });
  }
  return games;
}

/**
 * Lenient, non-throwing sibling of parseScoreShorthand for live display while
 * the buffer is still mid-type — e.g. "ww" or "wwl" are incomplete/invalid
 * final scores but should still light up the games they already describe.
 * Returns [] wherever the buffer can't be made sense of yet.
 */
export function previewGames(raw: string, requiredWins: number): ParsedGame[] {
  const trimmed = raw.trim();
  if (!trimmed) return [];

  let totalGames: number;
  let winnerGameNumbers: Set<number>;

  if (trimmed === '+' || trimmed === '-' || trimmed === '0') {
    totalGames = requiredWins;
    winnerGameNumbers = new Set(Array.from({ length: requiredWins }, (_, i) => i + 1));
  } else if (/^[wl]+$/i.test(trimmed)) {
    const chars = trimmed.toUpperCase().split('');
    totalGames = chars.length;
    winnerGameNumbers = new Set<number>();
    chars.forEach((c, i) => {
      if (c === 'W') winnerGameNumbers.add(i + 1);
    });
  } else {
    const isLossMode = trimmed.startsWith('-');
    const digitsStr = isLossMode ? trimmed.slice(1) : trimmed;
    if (!digitsStr || !/^[1-9]+$/.test(digitsStr)) return [];

    const digits = digitsStr.split('').map(Number);
    for (let i = 1; i < digits.length; i++) {
      if (digits[i] <= digits[i - 1]) return [];
    }

    if (isLossMode) {
      const lossNumbers = new Set(digits);
      totalGames = requiredWins + lossNumbers.size;
      winnerGameNumbers = new Set<number>();
      for (let g = 1; g <= totalGames; g++) {
        if (!lossNumbers.has(g)) winnerGameNumbers.add(g);
      }
    } else {
      winnerGameNumbers = new Set(digits);
      totalGames = digits[digits.length - 1];
    }
  }

  // A set is decided the instant either side reaches requiredWins, so no
  // valid sequence can show the winner with requiredWins losses (they'd have
  // already lost), or the winner clinching anywhere but the final game
  // (everything after a clinch couldn't have been played). This catches
  // "-4"/"wwwl" in a bo5 — 3 straight wins already clinch it, so a 4th game
  // (win or loss) makes no sense — while still allowing "ww"/"wwl" mid-type,
  // since neither side has reached requiredWins yet.
  const games: ParsedGame[] = [];
  let cumulativeWins = 0;
  let cumulativeLosses = 0;
  for (let g = 1; g <= totalGames; g++) {
    const winnerWonGame = winnerGameNumbers.has(g);
    if (winnerWonGame) cumulativeWins++;
    else cumulativeLosses++;
    if (cumulativeLosses >= requiredWins) return [];
    if (cumulativeWins >= requiredWins && g !== totalGames) return [];
    games.push({ gameNum: g, winnerWonGame });
  }
  return games;
}

export interface QuickScore {
  winnerCount: number;
  loserCount: number;
}

/** Parses the "q" tool's aggregate-only score, e.g. "3-1" or "31" (winner's count first). */
export function parseQuickScore(raw: string): QuickScore {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error('Enter a score, e.g. "3-1"');
  }

  const dashMatch = trimmed.match(/^([0-9]+)-([0-9]+)$/);
  const digits = dashMatch ? null : trimmed.match(/^([0-9])([0-9])$/);
  const match = dashMatch ?? digits;
  if (!match) {
    throw new Error('Use the format "3-1"');
  }

  const winnerCount = Number(match[1]);
  const loserCount = Number(match[2]);
  if (winnerCount <= 0) {
    throw new Error('The set winner needs at least one game win');
  }
  return { winnerCount, loserCount };
}

/** Turns quick-score counts into the equivalent loss-mode (or win-list, if a shutout) shorthand. */
export function quickScoreToShorthand(winnerCount: number, loserCount: number): string {
  if (loserCount === 0) {
    return Array.from({ length: winnerCount }, (_, i) => i + 1).join('');
  }
  return '-' + Array.from({ length: loserCount }, (_, i) => i + 1).join('');
}
