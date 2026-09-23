import { gql } from './startgg.js';
import { fillCharacterCounts, insertComputedPlayerMain } from './db/mains.js';

// SetFilters has no videogameId filter (confirmed via schema introspection),
// so Player.sets spans every game a player has ever played — over-fetch and
// filter client-side down to the target game's most recent 10.
const OVER_FETCH_PER_PAGE = 30;
const SETS_TO_CONSIDER = 10;

const PLAYER_MAIN_HISTORY_QUERY = /* GraphQL */ `
  query PlayerMainHistory($playerId: ID!, $perPage: Int!) {
    player(id: $playerId) {
      sets(perPage: $perPage) {
        nodes {
          event {
            videogame {
              id
            }
          }
          slots {
            entrant {
              id
              participants {
                player {
                  id
                }
              }
            }
          }
          games {
            selections {
              entrant {
                id
              }
              character {
                id
              }
            }
          }
        }
      }
    }
  }
`;

interface RawGameSelection {
  entrant: { id: number } | null;
  character: { id: number } | null;
}

interface RawGame {
  selections: RawGameSelection[] | null;
}

interface RawSlot {
  entrant: {
    id: number;
    participants: { player: { id: number } | null }[] | null;
  } | null;
}

export interface RawPlayerSet {
  event: { videogame: { id: number } | null } | null;
  slots: RawSlot[];
  games: RawGame[] | null;
}

interface PlayerMainHistoryResult {
  player: { sets: { nodes: RawPlayerSet[] } } | null;
}

export interface CharacterTally {
  /** Games played on each character id, over the sets considered. */
  counts: Record<number, number>;
  /** The most-played of them, which is what "main" has always meant here. */
  best: { characterId: number; gamesTallied: number } | null;
}

// Pure — no I/O. `relevantSets` must already be most-recent-first (Player.sets'
// own default order, preserved by the caller's filter/slice) and scoped to one
// videogame. Resolves which of a set's (up to two) entrant ids is this player
// via participants[].player.id — never by name, unlike the old hardcoded
// web/src/mains.ts lookup — then tallies that entrant's character per game.
// Ties break toward the more-recently-tallied character: counts increment
// while scanning most-recent-first, and `best` only updates on a strict `>`,
// so a character that reaches a given count via more recent sets keeps
// priority over one that only reaches the same count via older sets.
//
// The whole tally is returned, not just the winner of it: it is what orders
// the character dropdowns, so a TO sees the handful of characters this player
// actually plays rather than an alphabetical list. `counts` is always an
// object, empty when nothing could be tallied — a player with no character
// data on start.gg is a tallied player with nothing in it, which is a
// different thing from one who has never been looked at.
export function tallyCharacters(relevantSets: RawPlayerSet[], playerId: number): CharacterTally {
  const counts = new Map<number, number>();
  let best: { characterId: number; count: number } | null = null;

  for (const set of relevantSets) {
    const myEntrantId = set.slots.find((slot) => slot.entrant?.participants?.some((p) => p.player?.id === playerId))
      ?.entrant?.id;
    if (myEntrantId == null) continue;

    for (const game of set.games ?? []) {
      const mySelection = game.selections?.find((sel) => sel.entrant?.id === myEntrantId);
      const characterId = mySelection?.character?.id;
      if (characterId == null) continue;

      const nextCount = (counts.get(characterId) ?? 0) + 1;
      counts.set(characterId, nextCount);
      if (!best || nextCount > best.count) {
        best = { characterId, count: nextCount };
      }
    }
  }

  return {
    counts: Object.fromEntries(counts),
    best: best ? { characterId: best.characterId, gamesTallied: best.count } : null,
  };
}

// Bounds worst-case burst (e.g. ~100 entrants all uncached on a large
// bracket's first poll) to a handful of truly-concurrent start.gg calls,
// regardless of bracket size — the rest queue in-process and drain as slots
// free up. Pure pacing: no persistence, no retry/backoff. Empirically
// motivated: 20 truly parallel requests to start.gg this session all
// succeeded, but per-request time roughly doubled versus sequential — a bad
// trend worth capping ahead of a ~100-person bracket, not a hard error seen
// yet.
const MAX_CONCURRENT_LOOKUPS = 6;
let activeCount = 0;
const waiting: (() => void)[] = [];

function acquireSlot(): Promise<void> {
  if (activeCount < MAX_CONCURRENT_LOOKUPS) {
    activeCount++;
    return Promise.resolve();
  }
  return new Promise((resolve) => waiting.push(resolve));
}

function releaseSlot(): void {
  const next = waiting.shift();
  if (next) {
    next(); // hand the slot directly to the next waiter — activeCount stays the same
  } else {
    activeCount--;
  }
}

/**
 * Test-only. The slot counter, the in-flight map and the failure cooldown are
 * module state that outlives a test: a test which triggers a lookup whose
 * mocked request never resolves holds its slot forever, and a later test then
 * waits for a slot that never frees. In production the 20s request timeout in
 * gql() frees it instead, which is why this is a test seam and not a fix.
 */
export function resetMainLookupState(): void {
  mainsInFlight.clear();
  mainsFailedAt.clear();
  activeCount = 0;
  waiting.length = 0;
}

// Exported directly (not just via ensureMainComputed) so tests can await it.
export async function computePlayerMain(accessToken: string, playerId: number, videogameId: number): Promise<void> {
  await acquireSlot();
  try {
    const data = await gql<PlayerMainHistoryResult>(accessToken, PLAYER_MAIN_HISTORY_QUERY, {
      playerId,
      perPage: OVER_FETCH_PER_PAGE,
    });
    const allSets = data.player?.sets.nodes ?? [];
    const relevantSets = allSets.filter((s) => s.event?.videogame?.id === videogameId).slice(0, SETS_TO_CONSIDER);
    const { counts, best } = tallyCharacters(relevantSets, playerId);

    const wrote = await insertComputedPlayerMain(
      playerId,
      videogameId,
      best?.characterId ?? null,
      best?.gamesTallied ?? 0,
      relevantSets.length,
      counts
    );

    if (!wrote) {
      // Somebody set one while this was in flight. Theirs stands — but their
      // correction says nothing about what the player has been playing, so the
      // tally still goes on, which is also what stops this player being looked
      // up again on every poll forever.
      await fillCharacterCounts(playerId, videogameId, counts);
      console.log(`[mains] kept the main set for player ${playerId} (videogame ${videogameId}) and recorded the tally alongside it`);
    } else {
      console.log(
        `[mains] computed main for player ${playerId} (videogame ${videogameId}): ` +
          (best ? `character ${best.characterId} (${best.gamesTallied}/${relevantSets.length} sets)` : 'no computable main') +
          `, ${Object.keys(counts).length} characters tallied`
      );
    }
  } finally {
    releaseSlot();
  }
}

// De-dupes concurrent lookups for the same player+game — several open-sets
// polls (or several entrants resolving to the same player, e.g. re-entrants)
// can land in the same moment. A plain in-process Map is enough at Railway's
// single-instance scale, mirroring middleware/auth.ts's refreshesInFlight.
// Keyed by a composite string, unlike that Map's plain numeric key, since the
// same player can legitimately be looked up for two different videogames
// concurrently.
const mainsInFlight = new Map<string, Promise<void>>();

// A successful lookup writes a row, which stops sets.ts asking again — but a
// failed one leaves no trace, so every poll re-fired the whole uncached set
// four seconds later. Under a rate limit that is self-reinforcing: the
// failures are what keep the requests coming. Remembering the failure for a
// cooldown turns a permanent storm into one retry a minute.
const FAILURE_COOLDOWN_MS = 60_000;
const mainsFailedAt = new Map<string, number>();

// Fire-and-forget — deliberately returns void, not the task's Promise, so
// it's structurally impossible for a caller to accidentally await it and
// block a request on a start.gg round trip. This is the first genuinely
// detached background task in this codebase (no request exists to report an
// error to), so failures are logged and swallowed here rather than thrown.
export function ensureMainComputed(accessToken: string, playerId: number, videogameId: number): void {
  const key = `${playerId}:${videogameId}`;
  if (mainsInFlight.has(key)) return;

  const failedAt = mainsFailedAt.get(key);
  if (failedAt !== undefined && Date.now() - failedAt < FAILURE_COOLDOWN_MS) return;

  const task = computePlayerMain(accessToken, playerId, videogameId)
    .then(() => {
      mainsFailedAt.delete(key);
    })
    .catch((err) => {
      mainsFailedAt.set(key, Date.now());
      console.error(`[mains] failed to compute main for player ${playerId} (videogame ${videogameId}):`, err);
    })
    .finally(() => {
      mainsInFlight.delete(key);
    });

  mainsInFlight.set(key, task);
}
