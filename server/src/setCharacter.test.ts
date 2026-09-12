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

describe('pickSetCharacter — the set winner', () => {
  it('shows the one character a player stuck with', () => {
    const games = [game(1, ME, FOX), game(2, THEM, FOX), game(3, ME, FOX)];
    expect(pickSetCharacter(games, ME, ME)).toBe(FOX);
  });

  it('shows the most-used character when the set also ended on it', () => {
    // Fox twice and Falco once, and Fox took the deciding game.
    const games = [game(1, ME, FOX), game(2, THEM, FALCO), game(3, ME, FOX)];
    expect(pickSetCharacter(games, ME, ME)).toBe(FOX);
  });

  it('shows what actually won games when that is not the most-used character', () => {
    // Opened on Fox, lost two, switched to Falco and won out. Fox is the
    // most-played character and would be the wrong thing to show.
    const games = [game(1, ME, FOX), game(2, THEM, FOX), game(3, THEM, FOX), game(4, ME, FALCO), game(5, ME, FALCO)];
    expect(pickSetCharacter(games, ME, ME)).toBe(FALCO);
  });

  it('breaks a most-used tie with the character that closed the set', () => {
    // Two games each, but Falco won two of them and Fox only the last one.
    // Counting wins alone would say Falco; the tie-break says Fox, because
    // that is what they were playing when the set ended.
    const games = [game(1, ME, FALCO), game(2, ME, FALCO), game(3, THEM, FOX), game(4, ME, FOX)];
    expect(pickSetCharacter(games, ME, ME)).toBe(FOX);
  });

  // A reverse 3-0 is where the two clauses pull apart, so all three of these
  // are L L W W W with the same scoreline and different pick patterns.
  describe('a reverse 3-0', () => {
    const reverse = (p1: number, p2: number, p3: number, p4: number, p5: number) => [
      game(1, THEM, p1),
      game(2, THEM, p2),
      game(3, ME, p3),
      game(4, ME, p4),
      game(5, ME, p5),
    ];

    it('does not credit a counterpick that only took the last game', () => {
      // Fox for four games, Falco to close. Falco won one game; Fox won two
      // and was played four times, so the set is Fox's.
      expect(pickSetCharacter(reverse(FOX, FOX, FOX, FOX, FALCO), ME, ME)).toBe(FOX);
    });

    it('credits the character they came back to, even though it won fewer games', () => {
      // Fox, Fox, Falco, Falco, Fox. Falco won two games to Fox's one, so
      // counting wins alone says Falco — but they played Fox most and closed
      // the set on it, which is the case the most-used clause exists for.
      expect(pickSetCharacter(reverse(FOX, FOX, FALCO, FALCO, FOX), ME, ME)).toBe(FOX);
    });

    it('credits the counterpick they switched to and finished on', () => {
      // Fox, Fox, Fox, Falco, Falco. Fox is still the most-played character,
      // but the set did not end on it and Falco won two of the three games.
      expect(pickSetCharacter(reverse(FOX, FOX, FOX, FALCO, FALCO), ME, ME)).toBe(FALCO);
    });
  });

  it('falls through to wins when a most-used tie cannot be settled', () => {
    // Fox and Falco tie on games played and the set closed on neither, so
    // nothing separates the tied pair — which character won games does.
    const games = [game(1, ME, FOX), game(2, THEM, FOX), game(3, ME, FALCO), game(4, THEM, FALCO), game(5, ME, MARTH)];
    expect(pickSetCharacter(games, ME, ME)).toBe(MARTH);
  });
});

describe('pickSetCharacter — the set loser', () => {
  it('shows what they played most, not the one game they stole', () => {
    // They took game one on Falco and then lost twice on Fox. Crediting the
    // set to Falco would overstate a single won game.
    const games = [game(1, ME, FALCO), game(2, THEM, FOX), game(3, THEM, FOX)];
    expect(pickSetCharacter(games, ME, THEM)).toBe(FOX);
  });

  it('shows what they played most even when another character won them games', () => {
    // Falco won them two games and Fox none, but they spent three games on
    // Fox. For a loser there is no closing character to weigh it against, so
    // play time is the safer signal.
    const games = [game(1, ME, FALCO), game(2, ME, FALCO), game(3, THEM, FOX), game(4, THEM, FOX), game(5, THEM, FOX)];
    expect(pickSetCharacter(games, ME, THEM)).toBe(FOX);
  });

  it('shows the most-played character for a player who won nothing', () => {
    // Swept, so there is no winning character to point at. Showing nothing
    // would read as missing data rather than as a whitewash.
    const games = [game(1, THEM, FOX), game(2, THEM, FOX), game(3, THEM, FALCO)];
    expect(pickSetCharacter(games, ME, THEM)).toBe(FOX);
  });
});

describe('pickSetCharacter — both sides of one set', () => {
  it('applies a different rule to each player', () => {
    // Winner mostly played Fox and took the decider on Marth; loser won two on
    // Falco before losing out on Fox. Same games, different questions.
    const games = [
      { orderNum: 1, winnerId: THEM, selections: [{ entrantId: ME, characterId: FOX }, { entrantId: THEM, characterId: FALCO }] },
      { orderNum: 2, winnerId: THEM, selections: [{ entrantId: ME, characterId: FOX }, { entrantId: THEM, characterId: FALCO }] },
      { orderNum: 3, winnerId: ME, selections: [{ entrantId: ME, characterId: FOX }, { entrantId: THEM, characterId: FOX }] },
      { orderNum: 4, winnerId: ME, selections: [{ entrantId: ME, characterId: FOX }, { entrantId: THEM, characterId: FOX }] },
      { orderNum: 5, winnerId: ME, selections: [{ entrantId: ME, characterId: MARTH }, { entrantId: THEM, characterId: FOX }] },
    ];
    // Winner: most-used is Fox but the set closed on Marth, so those disagree
    // and wins decide — Fox won two games to Marth's one. Snatching a decider
    // on a counterpick does not relabel a set they otherwise won on Fox.
    expect(pickSetCharacter(games, ME, ME)).toBe(FOX);
    // Loser: three games on Fox against two on Falco, so the set is Fox's —
    // the winner's closing-character clause plays no part for them.
    expect(pickSetCharacter(games, THEM, ME)).toBe(FOX);
  });
});

describe('pickSetCharacter — missing data', () => {
  it('reports nothing when the set carries no character data at all', () => {
    // Common: plenty of TOs never report selections, so this is the normal
    // case on a real bracket, not an edge case.
    expect(pickSetCharacter([], ME, ME)).toBeNull();
  });

  it('reports nothing for an entrant who appears in no game', () => {
    const games = [{ orderNum: 1, winnerId: THEM, selections: [{ entrantId: THEM, characterId: FOX }] }];
    expect(pickSetCharacter(games, ME, THEM)).toBeNull();
  });

  it('still answers for a set with no recorded winner', () => {
    const games = [game(1, ME, FOX), game(2, THEM, FALCO)];
    expect(pickSetCharacter(games, ME, null)).toBe(FOX);
  });

  it('ignores the order games arrive in', () => {
    // start.gg does not promise games come back in play order, and "the last
    // game of the set" is meaningless if that is assumed.
    const inOrder = [game(1, ME, FOX), game(2, THEM, FOX), game(3, ME, FALCO)];
    const shuffled = [inOrder[2], inOrder[0], inOrder[1]];
    expect(pickSetCharacter(shuffled, ME, ME)).toBe(pickSetCharacter(inOrder, ME, ME));
  });
});
