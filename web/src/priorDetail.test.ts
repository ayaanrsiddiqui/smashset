import { describe, expect, it } from 'vitest';
import { derivePriorState } from './priorDetail';
import type { Character, SetDetail, Stage } from './types';

const BOWSER: Character = { id: 1273, name: 'Bowser' };
const FALCON: Character = { id: 1274, name: 'Captain Falcon' };
const CHARACTERS = [BOWSER, FALCON];
const FINAL_DEST: Stage = { id: 51, name: 'Final Destination' };
const STAGES = [FINAL_DEST];

const WINNER_ID = 101;
const LOSER_ID = 102;

describe('derivePriorState', () => {
  it('builds a W/L shorthand relative to the given winner, in orderNum order regardless of input order', () => {
    const detail: SetDetail = {
      games: [
        { orderNum: 2, winnerEntrantId: LOSER_ID, stageId: null, characterIdByEntrantId: {} },
        { orderNum: 1, winnerEntrantId: WINNER_ID, stageId: null, characterIdByEntrantId: {} },
        { orderNum: 3, winnerEntrantId: WINNER_ID, stageId: null, characterIdByEntrantId: {} },
      ],
    };
    const result = derivePriorState(detail, WINNER_ID, LOSER_ID, CHARACTERS, STAGES);
    expect(result?.shorthand).toBe('WLW');
    expect(result?.requiredWins).toBe(2);
  });

  it('resolves each side\'s character pick by id, independent of the game\'s own winner', () => {
    const detail: SetDetail = {
      games: [
        {
          orderNum: 1,
          winnerEntrantId: WINNER_ID,
          stageId: FINAL_DEST.id,
          characterIdByEntrantId: { [WINNER_ID]: BOWSER.id, [LOSER_ID]: FALCON.id },
        },
      ],
    };
    const result = derivePriorState(detail, WINNER_ID, LOSER_ID, CHARACTERS, STAGES);
    expect(result?.charsByGame[1]).toEqual({ winner: BOWSER, loser: FALCON });
    expect(result?.stagesByGame[1]).toEqual(FINAL_DEST);
  });

  it('leaves a game\'s character/stage null when no pick was recorded for it, rather than guessing', () => {
    const detail: SetDetail = {
      games: [{ orderNum: 1, winnerEntrantId: WINNER_ID, stageId: null, characterIdByEntrantId: {} }],
    };
    const result = derivePriorState(detail, WINNER_ID, LOSER_ID, CHARACTERS, STAGES);
    expect(result?.charsByGame[1]).toEqual({ winner: null, loser: null });
    expect(result?.stagesByGame[1]).toBeNull();
  });

  it('falls back to null for a character/stage id that isn\'t in the given characters/stages list', () => {
    const detail: SetDetail = {
      games: [{ orderNum: 1, winnerEntrantId: WINNER_ID, stageId: 999, characterIdByEntrantId: { [WINNER_ID]: 999 } }],
    };
    const result = derivePriorState(detail, WINNER_ID, LOSER_ID, CHARACTERS, STAGES);
    expect(result?.charsByGame[1].winner).toBeNull();
    expect(result?.stagesByGame[1]).toBeNull();
  });

  it('returns null for a set with no game records at all (e.g. a quick-reported set)', () => {
    expect(derivePriorState({ games: [] }, WINNER_ID, LOSER_ID, CHARACTERS, STAGES)).toBeNull();
  });
});
