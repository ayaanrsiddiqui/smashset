import { describe, expect, it } from 'vitest';
import { pickSetCharacter, type SetGame } from './setCharacter.js';

const ME = 1;
const THEM = 2;
const FOX = 100;
const FALCO = 200;
const MARTH = 300;

/** One game: who won it, and what each side picked. */
function game(orderNum: number, winnerId: number, mine: number, theirs = FOX): SetGame {
  return {
    orderNum,
    winnerId,
    selections: [
      { entrantId: ME, characterId: mine },
      { entrantId: THEM, characterId: theirs },
    ],
  };
}

describe('pickSetCharacter', () => {
  it('shows the one character a player stuck with', () => {
    expect(pickSetCharacter([game(1, ME, FOX), game(2, THEM, FOX), game(3, ME, FOX)], ME)).toBe(FOX);
  });

  it('headlines the most-played character, not the one that closed the set', () => {
    // Fox, Fox, Fox, Falco, Falco — a reverse 3-0 won on the counterpick.
    // Falco won two of the three games they took, so a rule about credit would
    // headline it; that would read as "mainly Falco", and they played Fox for
    // three of five games. What closed the set is a separate fact.
    const games = [game(1, THEM, FOX), game(2, THEM, FOX), game(3, ME, FOX), game(4, ME, FALCO), game(5, ME, FALCO)];
    expect(pickSetCharacter(games, ME)).toBe(FOX);
  });

  it('headlines the character they came back on', () => {
    // Fox, Fox, Falco, Falco, Fox: still Fox on a count, and still the honest
    // summary even though Falco won more of the individual games.
    const games = [game(1, THEM, FOX), game(2, THEM, FOX), game(3, ME, FALCO), game(4, ME, FALCO), game(5, ME, FOX)];
    expect(pickSetCharacter(games, ME)).toBe(FOX);
  });

  it('headlines a counterpick once it is genuinely most of the set', () => {
    const games = [game(1, THEM, FOX), game(2, ME, FALCO), game(3, ME, FALCO), game(4, THEM, FALCO)];
    expect(pickSetCharacter(games, ME)).toBe(FALCO);
  });

  it('reads both players of a set the same way', () => {
    // Identical pick patterns, opposite results. An asymmetric rule would give
    // these two different answers, and the icons sit side by side.
    const games = [
      { orderNum: 1, winnerId: THEM, selections: [{ entrantId: ME, characterId: FOX }, { entrantId: THEM, characterId: FOX }] },
      { orderNum: 2, winnerId: THEM, selections: [{ entrantId: ME, characterId: FOX }, { entrantId: THEM, characterId: FOX }] },
      { orderNum: 3, winnerId: ME, selections: [{ entrantId: ME, characterId: FOX }, { entrantId: THEM, characterId: FOX }] },
      { orderNum: 4, winnerId: ME, selections: [{ entrantId: ME, characterId: FALCO }, { entrantId: THEM, characterId: FALCO }] },
      { orderNum: 5, winnerId: ME, selections: [{ entrantId: ME, characterId: FALCO }, { entrantId: THEM, characterId: FALCO }] },
    ];
    expect(pickSetCharacter(games, ME)).toBe(FOX);
    expect(pickSetCharacter(games, THEM)).toBe(FOX);
  });

  it('settles an even split on whichever they were playing by the end', () => {
    const games = [game(1, ME, FOX), game(2, THEM, FALCO), game(3, THEM, FOX), game(4, ME, FALCO)];
    expect(pickSetCharacter(games, ME)).toBe(FALCO);
  });

  it('ignores the order games arrive in', () => {
    // start.gg does not promise games come back in play order, and the
    // even-split tie-break is meaningless if that is assumed.
    const inOrder = [game(1, ME, FOX), game(2, THEM, FALCO)];
    expect(pickSetCharacter([inOrder[1], inOrder[0]], ME)).toBe(FALCO);
  });

  it('reports nothing when the set carries no character data at all', () => {
    // Common: plenty of TOs never report selections, so this is the normal
    // case on a real bracket, not an edge case.
    expect(pickSetCharacter([], ME)).toBeNull();
  });

  it('reports nothing for an entrant who appears in no game', () => {
    const games = [{ orderNum: 1, winnerId: THEM, selections: [{ entrantId: THEM, characterId: FOX }] }];
    expect(pickSetCharacter(games, ME)).toBeNull();
  });
});

describe('pickSetCharacter — across every possible set', () => {
  /** Game winners until someone reaches `target`. */
  function sequences(target: number): number[][] {
    const out: number[][] = [];
    const walk = (seq: number[], a: number, b: number) => {
      if (a === target || b === target) return void out.push([...seq]);
      walk([...seq, ME], a + 1, b);
      walk([...seq, THEM], a, b + 1);
    };
    walk([], 0, 0);
    return out;
  }

  /** Every assignment of `chars` characters across `n` games. */
  function picks(n: number, chars: number): number[][] {
    if (n === 0) return [[]];
    return picks(n - 1, chars).flatMap((rest) => Array.from({ length: chars }, (_, c) => [...rest, c + 1]));
  }

  it('always headlines one of the most-played characters', () => {
    // The invariant the whole rule exists to guarantee: the first character can
    // never be one the player used less than another. A rule weighing games won
    // cannot promise this — with wins split evenly across three characters it
    // could headline one played once over one played three times.
    let checked = 0;
    for (const target of [2, 3]) {
      for (const winners of sequences(target)) {
        for (const mine of picks(winners.length, 3)) {
          const games: SetGame[] = winners.map((w, i) => ({
            orderNum: i + 1,
            winnerId: w,
            selections: [
              { entrantId: ME, characterId: mine[i] },
              { entrantId: THEM, characterId: 999 },
            ],
          }));
          const counts = new Map<number, number>();
          for (const c of mine) counts.set(c, (counts.get(c) ?? 0) + 1);

          const primary = pickSetCharacter(games, ME)!;
          expect(counts.get(primary), `picks [${mine}] headlined ${primary}`).toBe(Math.max(...counts.values()));
          checked++;
        }
      }
    }
    // Guards the loops themselves: a bug that generated nothing would pass.
    expect(checked).toBe(3582);
  });
});
