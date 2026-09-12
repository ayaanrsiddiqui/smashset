import { gql } from './startgg.js';
import { getUserById } from './db/users.js';
import { publishPoolChanged, subscriberUserIds } from './poolEvents.js';

/**
 * One change detector per pool being watched, instead of every TO polling it.
 *
 * Today each client asks start.gg for the whole pool every few seconds, so the
 * request count scales with how many TOs are looking — and almost every one of
 * those requests returns exactly what the last did. A single detector asks
 * once per tick no matter how many are watching, and the clients only fetch
 * when something actually moved.
 *
 * It reports rather than distributes: it publishes "this pool changed" and
 * every client refetches with its own token. That keeps start.gg deciding what
 * each TO may see, which is the whole reason the events carry no set data.
 *
 * Not built on SetFilters.updatedAfter, which looks made for this and is not:
 * measured against a live change on 2026-09-12, the filter did not report a set
 * that had genuinely updated until 60-90 seconds later, while Set.updatedAt on
 * the set itself was correct immediately. A detector that slow would be worse
 * than the polling it replaces.
 */
const PULSE_INTERVAL_MS = 4_000;
const PULSE_BASE_COST = 3;
/** Measured live: all scalars on the node, ~0.97 objects per set. */
const PULSE_MAX_COST_PER_SET = 2;
const COMPLEXITY_BUDGET = 900;
/** Enough for a 230-set bracket in one request; see fetchPulse's paging. */
const PULSE_PER_PAGE = Math.floor((COMPLEXITY_BUDGET - PULSE_BASE_COST) / PULSE_MAX_COST_PER_SET);

// Every field is a scalar on the set, so the response costs about one object
// per set rather than the ~6 the live bracket query pays for entrants.
const PULSE_QUERY = /* GraphQL */ `
  query PhaseGroupPulse($phaseGroupId: ID!, $page: Int!, $perPage: Int!) {
    phaseGroup(id: $phaseGroupId) {
      id
      sets(page: $page, perPage: $perPage) {
        pageInfo {
          totalPages
        }
        nodes {
          id
          state
          winnerId
          displayScore
        }
      }
    }
  }
`;

interface PulseResult {
  phaseGroup: {
    sets: {
      pageInfo: { totalPages: number };
      nodes: { id: number | string; state: number; winnerId: number | null; displayScore: string | null }[] | null;
    };
  } | null;
}

interface Watch {
  timer: ReturnType<typeof setInterval>;
  /** What the pool looked like last tick; null until the first succeeds. */
  fingerprint: string | null;
  /** Round-robin position, so no single TO's token carries the whole pool. */
  nextTokenIndex: number;
  ticking: boolean;
}

const watches = new Map<string, Watch>();

async function fetchPulse(accessToken: string, phaseGroupId: string): Promise<string> {
  const parts: string[] = [];
  let page = 1;
  while (true) {
    const data = await gql<PulseResult>(accessToken, PULSE_QUERY, { phaseGroupId, page, perPage: PULSE_PER_PAGE });
    const sets = data.phaseGroup?.sets;
    for (const node of sets?.nodes ?? []) {
      parts.push(`${node.id}:${node.state}:${node.winnerId ?? ''}:${node.displayScore ?? ''}`);
    }
    if (page >= (sets?.pageInfo.totalPages ?? 1)) break;
    page += 1;
  }
  // Sorted so a change in the order start.gg returns sets is not mistaken for
  // a change to the sets themselves.
  return parts.sort().join('|');
}

/**
 * A token belonging to someone currently watching this pool, read fresh rather
 * than captured when they subscribed — an SSE connection outlives the access
 * token it was opened with, and the auth middleware writes refreshed ones back.
 */
async function tokenForTick(phaseGroupId: string, watch: Watch): Promise<string | null> {
  const userIds = subscriberUserIds(phaseGroupId);
  if (userIds.length === 0) return null;

  // Rotate, so the cost is shared by the people benefiting from it rather than
  // falling entirely on whoever happened to open the pool first.
  for (let attempt = 0; attempt < userIds.length; attempt++) {
    const userId = userIds[(watch.nextTokenIndex + attempt) % userIds.length];
    const user = await getUserById(userId);
    if (user) {
      watch.nextTokenIndex = (watch.nextTokenIndex + attempt + 1) % userIds.length;
      return user.accessToken;
    }
  }
  return null;
}

async function tick(phaseGroupId: string, watch: Watch): Promise<void> {
  // A slow response must not stack ticks on top of each other; skipping is
  // right because the next tick reads the same current state anyway.
  if (watch.ticking) return;
  watch.ticking = true;
  try {
    const accessToken = await tokenForTick(phaseGroupId, watch);
    if (!accessToken) return;

    const fingerprint = await fetchPulse(accessToken, phaseGroupId);
    const changed = watch.fingerprint !== null && watch.fingerprint !== fingerprint;
    watch.fingerprint = fingerprint;
    if (changed) publishPoolChanged(phaseGroupId);
  } catch {
    // A failed probe is not worth telling anyone about: the clients' own slow
    // safety-net poll still covers them, and announcing a change that may not
    // have happened would make every watcher refetch for nothing. The next
    // tick tries again, with the next TO's token.
  } finally {
    watch.ticking = false;
  }
}

/** Called when a pool gains its first watcher. */
export function startWatching(phaseGroupId: string): void {
  const key = String(phaseGroupId);
  if (watches.has(key)) return;

  const watch: Watch = { timer: setInterval(() => {}, PULSE_INTERVAL_MS), fingerprint: null, nextTokenIndex: 0, ticking: false };
  clearInterval(watch.timer);
  watch.timer = setInterval(() => void tick(key, watch), PULSE_INTERVAL_MS);
  // Never hold the process open for a bracket nobody is looking at.
  watch.timer.unref?.();
  watches.set(key, watch);
  void tick(key, watch);
}

/** Called when a pool loses its last watcher. */
export function stopWatching(phaseGroupId: string): void {
  const key = String(phaseGroupId);
  const watch = watches.get(key);
  if (!watch) return;
  clearInterval(watch.timer);
  watches.delete(key);
}

export function isWatching(phaseGroupId: string): boolean {
  return watches.has(String(phaseGroupId));
}

/** Test-only: timers outlive individual tests otherwise. */
export function stopAllWatching(): void {
  for (const watch of watches.values()) clearInterval(watch.timer);
  watches.clear();
}

export const PULSE = { query: PULSE_QUERY, base: PULSE_BASE_COST, maxPerSet: PULSE_MAX_COST_PER_SET, perPage: PULSE_PER_PAGE } as const;
