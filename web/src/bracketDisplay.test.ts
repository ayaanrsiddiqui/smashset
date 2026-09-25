import { describe, expect, it } from 'vitest';
import { bracketSetById, isNotReady, isOpenable, isUnreachedGrandFinalReset, isWinnerSlot, priorResultFor, slotLabel } from './bracketDisplay';
import type { BracketSet, BracketSlot } from './types';

function slot(entrantId: number | null, score: number | null = null, prereqSetId: string | null = null, prereqPlacement: 1 | 2 | null = null): BracketSlot {
  return {
    entrant: entrantId !== null ? { id: entrantId, name: `P${entrantId}` } : null,
    score,
    characterIds: [],
    prereqSetId,
    prereqPlacement,
    progressionOrigin: null,
        seedNum: null,
  };
}

function set(overrides: Partial<BracketSet> & { slots: [BracketSlot, BracketSlot] }): BracketSet {
  return {
    id: 1,
    identifier: 'A',
    round: 1,
    fullRoundText: 'Winners Round 1',
    state: 1,
    winnerId: null,
    lPlacement: null,
    completedAt: null,
    winnerAdvancesToPhase: null,
    loserAdvancesToPhase: null,
    ...overrides,
  };
}

describe('isNotReady / isOpenable', () => {
  it('a set with two real entrants is ready and openable, regardless of state', () => {
    const completed = set({ state: 3, winnerId: 101, slots: [slot(101, 2), slot(102, 0)] });
    const pending = set({ state: 1, slots: [slot(101), slot(102)] });
    for (const s of [completed, pending]) {
      expect(isNotReady(s)).toBe(false);
      expect(isOpenable(s)).toBe(true);
    }
  });

  it('a set with any empty slot is not ready and not openable', () => {
    const s = set({ slots: [slot(101), slot(null)] });
    expect(isNotReady(s)).toBe(true);
    expect(isOpenable(s)).toBe(false);
  });
});

describe('isWinnerSlot', () => {
  it('identifies the slot matching winnerId', () => {
    const s = set({ state: 3, winnerId: 101, slots: [slot(101, 2), slot(102, 0)] });
    expect(isWinnerSlot(s, s.slots[0])).toBe(true);
    expect(isWinnerSlot(s, s.slots[1])).toBe(false);
  });

  it('is false for every slot when the set has no winner yet', () => {
    const s = set({ slots: [slot(101), slot(102)] });
    expect(isWinnerSlot(s, s.slots[0])).toBe(false);
    expect(isWinnerSlot(s, s.slots[1])).toBe(false);
  });
});

describe('slotLabel', () => {
  it("renders a real entrant's name", () => {
    const byId = new Map<string, BracketSet>();
    expect(slotLabel(slot(101), byId)).toBe('P101');
  });

  it('resolves an empty slot to "winner of <identifier>" when prereqPlacement is 1', () => {
    const source = set({ id: 5, identifier: 'M', slots: [slot(201), slot(202)] });
    const byId = bracketSetById([source]);
    expect(slotLabel(slot(null, null, '5', 1), byId)).toBe('winner of M');
  });

  it('resolves an empty slot to "loser of <identifier>" when prereqPlacement is 2', () => {
    const source = set({ id: 5, identifier: 'M', slots: [slot(201), slot(202)] });
    const byId = bracketSetById([source]);
    expect(slotLabel(slot(null, null, '5', 2), byId)).toBe('loser of M');
  });

  it('falls back to "TBD" when the prereq set is not in the given map', () => {
    const byId = new Map<string, BracketSet>();
    expect(slotLabel(slot(null, null, '999', 1), byId)).toBe('TBD');
  });
});

describe('priorResultFor', () => {
  it('returns the winner/loser names and scores for a completed set', () => {
    const s = set({ state: 3, winnerId: 101, slots: [slot(101, 2), slot(102, 0)] });
    expect(priorResultFor(s)).toEqual({ winnerName: 'P101', loserName: 'P102', winnerScore: 2, loserScore: 0 });
  });

  it('resolves winner/loser correctly regardless of which slot holds the winner', () => {
    const s = set({ state: 3, winnerId: 102, slots: [slot(101, 1), slot(102, 3)] });
    expect(priorResultFor(s)).toEqual({ winnerName: 'P102', loserName: 'P101', winnerScore: 3, loserScore: 1 });
  });

  it('returns null for a set that is not completed', () => {
    const s = set({ state: 1, slots: [slot(101), slot(102)] });
    expect(priorResultFor(s)).toBeNull();
  });

  it('returns null (defensively) for a "completed" set with no winnerId', () => {
    expect(priorResultFor(set({ state: 3, winnerId: null, slots: [slot(101, 2), slot(102, 0)] }))).toBeNull();
  });

  it('still reports a scoreless result, so a disqualification keeps its overwrite warning', () => {
    // start.gg gives a DQ a real winner but no score at all. Dropping the
    // warning here would leave a TO overwriting a recorded result with no
    // indication one existed — and a DQ is among the likeliest to be corrected.
    expect(priorResultFor(set({ state: 3, winnerId: 101, slots: [slot(101, null), slot(102, null)] }))).toEqual({
      winnerName: 'P101',
      loserName: 'P102',
      winnerScore: null,
      loserScore: null,
    });
  });
});

describe('the Grand Final Reset that usually never happens', () => {
  function resetSet(over: Partial<BracketSet> = {}): BracketSet {
    return {
      id: 1,
      identifier: 'Q',
      round: 6,
      fullRoundText: 'Grand Final Reset',
      state: 1,
      winnerId: null,
      lPlacement: null,
      completedAt: null,
      slots: [
        { entrant: null, score: null, characterIds: [], prereqSetId: 'P', prereqPlacement: 1, progressionOrigin: null, seedNum: null },
        { entrant: null, score: null, characterIds: [], prereqSetId: 'P', prereqPlacement: 2, progressionOrigin: null, seedNum: null },
      ],
      winnerAdvancesToPhase: null,
      loserAdvancesToPhase: null,
      ...over,
    };
  }

  it('is hidden while nobody has been advanced into it', () => {
    expect(isUnreachedGrandFinalReset(resetSet())).toBe(true);
  });

  it('appears as soon as the reset is actually reached', () => {
    const filled = resetSet();
    filled.slots[0] = { ...filled.slots[0], entrant: { id: 1, name: 'Ada' } };
    filled.slots[1] = { ...filled.slots[1], entrant: { id: 2, name: 'mudd' } };

    expect(isUnreachedGrandFinalReset(filled)).toBe(false);
  });

  it('leaves the Grand Final itself alone, which always happens', () => {
    expect(isUnreachedGrandFinalReset(resetSet({ fullRoundText: 'Grand Final' }))).toBe(false);
  });

  it('leaves every other unplayed set alone — only the reset is conditional', () => {
    expect(isUnreachedGrandFinalReset(resetSet({ fullRoundText: 'Losers Quarter-Final' }))).toBe(false);
  });
});
