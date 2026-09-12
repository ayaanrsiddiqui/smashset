import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseScoreShorthand } from './scoreParser.js';

interface SharedCase {
  name: string;
  fn: string;
  input: string;
  requiredWins: number;
  /** One character per game from the set winner's perspective: W won, L lost. */
  games?: string;
  errorContains?: string;
}

/**
 * Walks up from wherever the suite was started, so this resolves whether
 * vitest runs from web/, server/, or the repo root. Read from disk rather than
 * imported so neither tsconfig needs resolveJsonModule and neither build has to
 * reach outside its own src/.
 */
function fixturePath(): string {
  let dir = process.cwd();
  for (let i = 0; i < 5; i++) {
    const candidate = path.join(dir, 'shared', 'score-shorthand-cases.json');
    if (existsSync(candidate)) return candidate;
    dir = path.dirname(dir);
  }
  throw new Error(`shared/score-shorthand-cases.json not found from ${process.cwd()}`);
}

const fixture = JSON.parse(readFileSync(fixturePath(), 'utf8')) as { cases: SharedCase[] };

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
