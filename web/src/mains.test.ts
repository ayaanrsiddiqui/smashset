import { describe, expect, it } from 'vitest';
import { orderCharactersByTally } from './mains';

const CHARS = [
  { id: 1, name: 'Bayonetta' },
  { id: 2, name: 'Bowser' },
  { id: 3, name: 'Captain Falcon' },
  { id: 4, name: 'Donkey Kong' },
];

describe('orderCharactersByTally', () => {
  it('puts what the player actually plays first, most-played first', () => {
    expect(orderCharactersByTally(CHARS, { 3: 5, 1: 2 }).map((c) => c.name)).toEqual([
      'Captain Falcon',
      'Bayonetta',
      'Bowser',
      'Donkey Kong',
    ]);
  });

  it('leaves the list alone when nobody has looked this player up', () => {
    // Absent counts are no opinion, not an empty one — the dropdown has to
    // read exactly as it always did rather than appearing to rank anything.
    expect(orderCharactersByTally(CHARS, undefined)).toBe(CHARS);
  });

  it('leaves the list alone for a player tallied as playing nothing we know', () => {
    // A real but empty tally, e.g. a player start.gg has no character data
    // for. Sorting by it would be sorting by nothing.
    expect(orderCharactersByTally(CHARS, {})).toBe(CHARS);
  });

  it('keeps the original order among characters played the same amount', () => {
    // Stable, so a dropdown does not reshuffle between renders while a TO is
    // looking at it.
    expect(orderCharactersByTally(CHARS, { 4: 3, 2: 3 }).map((c) => c.name)).toEqual([
      'Bowser',
      'Donkey Kong',
      'Bayonetta',
      'Captain Falcon',
    ]);
  });

  it('keeps characters the player has never touched, just lower down', () => {
    // They can still pick anyone — a counterpick is exactly the case where a
    // TO needs a character that is not in the history.
    expect(orderCharactersByTally(CHARS, { 2: 1 })).toHaveLength(CHARS.length);
  });

  it('does not mutate the list it was given', () => {
    const original = [...CHARS];
    orderCharactersByTally(CHARS, { 3: 5 });
    expect(CHARS).toEqual(original);
  });
});
