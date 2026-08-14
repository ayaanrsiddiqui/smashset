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
 *
 * All three forms above describe the same bo5 result: 3-1, sequence W W L W.
 * Assumes best-of-N: the set ends the instant the winner reaches requiredWins.
 */
export function parseScoreShorthand(raw: string, requiredWins: number): ParsedGame[] {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error('Enter a score, e.g. "124", "-3", or "WWLW"');
  }

  if (/^[wl]+$/i.test(trimmed)) {
    const chars = trimmed.toUpperCase().split('');
    if (chars[chars.length - 1] !== 'W') {
      throw new Error('The last game of the set has to be a win for the set winner');
    }
    return chars.map((c, i) => ({ gameNum: i + 1, winnerWonGame: c === 'W' }));
  }

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

  let totalGames: number;
  let winnerGameNumbers: Set<number>;

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
    // Win-list mode is self-describing: however many games are listed is
    // however many wins the winner needed, regardless of the bo3/bo5 toggle.
    winnerGameNumbers = new Set(digits);
    totalGames = digits[digits.length - 1];
  }

  const games: ParsedGame[] = [];
  for (let g = 1; g <= totalGames; g++) {
    games.push({ gameNum: g, winnerWonGame: winnerGameNumbers.has(g) });
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
