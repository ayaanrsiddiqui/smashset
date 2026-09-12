import { describe, expect, it } from 'vitest';
import { parseDisplayScore } from './displayScore.js';

// Every string below is a real value sampled from live start.gg brackets.
describe('parseDisplayScore', () => {
  it('reads both scores from the ordinary shape', () => {
    expect(parseDisplayScore('JL | Zoruya 3 - JL | FireSlam23 2', 'JL | Zoruya', 'JL | FireSlam23')).toEqual([3, 2]);
  });

  it('is not fooled by a name that ends in digits', () => {
    // Three numbers in the string; only two are scores.
    expect(parseDisplayScore('hwon 3 - Curve_Ball917 0', 'hwon', 'Curve_Ball917')).toEqual([3, 0]);
    expect(parseDisplayScore('Dwepo 0 - Curve_Ball917 2', 'Dwepo', 'Curve_Ball917')).toEqual([0, 2]);
    expect(parseDisplayScore('Elemy 3 - Cgamer73 0', 'Elemy', 'Cgamer73')).toEqual([3, 0]);
  });

  it('handles names containing separators, punctuation and spaces', () => {
    expect(parseDisplayScore('The High Notes | Losinik 2 - Are you squidding me? 1', 'The High Notes | Losinik', 'Are you squidding me?')).toEqual([2, 1]);
    expect(parseDisplayScore('Grim.. 1 - MOSS! 3', 'Grim..', 'MOSS!')).toEqual([1, 3]);
    expect(parseDisplayScore('Mr. Pi 0 - JL | FireSlam23 3', 'Mr. Pi', 'JL | FireSlam23')).toEqual([0, 3]);
  });

  it('returns scores in slot order even when the string lists the entrants the other way round', () => {
    expect(parseDisplayScore('Negationist 3 - hwon 1', 'hwon', 'Negationist')).toEqual([1, 3]);
  });

  it('gives up on a disqualification rather than inventing a score', () => {
    // start.gg reports a DQ as this exact string — no names, no numbers.
    expect(parseDisplayScore('DQ', 'rayya', 'RegalEagle')).toEqual([null, null]);
  });

  it('gives up when the set has not been played or a slot is still empty', () => {
    expect(parseDisplayScore(null, 'hwon', 'Elemy')).toEqual([null, null]);
    expect(parseDisplayScore('', 'hwon', 'Elemy')).toEqual([null, null]);
    expect(parseDisplayScore('hwon 3 - Elemy 0', null, 'Elemy')).toEqual([null, null]);
  });

  it('gives up when the string does not correspond to these two entrants', () => {
    // A stale or mismatched pairing must not silently yield a wrong score.
    expect(parseDisplayScore('hwon 3 - Elemy 0', 'Dwepo', 'Cgamer73')).toEqual([null, null]);
  });

  it('reads a negative score without mistaking it for the separator', () => {
    expect(parseDisplayScore('hwon -1 - Elemy 2', 'hwon', 'Elemy')).toEqual([-1, 2]);
  });

  it('treats a regex-special name as literal text', () => {
    expect(parseDisplayScore('a.b 2 - c(d) 1', 'a.b', 'c(d)')).toEqual([2, 1]);
    // ".b" must not match "xb" — the dot is escaped, not a wildcard.
    expect(parseDisplayScore('axb 2 - c(d) 1', 'a.b', 'c(d)')).toEqual([null, null]);
  });
});

describe('two entrants sharing a name', () => {
  // 33 pairs of these exist in the HUGE bracket test event, unseeded, so two
  // of them being drawn against each other is a matter of time.
  it('orients the score by the winner, which is the only thing that can', () => {
    // The string is identical either way round, so before this the forward
    // pattern always matched first and slot order was a coin flip.
    expect(parseDisplayScore('AlphaChief 2 - AlphaChief 1', 'AlphaChief', 'AlphaChief', 0)).toEqual([2, 1]);
    expect(parseDisplayScore('AlphaChief 2 - AlphaChief 1', 'AlphaChief', 'AlphaChief', 1)).toEqual([1, 2]);
  });

  it('still reports nothing when there is no winner to orient by', () => {
    expect(parseDisplayScore('AlphaChief 2 - AlphaChief 1', 'AlphaChief', 'AlphaChief', null)).toEqual([2, 1]);
  });
});

describe('the winner as a cross-check', () => {
  it('reports nothing when a distinct-name string contradicts the winner', () => {
    // Here the names *did* resolve the order reliably, so a disagreement means
    // the two sources are inconsistent — not that the order is backwards.
    // Swapping would turn a correct reading into a confident wrong one.
    expect(parseDisplayScore('hwon 1 - Curve_Ball917 3', 'hwon', 'Curve_Ball917', 0)).toEqual([null, null]);
  });

  it('leaves a consistent set alone', () => {
    expect(parseDisplayScore('hwon 3 - Curve_Ball917 1', 'hwon', 'Curve_Ball917', 0)).toEqual([3, 1]);
    expect(parseDisplayScore('hwon 1 - Curve_Ball917 3', 'hwon', 'Curve_Ball917', 1)).toEqual([1, 3]);
  });

  it('reports nothing for a level score that claims a winner', () => {
    expect(parseDisplayScore('hwon 2 - Curve_Ball917 2', 'hwon', 'Curve_Ball917', 0)).toEqual([null, null]);
  });
});
