import { describe, expect, it } from 'vitest';
import { fuzzyMatchCharacters } from './characterAliases';

// A slice of the real Ultimate roster — enough for the ties these rules exist
// to break, which a two-item list would not exercise.
const ROSTER = [
  'Bowser',
  'Bowser Jr.',
  'Donkey Kong',
  'Dr. Mario',
  'Mr. Game & Watch',
  'Olimar',
  'Pokémon Trainer',
  'Pyra / Mythra',
  'R.O.B.',
  'Robin',
  'Roy',
  'Wii Fit Trainer',
].map((name) => ({ name }));

const top = (query: string) => fuzzyMatchCharacters(query, ROSTER)[0]?.name;

describe('finding a character by what players actually call them', () => {
  it('finds Olimar by his alt costume', () => {
    expect(top('alph')).toBe('Olimar');
  });

  it('still finds Olimar by his own name', () => {
    expect(top('olimar')).toBe('Olimar');
  });

  it.each([
    ['dk', 'Donkey Kong'],
    ['doc', 'Dr. Mario'],
    ['gnw', 'Mr. Game & Watch'],
    ['pt', 'Pokémon Trainer'],
    ['aegis', 'Pyra / Mythra'],
    ['wendy', 'Bowser Jr.'],
  ])('%s finds %s', (query, expected) => {
    expect(top(query)).toBe(expected);
  });

  it('gives rob to R.O.B. rather than Robin', () => {
    expect(top('rob')).toBe('R.O.B.');
  });

  it('gives roy to the Fire Emblem one, not the Koopaling costume', () => {
    expect(top('roy')).toBe('Roy');
  });

  it('returns the whole roster for an empty query', () => {
    expect(fuzzyMatchCharacters('  ', ROSTER)).toHaveLength(ROSTER.length);
  });
});
