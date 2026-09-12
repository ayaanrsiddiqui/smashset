import { describe, expect, it } from 'vitest';
import { resetCascade } from './resetCascade';
import type { BracketSet, BracketSlot } from './types';

function slot(entrantId: number | null, prereqSetId: string | null, placement: 1 | 2 | null = 1): BracketSlot {
  return {
    entrant: entrantId === null ? null : { id: entrantId, name: `E${entrantId}` },
    score: null,
    characterId: null,
    prereqSetId,
    prereqPlacement: prereqSetId === null ? null : placement,
    progressionOrigin: null,
  };
}

function set(
  id: string,
  slots: [BracketSlot, BracketSlot],
  over: Partial<BracketSet> = {}
): BracketSet {
  return {
    id,
    identifier: id,
    round: 1,
    fullRoundText: `Round ${id}`,
    state: 3,
    winnerId: slots[0].entrant?.id ?? null,
    lPlacement: null,
    completedAt: 1,
    slots,
    winnerAdvancesToPhase: null,
    loserAdvancesToPhase: null,
    ...over,
  };
}

describe('what changing a winner will unmake', () => {
  it('follows the winner forward, transitively', () => {
    // A -> I -> M, every one of them already played. Verified live on
    // start.gg: resetting A cleared I and M too.
    const sets = [
      set('A', [slot(1, null), slot(2, null)]),
      set('I', [slot(1, 'A'), slot(9, null)]),
      set('M', [slot(1, 'I'), slot(13, null)]),
    ];

    expect(resetCascade(sets, 'A').map((s) => s.identifier)).toEqual(['I', 'M']);
  });

  it('follows the loser into the losers bracket as well', () => {
    // The case that surprised me on the live bracket: resetting a winners-round
    // set also cleared the losers set its loser had dropped into.
    const sets = [
      set('A', [slot(1, null), slot(2, null)]),
      set('I', [slot(1, 'A', 1), slot(9, null)]),
      set('R', [slot(2, 'A', 2), slot(8, null)]),
    ];

    expect(resetCascade(sets, 'A').map((s) => s.identifier).sort()).toEqual(['I', 'R']);
  });

  it('leaves out sets nobody has played yet — there is nothing there to unmake', () => {
    const sets = [
      set('A', [slot(1, null), slot(2, null)]),
      set('I', [slot(1, 'A'), slot(9, null)], { state: 1, winnerId: null }),
    ];

    expect(resetCascade(sets, 'A')).toEqual([]);
  });

  it('does not include the set being corrected', () => {
    const sets = [set('A', [slot(1, null), slot(2, null)])];
    expect(resetCascade(sets, 'A')).toEqual([]);
  });

  it('reaches a played set through an unplayed one in between', () => {
    // The middle set has no result of its own, but it still carries the
    // entrant forward, so what is beyond it is genuinely at risk.
    const sets = [
      set('A', [slot(1, null), slot(2, null)]),
      set('I', [slot(1, 'A'), slot(9, null)], { state: 2, winnerId: null }),
      set('M', [slot(1, 'I'), slot(13, null)]),
    ];

    expect(resetCascade(sets, 'A').map((s) => s.identifier)).toEqual(['M']);
  });

  it('survives a bracket whose prereq links form a cycle', () => {
    // Stale prereq ids are a real thing on a once-reset bracket (see
    // slotLabel's comment). A cycle must not hang the phone.
    const sets = [
      set('A', [slot(1, 'B'), slot(2, null)]),
      set('B', [slot(3, 'A'), slot(4, null)]),
    ];

    expect(resetCascade(sets, 'A').map((s) => s.identifier)).toEqual(['B']);
  });
});
