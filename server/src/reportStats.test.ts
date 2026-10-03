import { describe, expect, it } from 'vitest';
import { MAX_DELIVERY_MS, MAX_OPEN_TO_REPORT_MS, acceptDuration, gamesWithCharacter } from './reportStats.js';

describe('acceptDuration', () => {
  it('keeps a real duration, rounded to a whole millisecond', () => {
    expect(acceptDuration(6400.7, MAX_OPEN_TO_REPORT_MS)).toBe(6401);
  });

  it('drops a negative, which only a clock moving backwards produces', () => {
    expect(acceptDuration(-50, MAX_OPEN_TO_REPORT_MS)).toBeNull();
  });

  it('drops a panel left open past the bound, rather than counting it at the bound', () => {
    // Clamping would pile every abandoned panel up at ten minutes and drag the
    // distribution toward it. Leaving it out keeps the number about reporting.
    expect(acceptDuration(60 * 60_000, MAX_OPEN_TO_REPORT_MS)).toBeNull();
  });

  it('keeps a value exactly at the bound', () => {
    expect(acceptDuration(MAX_OPEN_TO_REPORT_MS, MAX_OPEN_TO_REPORT_MS)).toBe(MAX_OPEN_TO_REPORT_MS);
  });

  it('keeps an hour-long delivery, which is a real venue outage, not junk', () => {
    expect(acceptDuration(60 * 60_000, MAX_DELIVERY_MS)).toBe(60 * 60_000);
  });

  it('drops anything that is not a finite number', () => {
    for (const junk of [NaN, Infinity, '6400', null, undefined, {}]) {
      expect(acceptDuration(junk, MAX_OPEN_TO_REPORT_MS)).toBeNull();
    }
  });
});

describe('gamesWithCharacter', () => {
  it('counts the games with a character entered for that side', () => {
    const picks = [
      { gameNum: 1, winnerCharacterId: 10, loserCharacterId: 20 },
      { gameNum: 2, winnerCharacterId: 10 },
    ];

    expect(gamesWithCharacter(picks, 'winner', 2)).toBe(2);
    expect(gamesWithCharacter(picks, 'loser', 2)).toBe(1);
  });

  it('ignores picks for games that were never played', () => {
    // The all-games box fills to the best-of: a 2-0 in a best-of-five arrives
    // with picks for games three to five as well.
    const picks = [1, 2, 3, 4, 5].map((gameNum) => ({ gameNum, winnerCharacterId: 10 }));

    expect(gamesWithCharacter(picks, 'winner', 2)).toBe(2);
  });

  it('counts a game once even if it appears twice', () => {
    const picks = [
      { gameNum: 1, winnerCharacterId: 10 },
      { gameNum: 1, winnerCharacterId: 11 },
    ];

    expect(gamesWithCharacter(picks, 'winner', 1)).toBe(1);
  });

  it('is zero when no characters were sent at all', () => {
    expect(gamesWithCharacter(undefined, 'winner', 3)).toBe(0);
  });

  it('ignores a game number that is not a real game', () => {
    const picks = [{ gameNum: 0, winnerCharacterId: 10 }, { gameNum: 1.5, winnerCharacterId: 10 }];

    expect(gamesWithCharacter(picks, 'winner', 3)).toBe(0);
  });
});
