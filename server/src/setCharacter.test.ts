import { describe, expect, it } from 'vitest';
import { rankSetCharacters, type SetGame } from './setCharacter.js';

const ME = 1;
const THEM = 2;
const FOX = 100;
const FALCO = 200;

/** One game: what each side picked. The rule does not read who won it. */
function game(orderNum: number, mine: number, theirs = FOX): SetGame {
  return { orderNum, characterIdByEntrantId: { [ME]: mine, [THEM]: theirs } };
}

/** The character shown first — what the old single-character rule returned. */
function headline(games: SetGame[], entrantId: number): number | null {
  return rankSetCharacters(games, entrantId)[0] ?? null;
}

describe('rankSetCharacters — which character leads', () => {
  it('shows the one character a player stuck with', () => {
    expect(headline([game(1, FOX), game(2, FOX), game(3, FOX)], ME)).toBe(FOX);
  });

  it('headlines the most-played character, not the one that closed the set', () => {
    // Fox, Fox, Fox, Falco, Falco — a reverse 3-0 won on the counterpick.
    // Falco took two of the three games won, so a rule about credit would
    // headline it; that reads as "mainly Falco", and they played Fox for three
    // of five games. What closed the set is a separate fact.
    expect(headline([game(1, FOX), game(2, FOX), game(3, FOX), game(4, FALCO), game(5, FALCO)], ME)).toBe(FOX);
  });

  it('headlines a counterpick once it is genuinely most of the set', () => {
    expect(headline([game(1, FOX), game(2, FALCO), game(3, FALCO), game(4, FALCO)], ME)).toBe(FALCO);
  });

  it('reads each entrant of a set independently', () => {
    const games: SetGame[] = [
      { orderNum: 1, characterIdByEntrantId: { [ME]: FOX, [THEM]: FALCO } },
      { orderNum: 2, characterIdByEntrantId: { [ME]: FOX, [THEM]: FALCO } },
      { orderNum: 3, characterIdByEntrantId: { [ME]: FOX, [THEM]: FALCO } },
      { orderNum: 4, characterIdByEntrantId: { [ME]: FALCO, [THEM]: FOX } },
      { orderNum: 5, characterIdByEntrantId: { [ME]: FALCO, [THEM]: FOX } },
    ];
    expect(headline(games, ME)).toBe(FOX);
    expect(headline(games, THEM)).toBe(FALCO);
  });

  it('settles an even split on whichever they were playing by the end', () => {
    expect(headline([game(1, FOX), game(2, FALCO), game(3, FOX), game(4, FALCO)], ME)).toBe(FALCO);
  });

  it('ignores the order games arrive in', () => {
    // start.gg does not promise games come back in play order, and the
    // even-split tie-break is meaningless if that is assumed.
    expect(headline([game(2, FALCO), game(1, FOX)], ME)).toBe(FALCO);
  });

  it('reports nothing when the set carries no character data at all', () => {
    // Common: plenty of TOs never report selections, so this is the normal
    // case on a real bracket, not an edge case.
    expect(headline([], ME)).toBeNull();
  });

  it('reports nothing for an entrant who appears in no game', () => {
    expect(headline([{ orderNum: 1, characterIdByEntrantId: { [THEM]: FOX } }], ME)).toBeNull();
  });
});

/** Every assignment of `chars` characters across `n` games. */
function picks(n: number, chars: number): number[][] {
  if (n === 0) return [[]];
  return picks(n - 1, chars).flatMap((rest) => Array.from({ length: chars }, (_, c) => [...rest, c + 1]));
}

describe('rankSetCharacters — across every possible set', () => {
  it('always leads with one of the most-played characters', () => {
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

        const primary = headline(games, ME)!;
        expect(counts.get(primary), `picks [${mine}] headlined ${primary}`).toBe(Math.max(...counts.values()));
        checked++;
      }
    }
    // Guards the loops themselves: a bug generating nothing would still pass.
    expect(checked).toBe(9 + 27 + 81 + 243);
  });
});

describe('rankSetCharacters — the rest of the row', () => {
  it('lists every character a player used, not just the one they used most', () => {
    // The whole point: a set is not one character, because people counterpick.
    expect(rankSetCharacters([game(1, FOX), game(2, FOX), game(3, FALCO)], ME)).toEqual([FOX, FALCO]);
  });

  it('orders them by how much of the set each one was', () => {
    const WOLF = 300;
    // Falco 3, Fox 2, Wolf 1 — regardless of the order they were played in.
    const games = [game(1, FOX), game(2, FALCO), game(3, WOLF), game(4, FALCO), game(5, FALCO), game(6, FOX)];
    expect(rankSetCharacters(games, ME)).toEqual([FALCO, FOX, WOLF]);
  });

  it('breaks a tie the same way further down the row as it does at the front', () => {
    const WOLF = 300;
    // Fox 2, then Falco and Wolf tied on 1 — Wolf was played later, so it
    // comes first of the two, exactly as the even-split rule leads with
    // whichever they finished on.
    const games = [game(1, FOX), game(2, FALCO), game(3, WOLF), game(4, FOX)];
    expect(rankSetCharacters(games, ME)).toEqual([FOX, WOLF, FALCO]);
  });

  it('lists a character once however many games it was played in', () => {
    expect(rankSetCharacters([game(1, FOX), game(2, FOX), game(3, FOX)], ME)).toEqual([FOX]);
  });

  it('reads each entrant of a set independently', () => {
    const games: SetGame[] = [
      { orderNum: 1, characterIdByEntrantId: { [ME]: FOX, [THEM]: FALCO } },
      { orderNum: 2, characterIdByEntrantId: { [ME]: FALCO, [THEM]: FALCO } },
    ];
    expect(rankSetCharacters(games, ME)).toEqual([FALCO, FOX]);
    expect(rankSetCharacters(games, THEM)).toEqual([FALCO]);
  });

  it('reports nothing at all when the set carries no character data', () => {
    expect(rankSetCharacters([], ME)).toEqual([]);
    expect(rankSetCharacters([{ orderNum: 1, characterIdByEntrantId: { [THEM]: FOX } }], ME)).toEqual([]);
  });

  it('never drops or invents a character, and never lets a lesser-played one come first', () => {
    // Same exhaustive sweep as above, now over the whole row rather than its
    // first entry: every distinct character played appears exactly once, and
    // the counts down the row never increase.
    let checked = 0;
    for (const length of [2, 3, 4, 5]) {
      for (const mine of picks(length, 3)) {
        const games: SetGame[] = mine.map((c, i) => ({ orderNum: i + 1, characterIdByEntrantId: { [ME]: c } }));
        const counts = new Map<number, number>();
        for (const c of mine) counts.set(c, (counts.get(c) ?? 0) + 1);

        const ranked = rankSetCharacters(games, ME);
        expect(new Set(ranked), `picks [${mine}]`).toEqual(new Set(counts.keys()));
        expect(ranked.length, `picks [${mine}] listed a character twice`).toBe(counts.size);
        for (let i = 1; i < ranked.length; i++) {
          expect(counts.get(ranked[i - 1])!, `picks [${mine}] ordered ${ranked}`).toBeGreaterThanOrEqual(counts.get(ranked[i])!);
        }
        checked++;
      }
    }
    expect(checked).toBe(9 + 27 + 81 + 243);
  });
});
