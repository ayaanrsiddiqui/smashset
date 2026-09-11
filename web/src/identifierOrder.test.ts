import { describe, expect, it } from 'vitest';
import { compareIdentifiers } from './identifierOrder';

describe('compareIdentifiers', () => {
  it('orders single letters alphabetically', () => {
    expect(['C', 'A', 'B'].sort(compareIdentifiers)).toEqual(['A', 'B', 'C']);
  });

  it('orders all single letters before any double letter, regardless of alphabet position', () => {
    expect(['AB', 'Z', 'A', 'AA'].sort(compareIdentifiers)).toEqual(['A', 'Z', 'AA', 'AB']);
  });

  it('is stable across a realistic 16-entrant bracket identifier set', () => {
    const shuffled = ['J', 'AE', 'A', 'O', 'AB', 'M', 'P', 'Z', 'R'];
    expect(shuffled.sort(compareIdentifiers)).toEqual(['A', 'J', 'M', 'O', 'P', 'R', 'Z', 'AB', 'AE']);
  });
});
