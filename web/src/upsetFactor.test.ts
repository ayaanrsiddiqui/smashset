import { describe, expect, it } from 'vitest';
import { seedBucket, upsetFactor } from './upsetFactor';

describe('projected placement buckets', () => {
  it('puts the two grand finalists together', () => {
    expect(seedBucket(1)).toBe(seedBucket(2));
  });

  it('gives losers final and losers semi a tier each', () => {
    expect(seedBucket(3)).toBe(seedBucket(1) + 1);
    expect(seedBucket(4)).toBe(seedBucket(3) + 1);
  });

  it.each([
    [5, 6],
    [7, 8],
    [9, 12],
    [13, 16],
    [17, 24],
    [25, 32],
  ])('keeps seeds %i..%i in one tier', (first, last) => {
    expect(seedBucket(first)).toBe(seedBucket(last));
  });

  it('separates each tier from the next', () => {
    const tiers = [1, 3, 4, 5, 7, 9, 13, 17, 25, 33].map(seedBucket);
    expect(tiers).toEqual([...tiers].sort((a, b) => a - b));
    expect(new Set(tiers).size).toBe(tiers.length);
  });

  it('keeps answering for a seed past any real bracket', () => {
    expect(seedBucket(9999)).toBeGreaterThan(seedBucket(64));
  });
});

describe('how big an upset a result was', () => {
  it('scores seed 7 beating seed 2 as four tiers', () => {
    // Ayaan's own worked example: 7 is projected 7th-8th, 2 is projected to
    // grands, and there are four tiers between them.
    expect(upsetFactor(7, 2)).toBe(4);
  });

  it('is not an upset when the better seed wins', () => {
    expect(upsetFactor(2, 7)).toBe(0);
  });

  it('is not an upset between two seeds projected to the same finish', () => {
    // 5 over 6 is a coin flip on paper, however the numbers compare.
    expect(upsetFactor(6, 5)).toBe(0);
    expect(upsetFactor(2, 1)).toBe(0);
  });

  it('grows with the gap', () => {
    expect(upsetFactor(33, 1)).toBeGreaterThan(upsetFactor(9, 1)!);
    expect(upsetFactor(9, 1)).toBeGreaterThan(upsetFactor(5, 1)!);
  });

  it('says nothing at all when a seed is unknown', () => {
    // Distinct from zero: "not an upset" and "cannot tell" are different, and
    // a slot filled in the last minute has no seed yet.
    expect(upsetFactor(null, 2)).toBeNull();
    expect(upsetFactor(7, null)).toBeNull();
  });
});
