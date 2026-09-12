import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ensureMainComputed, tallyMainCharacter, type RawPlayerSet } from './mainLookup.js';

const gqlMock = vi.fn();
vi.mock('./startgg.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./startgg.js')>()),
  gql: (...args: unknown[]) => gqlMock(...args),
}));

// The computed path's write, not upsertPlayerMain — mocking the wrong one
// leaves the real query running against the test database from here.
const insertComputedMainMock = vi.fn().mockResolvedValue(true);
vi.mock('./db/mains.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./db/mains.js')>()),
  insertComputedPlayerMain: (...args: unknown[]) => insertComputedMainMock(...args),
}));

const PLAYER_ID = 1000;

function makeSet(opts: {
  myEntrantId: number;
  opponentEntrantId: number;
  opponentPlayerId?: number;
  myCharacterIds: (number | null)[]; // one per game, in order
  opponentCharacterId?: number;
}): RawPlayerSet {
  return {
    event: { videogame: { id: 1386 } },
    slots: [
      { entrant: { id: opts.myEntrantId, participants: [{ player: { id: PLAYER_ID } }] } },
      { entrant: { id: opts.opponentEntrantId, participants: [{ player: { id: opts.opponentPlayerId ?? 9999 } }] } },
    ],
    games: opts.myCharacterIds.map((myChar) => ({
      selections: [
        ...(myChar != null ? [{ entrant: { id: opts.myEntrantId }, character: { id: myChar } }] : []),
        ...(opts.opponentCharacterId != null
          ? [{ entrant: { id: opts.opponentEntrantId }, character: { id: opts.opponentCharacterId } }]
          : []),
      ],
    })),
  };
}

describe('tallyMainCharacter', () => {
  it('returns null for no sets at all', () => {
    expect(tallyMainCharacter([], PLAYER_ID)).toBeNull();
  });

  it('picks the clear majority character across sets', () => {
    const sets = [
      makeSet({ myEntrantId: 1, opponentEntrantId: 2, myCharacterIds: [10, 10] }), // most recent
      makeSet({ myEntrantId: 3, opponentEntrantId: 4, myCharacterIds: [20] }),
    ];
    expect(tallyMainCharacter(sets, PLAYER_ID)).toEqual({ characterId: 10, gamesTallied: 2 });
  });

  it('breaks a tie toward the more recently-tallied character', () => {
    // Both characters end up tied at 1 game — character 20 was tallied
    // first because its set is more recent (first in the array).
    const sets = [
      makeSet({ myEntrantId: 1, opponentEntrantId: 2, myCharacterIds: [20] }), // most recent
      makeSet({ myEntrantId: 3, opponentEntrantId: 4, myCharacterIds: [10] }), // older
    ];
    expect(tallyMainCharacter(sets, PLAYER_ID)).toEqual({ characterId: 20, gamesTallied: 1 });
  });

  it('skips a game with no selection for this player instead of miscounting it', () => {
    const sets = [makeSet({ myEntrantId: 1, opponentEntrantId: 2, myCharacterIds: [10, null, 10] })];
    expect(tallyMainCharacter(sets, PLAYER_ID)).toEqual({ characterId: 10, gamesTallied: 2 });
  });

  it('skips a set entirely when this player cannot be resolved among its slots', () => {
    const unresolvable: RawPlayerSet = {
      event: { videogame: { id: 1386 } },
      slots: [
        { entrant: { id: 1, participants: [{ player: { id: 111 } }] } },
        { entrant: { id: 2, participants: [{ player: { id: 222 } }] } },
      ],
      games: [{ selections: [{ entrant: { id: 1 }, character: { id: 10 } }] }],
    };
    const sets = [unresolvable, makeSet({ myEntrantId: 3, opponentEntrantId: 4, myCharacterIds: [20] })];
    expect(tallyMainCharacter(sets, PLAYER_ID)).toEqual({ characterId: 20, gamesTallied: 1 });
  });

  it("never tallies the opponent's character selections as this player's own, even when the opponent's pick would otherwise dominate", () => {
    // My true main is character 10 (3 games total, across two sets). Three
    // different opponents all happen to play character 999 against me — if
    // a bug tallied both sides of each game, 999 would wrongly accumulate 4
    // selections (more than 10's 3) and win instead.
    const sets = [
      makeSet({ myEntrantId: 1, opponentEntrantId: 2, opponentPlayerId: 501, myCharacterIds: [10, 10], opponentCharacterId: 999 }),
      makeSet({ myEntrantId: 3, opponentEntrantId: 4, opponentPlayerId: 502, myCharacterIds: [20], opponentCharacterId: 999 }),
      makeSet({ myEntrantId: 5, opponentEntrantId: 6, opponentPlayerId: 503, myCharacterIds: [10], opponentCharacterId: 999 }),
    ];
    const result = tallyMainCharacter(sets, PLAYER_ID);
    expect(result?.characterId).not.toBe(999);
    expect(result).toEqual({ characterId: 10, gamesTallied: 3 });
  });
});

describe('ensureMainComputed — failure backoff', () => {
  beforeEach(() => {
    gqlMock.mockReset();
    insertComputedMainMock.mockReset();
    insertComputedMainMock.mockResolvedValue(true);
  });

  it('does not re-fire a failed lookup on the next poll', async () => {
    gqlMock.mockRejectedValue(new Error('rate limited'));
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});

    ensureMainComputed('token', 4242, 1386);
    await vi.waitFor(() => expect(errors).toHaveBeenCalled());
    expect(gqlMock).toHaveBeenCalledTimes(1);

    // A failed lookup writes no row, so every later poll asks again — which
    // is what turned a rate limit into a storm that sustained itself.
    ensureMainComputed('token', 4242, 1386);
    ensureMainComputed('token', 4242, 1386);
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(gqlMock).toHaveBeenCalledTimes(1);
    errors.mockRestore();
  });

  it('still looks up a player whose lookup has not failed', async () => {
    gqlMock.mockResolvedValue({ player: { sets: { nodes: [] } } });

    ensureMainComputed('token', 4343, 1386);
    await vi.waitFor(() => expect(insertComputedMainMock).toHaveBeenCalled());

    expect(gqlMock).toHaveBeenCalledTimes(1);
  });
});
