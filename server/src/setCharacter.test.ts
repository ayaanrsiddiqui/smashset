import { describe, expect, it } from 'vitest';
import { pickSetCharacter, type SetGame } from './setCharacter.js';

const ME = 1;
const THEM = 2;
const FOX = 100;
const FALCO = 200;

/** One game: what each side picked. The rule does not read who won it. */
function game(orderNum: number, mine: number, theirs = FOX): SetGame {
  return { orderNum, characterIdByEntrantId: { [ME]: mine, [THEM]: theirs } };
}

describe('pickSetCharacter', () => {
  it('shows the one character a player stuck with', () => {
    expect(pickSetCharacter([game(1, FOX), game(2, FOX), game(3, FOX)], ME)).toBe(FOX);
  });

  it('headlines the most-played character, not the one that closed the set', () => {
    // Fox, Fox, Fox, Falco, Falco — a reverse 3-0 won on the counterpick.
    // Falco took two of the three games won, so a rule about credit would
    // headline it; that reads as "mainly Falco", and they played Fox for three
    // of five games. What closed the set is a separate fact.
    expect(pickSetCharacter([game(1, FOX), game(2, FOX), game(3, FOX), game(4, FALCO), game(5, FALCO)], ME)).toBe(FOX);
  });

  it('headlines a counterpick once it is genuinely most of the set', () => {
    expect(pickSetCharacter([game(1, FOX), game(2, FALCO), game(3, FALCO), game(4, FALCO)], ME)).toBe(FALCO);
  });

  it('reads each entrant of a set independently', () => {
    const games: SetGame[] = [
      { orderNum: 1, characterIdByEntrantId: { [ME]: FOX, [THEM]: FALCO } },
      { orderNum: 2, characterIdByEntrantId: { [ME]: FOX, [THEM]: FALCO } },
      { orderNum: 3, characterIdByEntrantId: { [ME]: FOX, [THEM]: FALCO } },
      { orderNum: 4, characterIdByEntrantId: { [ME]: FALCO, [THEM]: FOX } },
      { orderNum: 5, characterIdByEntrantId: { [ME]: FALCO, [THEM]: FOX } },
    ];
    expect(pickSetCharacter(games, ME)).toBe(FOX);
    expect(pickSetCharacter(games, THEM)).toBe(FALCO);
  });

  it('settles an even split on whichever they were playing by the end', () => {
    expect(pickSetCharacter([game(1, FOX), game(2, FALCO), game(3, FOX), game(4, FALCO)], ME)).toBe(FALCO);
  });

  it('ignores the order games arrive in', () => {
    // start.gg does not promise games come back in play order, and the
    // even-split tie-break is meaningless if that is assumed.
    expect(pickSetCharacter([game(2, FALCO), game(1, FOX)], ME)).toBe(FALCO);
  });

  it('reports nothing when the set carries no character data at all', () => {
    // Common: plenty of TOs never report selections, so this is the normal
    // case on a real bracket, not an edge case.
    expect(pickSetCharacter([], ME)).toBeNull();
  });

  it('reports nothing for an entrant who appears in no game', () => {
    expect(pickSetCharacter([{ orderNum: 1, characterIdByEntrantId: { [THEM]: FOX } }], ME)).toBeNull();
  });
});

describe('pickSetCharacter — across every possible set', () => {
  /** Every assignment of `chars` characters across `n` games. */
  function picks(n: number, chars: number): number[][] {
    if (n === 0) return [[]];
    return picks(n - 1, chars).flatMap((rest) => Array.from({ length: chars }, (_, c) => [...rest, c + 1]));
  }

  it('always headlines one of the most-played characters', () => {
    // The invariant the rule exists to guarantee: the first character can never
    // be one the player used less than another. A rule weighing games won
    // cannot promise this — with wins split evenly across three characters it
    // could headline one played once over one played three times.
    let checked = 0;
    for (const length of [2, 3, 4, 5]) {
      for (const mine of picks(length, 3)) {
        const games: SetGame[] = mine.map((c, i) => ({ orderNum: i + 1, characterIdByEntrantId: { [ME]: c } }));
        const counts = new Map<number, number>();
        for (const c of mine) counts.set(c, (counts.get(c) ?? 0) + 1);

        const primary = pickSetCharacter(games, ME)!;
        expect(counts.get(primary), `picks [${mine}] headlined ${primary}`).toBe(Math.max(...counts.values()));
        checked++;
      }
    }
    // Guards the loops themselves: a bug generating nothing would still pass.
    expect(checked).toBe(9 + 27 + 81 + 243);
  });
});
