import type { BracketSet } from './types';

/**
 * The already-played sets that changing this set's winner will wipe.
 *
 * start.gg will not change a finished set's winner in place; the only route is
 * resetSet, and resetting without cascading leaves the old winner standing in
 * every set they advanced into. So the destructive reach is real, and a TO
 * confirming it at a bracket table deserves to see it named rather than
 * described.
 *
 * Verified live on 2026-09-12: resetting one Winners Round 1 set cleared the
 * Winners Quarter-Final it fed, the Winners Semi beyond that, AND the losers
 * set its loser had dropped into — which is why this walks slots by their
 * prereq link regardless of placement rather than following the winner alone.
 *
 * Traversal continues through sets that have not been played, because they
 * still carry an entrant onward to ones that have; only played sets are
 * reported, since an unplayed set has no result to lose.
 */
export function resetCascade(sets: BracketSet[], setId: number | string): BracketSet[] {
  const fedBy = new Map<string, BracketSet[]>();
  for (const set of sets) {
    for (const slot of set.slots) {
      if (slot.prereqSetId === null) continue;
      const existing = fedBy.get(slot.prereqSetId);
      if (existing) existing.push(set);
      else fedBy.set(slot.prereqSetId, [set]);
    }
  }

  const seen = new Set<string>([String(setId)]);
  const downstream: BracketSet[] = [];
  const queue = [String(setId)];
  while (queue.length > 0) {
    // A once-reset bracket can carry stale prereq ids that point backwards, so
    // this is a graph walk with a visited set, not a tree walk.
    for (const next of fedBy.get(queue.shift()!) ?? []) {
      const id = String(next.id);
      if (seen.has(id)) continue;
      seen.add(id);
      queue.push(id);
      if (next.state === 3) downstream.push(next);
    }
  }
  return downstream;
}
