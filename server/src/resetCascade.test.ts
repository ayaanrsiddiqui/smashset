import { describe, expect, it } from 'vitest';
import { resetCascade, type CascadeSet } from './resetCascade.js';

/**
 * Shapes taken from the real fireslam23test bracket (phase group 3419667) on
 * 2026-09-12, not invented. The first version of this walk was tested against
 * a fixture where a losers set pointed straight back at the winners set its
 * loser fell out of, which is simply not how start.gg models it — so the test
 * passed while the code under-reported a destructive action.
 */
const A = '106400569';
const BYE_AN = '106400594'; // Losers Round 1 bye: slot 1 fed by A, slot 2 a bye
const R = '106400602';
const I = '106400577';
const M = '106400581';

function set(id: string, identifier: string, prereqs: [string | null, string | null], over: Partial<CascadeSet> = {}): CascadeSet {
  return {
    id,
    identifier,
    state: 3,
    slots: prereqs.map((prereqId) => ({ prereqId, prereqType: prereqId === null ? null : 'set' })),
    ...over,
  };
}

/** The real shape: A's loser reaches R only through a bye set start.gg hides. */
function bracket(): CascadeSet[] {
  return [
    set(A, 'A', [null, null]),
    set(I, 'I', [A, '106400570']),
    set(M, 'M', [I, '106400578']),
    {
      id: BYE_AN,
      identifier: 'AN',
      state: 3,
      slots: [
        { prereqId: A, prereqType: 'set' },
        { prereqId: '106400586', prereqType: 'bye' },
      ],
    },
    set(R, 'R', [BYE_AN, '106400595']),
  ];
}

describe('what changing a winner will unmake', () => {
  it('reaches the losers bracket through the bye set in between', () => {
    // Verified live: resetting A cleared I, M and R. R is only reachable via
    // the bye, so a walk that cannot see byes names two of the three.
    expect(resetCascade(bracket(), A).map((s) => s.identifier).sort()).toEqual(['I', 'M', 'R']);
  });

  it('never names a bye, which is bookkeeping rather than a result', () => {
    expect(resetCascade(bracket(), A).map((s) => s.identifier)).not.toContain('AN');
  });

  it('follows the winner forward, transitively', () => {
    expect(resetCascade(bracket(), I).map((s) => s.identifier)).toEqual(['M']);
  });

  it('leaves out sets nobody has played yet — there is nothing there to unmake', () => {
    const sets = bracket().map((s) => (s.identifier === 'M' ? { ...s, state: 1 } : s));
    expect(resetCascade(sets, A).map((s) => s.identifier).sort()).toEqual(['I', 'R']);
  });

  it('reaches a played set through an unplayed one in between', () => {
    // The middle set carries the entrant onward even with no result of its own.
    const sets = bracket().map((s) => (s.identifier === 'I' ? { ...s, state: 2 } : s));
    expect(resetCascade(sets, A).map((s) => s.identifier).sort()).toEqual(['M', 'R']);
  });

  it('does not include the set being corrected', () => {
    expect(resetCascade([set(A, 'A', [null, null])], A)).toEqual([]);
  });

  it('survives a bracket whose prereq links form a cycle', () => {
    // Stale prereq ids are real on a once-reset bracket; a cycle must not hang.
    const sets = [set('1', 'A', ['2', null]), set('2', 'B', ['1', null])];
    expect(resetCascade(sets, '1').map((s) => s.identifier)).toEqual(['B']);
  });
});
