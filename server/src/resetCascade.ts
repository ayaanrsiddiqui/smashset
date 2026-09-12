/** A set as the cascade walk needs to see it; see CASCADE_QUERY in report.ts. */
export interface CascadeSet {
  id: number | string;
  identifier: string;
  state: number;
  slots: { prereqId: string | null; prereqType: string | null }[];
}

const COMPLETED_STATE = 3;

/** start.gg auto-completes a bye, so it is "played" without anyone playing it. */
function isBye(set: CascadeSet): boolean {
  return set.slots.some((slot) => slot.prereqType === 'bye');
}

/**
 * The already-played sets that changing this set's winner will wipe.
 *
 * start.gg will not change a finished set's winner in place; the only route is
 * resetSet, and resetting without cascading would leave the old winner standing
 * in every set they advanced into. The reach is real, and a TO confirming it at
 * a bracket table deserves it named.
 *
 * Must be given sets fetched with `showByes: true`. A losers-bracket slot does
 * not point back at the winners set whose loser drops into it — it points at a
 * bye set in between, and phaseGroup.sets omits those by default. Walking the
 * visible sets alone reports the winner's path only: on the live test bracket
 * that named 2 of the 3 sets a real reset cleared, which on a destructive
 * confirmation is the worst way to be wrong.
 *
 * Byes are traversed but never reported — they are start.gg's bookkeeping, not
 * a result a TO recognises.
 */
export function resetCascade(sets: CascadeSet[], setId: number | string): CascadeSet[] {
  const fedBy = new Map<string, CascadeSet[]>();
  for (const set of sets) {
    for (const slot of set.slots) {
      if (slot.prereqId === null) continue;
      const existing = fedBy.get(slot.prereqId);
      if (existing) existing.push(set);
      else fedBy.set(slot.prereqId, [set]);
    }
  }

  const seen = new Set<string>([String(setId)]);
  const wiped: CascadeSet[] = [];
  const queue = [String(setId)];
  while (queue.length > 0) {
    // A once-reset bracket can carry stale prereq ids that point backwards, so
    // this is a graph walk with a visited set, not a tree walk.
    for (const next of fedBy.get(queue.shift()!) ?? []) {
      const id = String(next.id);
      if (seen.has(id)) continue;
      seen.add(id);
      queue.push(id);
      if (next.state === COMPLETED_STATE && !isBye(next)) wiped.push(next);
    }
  }
  return wiped;
}
