import { describe, expect, it } from 'vitest';
// The same file server/src/scoreParser.test.ts reads, loaded as raw text by
// Vite rather than through node:fs — this suite typechecks against the browser
// app's config, which deliberately has no Node globals.
import fixtureJson from '../../shared/score-shorthand-cases.json?raw';
import { parseQuickScore, parseScoreShorthand, previewGames, quickScoreToShorthand } from './scoreParser';

interface SharedCase {
  name: string;
  fn: string;
  input: string;
  requiredWins: number;
  /** One character per game from the set winner's perspective: W won, L lost. */
  games?: string;
  errorContains?: string;
}

const fixture = JSON.parse(fixtureJson) as { cases: SharedCase[] };

// This copy only exports parseScoreShorthand; a case for anything else is not
// its to answer.
const cases = fixture.cases.filter((c) => c.fn === 'parseScoreShorthand');

function expand(games: string) {
  return [...games].map((char, i) => ({ gameNum: i + 1, winnerWonGame: char === 'W' }));
}

describe('parseScoreShorthand — shared behaviour fixture', () => {
  it('actually loaded the shared cases', () => {
    // Without this, a broken path or a filter matching nothing would leave
    // it.each with an empty list and the suite would pass having checked zero
    // inputs — the exact failure this file exists to prevent.
    expect(cases.length).toBeGreaterThanOrEqual(30);
  });

  it.each(cases.map((c) => [c.name, c] as const))('%s', (_name, testCase) => {
    if (testCase.errorContains !== undefined) {
      expect(() => parseScoreShorthand(testCase.input, testCase.requiredWins)).toThrow(testCase.errorContains);
      return;
    }
    expect(parseScoreShorthand(testCase.input, testCase.requiredWins)).toEqual(expand(testCase.games!));
  });
});

/** Shorthand for reading a preview result. */
const shape = (games: { winnerWonGame: boolean }[]) => games.map((g) => (g.winnerWonGame ? 'W' : 'L')).join('');

describe('previewGames — lenient, for a buffer still being typed', () => {
  it('lights up a partial sequence that is not yet a finished set', () => {
    // The case the doc comment calls out: "ww" and "wwl" are not valid final
    // scores, but a TO mid-type should see the games they already described.
    expect(shape(previewGames('ww', 3))).toBe('WW');
    expect(shape(previewGames('wwl', 3))).toBe('WWL');
  });

  it('shows nothing once the buffer describes a game that could not have happened', () => {
    // Also from the doc comment: three straight wins already clinch a bo5, so
    // a fourth game — win or loss — is not a set that was ever played.
    expect(previewGames('wwwl', 3)).toEqual([]);
    expect(previewGames('-4', 3)).toEqual([]);
  });

  it('shows nothing once the loser would have won the set', () => {
    expect(previewGames('llw', 2)).toEqual([]);
    expect(previewGames('-12', 2)).toEqual([]);
  });

  it('is lenient exactly where parseScoreShorthand is strict', () => {
    // The one place the two deliberately disagree. parseScoreShorthand refuses
    // a set that does not end on the winner's game; previewGames shows it,
    // because the TO has not finished typing.
    expect(shape(previewGames('wwl', 3))).toBe('WWL');
    expect(() => parseScoreShorthand('wwl', 3)).toThrow('last game of the set has to be a win');
  });

  it('agrees with parseScoreShorthand on every complete, valid score', () => {
    // Where a score is valid, the preview a TO was watching must be the score
    // that gets reported — otherwise the display lied right up to the moment
    // they committed it.
    for (const [input, requiredWins] of [
      ['124', 3], ['-3', 3], ['WWLW', 3], ['+', 3], ['12', 2], ['13', 2], ['-1', 2], ['+', 2],
    ] as const) {
      expect(shape(previewGames(input, requiredWins)), input).toBe(shape(parseScoreShorthand(input, requiredWins)));
    }
  });

  it('returns nothing rather than throwing for junk', () => {
    // It runs on every keystroke, so it must never throw.
    for (const input of ['', '   ', 'abc', '121', '11', '10', '--3', '-0', '1x']) {
      expect(previewGames(input, 3), input).toEqual([]);
    }
  });
});

describe('parseQuickScore — the "q" tool\'s aggregate-only score', () => {
  it('reads both the dashed and bare two-digit forms', () => {
    expect(parseQuickScore('3-1')).toEqual({ winnerCount: 3, loserCount: 1 });
    expect(parseQuickScore('31')).toEqual({ winnerCount: 3, loserCount: 1 });
    expect(parseQuickScore(' 2-0 ')).toEqual({ winnerCount: 2, loserCount: 0 });
  });

  it('refuses a score the set winner did not win', () => {
    expect(() => parseQuickScore('0-3')).toThrow('at least one game win');
  });

  it('refuses anything that is not a score', () => {
    expect(() => parseQuickScore('')).toThrow('Enter a score');
    expect(() => parseQuickScore('3-')).toThrow('Use the format');
    expect(() => parseQuickScore('x')).toThrow('Use the format');
    // Three bare digits are ambiguous — 3-12 or 31-2 — so only the dashed
    // form may carry a count above 9.
    expect(() => parseQuickScore('312')).toThrow('Use the format');
  });
});

describe('quickScoreToShorthand', () => {
  it('writes a shutout as a win list and anything else as a loss list', () => {
    expect(quickScoreToShorthand(2, 0)).toBe('12');
    expect(quickScoreToShorthand(3, 0)).toBe('123');
    expect(quickScoreToShorthand(3, 1)).toBe('-1');
    expect(quickScoreToShorthand(3, 2)).toBe('-12');
  });

  it('round-trips every valid scoreline back to the same counts', () => {
    // This is the actual pipeline the "q" tool runs: counts in, shorthand out,
    // shorthand parsed into the games that get reported. A break anywhere in
    // it reports a score the TO did not enter.
    for (const [winnerCount, loserCount, requiredWins] of [
      [2, 0, 2], [2, 1, 2], [3, 0, 3], [3, 1, 3], [3, 2, 3],
    ] as const) {
      const games = parseScoreShorthand(quickScoreToShorthand(winnerCount, loserCount), requiredWins);
      const label = `${winnerCount}-${loserCount} (bo${requiredWins * 2 - 1})`;
      expect(games.filter((g) => g.winnerWonGame).length, label).toBe(winnerCount);
      expect(games.filter((g) => !g.winnerWonGame).length, label).toBe(loserCount);
    }
  });
});
