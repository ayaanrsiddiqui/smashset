import type { BracketSet, BracketSlot, PriorResult } from './types';

// A set's own `state` (1 pending / 2 started / 3 completed) only ever
// disagrees with "does every slot have an entrant yet" in one direction —
// state can't reach 2 or 3 without both — so "has an empty slot" alone is a
// safe, sufficient test for "not ready", with no need to also check state.
export function isNotReady(s: BracketSet): boolean {
  return s.slots.some((slot) => slot.entrant === null);
}

// Whether a set can be opened in ReportPanel at all — both a fresh report
// and a correction of an already-completed set are allowed (ReportPanel
// itself has no "already reported" guard, it just trusts what it's given);
// the only real blocker is not knowing who's actually playing yet.
export function isOpenable(s: BracketSet): boolean {
  return !isNotReady(s);
}

export function isWinnerSlot(set: BracketSet, slot: BracketSlot): boolean {
  return set.winnerId !== null && slot.entrant?.id === set.winnerId;
}

// The result already on file for a completed set, so a TO correcting it can
// see what's there before overwriting it — null for anything not actually
// completed, or (defensively) a completed set missing data it should always
// have by the time state reaches 3.
export function priorResultFor(s: BracketSet): PriorResult | null {
  if (s.state !== 3 || s.winnerId === null) return null;
  const [a, b] = s.slots;
  const winner = a.entrant?.id === s.winnerId ? a : b;
  const loser = winner === a ? b : a;
  // Scores are deliberately not required. A disqualification has a real winner
  // but no score at all (start.gg reports it as the bare string "DQ"), and the
  // overwrite warning matters most there — it is the result a TO is most
  // likely to be correcting.
  if (!winner.entrant || !loser.entrant) return null;
  return {
    winnerName: winner.entrant.name,
    loserName: loser.entrant.name,
    winnerScore: winner.score,
    loserScore: loser.score,
  };
}

// Renders a slot's entrant name, or — for a still-empty slot — start.gg's
// own "winner of X"/"loser of X" placeholder convention, resolved from the
// slot's prereq link against every other set already fetched this poll.
// Falls back to a plain "TBD" if that source set isn't in the response (see
// server/src/routes/sets.ts's BRACKET_QUERY comment on the one known case:
// a once-reset bracket's stale Losers-Round-1 prereq ids).
export function slotLabel(slot: BracketSlot, byId: Map<string, BracketSet>): string {
  if (slot.entrant) return slot.entrant.name;
  const source = slot.prereqSetId ? byId.get(slot.prereqSetId) : undefined;
  if (!source) return 'TBD';
  const verb = slot.prereqPlacement === 2 ? 'loser of' : 'winner of';
  return `${verb} ${source.identifier}`;
}

export function bracketSetById(sets: BracketSet[]): Map<string, BracketSet> {
  return new Map(sets.map((s) => [String(s.id), s]));
}
