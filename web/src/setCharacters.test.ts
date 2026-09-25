import { describe, expect, it } from 'vitest';
import { rankCharacters } from './setCharacters';

const FOX = 100;
const FALCO = 200;
const WOLF = 300;

// The rule these pin is the server's rankSetCharacters, kept in step by hand.
// Any change here belongs in server/src/setCharacter.ts too, and vice versa.
describe('rankCharacters', () => {
  it('lists every character used, most of the set first', () => {
    expect(rankCharacters([FOX, FALCO, FALCO])).toEqual([FALCO, FOX]);
  });

  it('leads with the most-played, not whatever was picked last', () => {
    // Fox, Fox, Fox, Falco, Falco — the counterpick closed it, and leading
    // with Falco would read as "mainly Falco" when it was mainly Fox.
    expect(rankCharacters([FOX, FOX, FOX, FALCO, FALCO])).toEqual([FOX, FALCO]);
  });

  it('settles an even split on whichever they were playing by the end', () => {
    expect(rankCharacters([FOX, FALCO, FOX, FALCO])).toEqual([FALCO, FOX]);
  });

  it('breaks a tie further down the row the same way', () => {
    expect(rankCharacters([FOX, FALCO, WOLF, FOX])).toEqual([FOX, WOLF, FALCO]);
  });

  it('lists a character once however many games it was played in', () => {
    expect(rankCharacters([FOX, FOX, FOX])).toEqual([FOX]);
  });

  it('ignores games with nothing chosen yet, which is the normal state here', () => {
    // A half-filled form is the common case on the report screen, not an edge.
    expect(rankCharacters([null, FOX, undefined, FOX, null])).toEqual([FOX]);
    expect(rankCharacters([])).toEqual([]);
    expect(rankCharacters([null, null])).toEqual([]);
  });

  it('counts a later game as later even when earlier ones are still empty', () => {
    // Both played once; Falco's game is later, so it leads.
    expect(rankCharacters([FOX, null, FALCO])).toEqual([FALCO, FOX]);
  });
});
