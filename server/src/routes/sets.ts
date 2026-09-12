import { Router } from 'express';
import { gql, gqlWithCost, StartggComplexityError } from '../startgg.js';
import { getPlayerMains } from '../db/mains.js';
import { hasSeenPool, publishPoolChanged, recordPoolAccess, subscribe, subscriberCount } from '../poolEvents.js';
import { startWatching, stopWatching } from '../poolWatcher.js';
import { ensureMainComputed } from '../mainLookup.js';
import { parseDisplayScore } from '../displayScore.js';
import { pickSetCharacter, type SetGame } from '../setCharacter.js';

export const setsRouter = Router();

const COMPLETED_STATE = 3;
const STARTED_STATE = 2; // ActivityState.ACTIVE — someone's actively playing this set
// Both of these are deliberately shorter than the client's 4s poll, so every
// poll goes upstream and nothing a TO sees is stale by design. That is
// affordable because each fetch is now a single cheap request (see the
// live/structure split below); these exist only to collapse bursts, such as
// two requests arriving together. A TO's own report or start is reflected
// immediately regardless, via invalidateSetCaches.
const OPEN_SETS_CACHE_TTL_MS = 2_000;
const BRACKET_CACHE_TTL_MS = 2_000;
// The exception: cross-phase wiring is the one expensive query left, and it
// only changes when an upstream pool finishes, so it gets a much slower clock.
const STRUCTURE_CACHE_TTL_MS = 60_000;

// start.gg rejects any request whose response would exceed 1000 objects. The
// cost tracks rows actually *returned*, not the perPage asked for, so page
// size is the lever. Each query below states its measured worst-case cost per
// row and derives its page size from that, rather than hardcoding a number —
// a bare constant is what broke here before, when new fields were added to
// BRACKET_QUERY and silently pushed 50 sets past the cap.
const COMPLEXITY_BUDGET = 900;

function pageSizeFor(baseCost: number, costPerRow: number): number {
  return Math.max(1, Math.floor((COMPLEXITY_BUDGET - baseCost) / costPerRow));
}

// Measured live against real brackets on 2026-09-11, and the reason the
// bracket query is split in two. start.gg charges per object, not per field —
// `entrant { id }` and `entrant { id name }` cost exactly the same — so the
// live half, which is scalars plus the two slots and their entrants, settles
// at ~6 per set no matter how many fields it asks for. That fits any realistic
// pool in one request. The combined query it replaced cost 21-27 per set.
const BRACKET_BASE_COST = 3;
const BRACKET_MAX_COST_PER_SET = 7;

// The structure half is all nested objects, so it is the expensive one: 8 per
// set in a first-phase bracket where the progression fields are null, up to
// ~12 in a phase fed by pools where every slot resolves one.
const STRUCTURE_BASE_COST = 3;
const STRUCTURE_MAX_COST_PER_SET = 14;

// SETS_QUERY carries no progression or standing detail, so it is far cheaper —
// but each entrant's participants list scales with team size (~10/set for
// singles, ~17 for a 3-player team). This is also the one query that does not
// go through fetchSetsPaged, so a rejection here has no recovery path: the
// assumed worst case is deliberately set well above any format the app
// actually supports, rather than at the measured one.
const SETS_BASE_COST = 4;
const SETS_MAX_COST_PER_SET = 24;

// A ceiling on sets, never on pages: page count depends on the page size in
// use, which shrinks at runtime when start.gg rejects a page as too complex.
const MAX_SETS = 700;

export interface PhaseGroupSummary {
  id: number;
  displayIdentifier: string;
  phaseId: number;
  phaseName: string;
  /**
   * How the phases are ordered. phaseOrder looks like the field for this and
   * isn't: Supernova 2026 reports Phase 1=2, Phase 2=7, Phase 3=4, which puts
   * Phase 2 last, and start.gg's own bracket page doesn't show it that way.
   * Seed count does order them correctly there (1581 > 512 > 128 > 24 > 8),
   * and it holds generally, because a phase fed by another can only ever
   * carry a subset of it forward.
   */
  phaseNumSeeds: number;
  bracketType: string;
}

interface PhaseGroupsQueryResult {
  event: {
    phaseGroups:
      | { id: number; displayIdentifier: string; bracketType: string; phase: { id: number; name: string; numSeeds: number | null } }[]
      | null;
  } | null;
}

const PHASE_GROUPS_QUERY = /* GraphQL */ `
  query EventPhaseGroups($eventId: ID!) {
    event(id: $eventId) {
      phaseGroups {
        id
        displayIdentifier
        bracketType
        phase {
          id
          name
          numSeeds
        }
      }
    }
  }
`;

setsRouter.get('/:eventId/phase-groups', async (req, res) => {
  const { eventId } = req.params;
  try {
    const data = await gql<PhaseGroupsQueryResult>(req.user!.accessToken, PHASE_GROUPS_QUERY, { eventId });
    const phaseGroups: PhaseGroupSummary[] = (data.event?.phaseGroups ?? []).map((pg) => ({
      id: pg.id,
      displayIdentifier: pg.displayIdentifier,
      phaseId: pg.phase.id,
      phaseName: pg.phase.name,
      // Null on a phase with no seeds yet; 0 just sorts it last, which is
      // where an unseeded phase belongs anyway.
      phaseNumSeeds: pg.phase.numSeeds ?? 0,
      bracketType: pg.bracketType,
    }));
    res.json({ phaseGroups });
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : 'Failed to load phase groups' });
  }
});

/**
 * Short queries are refused rather than run. Filtering Supernova's 1581
 * entrants by "a" matches 900 of them, so one or two characters is all noise
 * and all rate limit — and start.gg's limit is ~80 requests/minute per token,
 * shared with the polling this TO is already doing.
 */
const MIN_ENTRANT_QUERY = 3;
/** Measured at complexity 51 against the worst case above; the cap is 1000. */
const ENTRANT_SEARCH_PER_PAGE = 20;

export interface EntrantMatch {
  id: number;
  name: string;
  /** Every pool this entrant was seeded into, across all phases of the event. */
  phaseGroupIds: number[];
}

interface EntrantSearchResult {
  event: {
    entrants: { nodes: { id: number; name: string; seeds: { phaseGroup: { id: number } | null }[] | null }[] | null } | null;
  } | null;
}

// seeds carries the whole run in one request — a player who reached top 8 came
// back with all five of their pools — so no per-phase lookup is needed.
const ENTRANT_SEARCH_QUERY = /* GraphQL */ `
  query EventEntrantSearch($eventId: ID!, $name: String!, $perPage: Int!) {
    event(id: $eventId) {
      entrants(query: { perPage: $perPage, filter: { name: $name } }) {
        nodes {
          id
          name
          seeds {
            phaseGroup {
              id
            }
          }
        }
      }
    }
  }
`;

setsRouter.get('/:eventId/entrants', async (req, res) => {
  const { eventId } = req.params;
  const name = typeof req.query.q === 'string' ? req.query.q.trim() : '';
  if (name.length < MIN_ENTRANT_QUERY) {
    res.status(400).json({ error: `Type at least ${MIN_ENTRANT_QUERY} characters to look up a player` });
    return;
  }

  try {
    const data = await gql<EntrantSearchResult>(req.user!.accessToken, ENTRANT_SEARCH_QUERY, {
      eventId,
      name,
      perPage: ENTRANT_SEARCH_PER_PAGE,
    });
    const entrants: EntrantMatch[] = (data.event?.entrants?.nodes ?? []).map((entrant) => ({
      id: entrant.id,
      name: entrant.name,
      // A seed with no phaseGroup is one not yet drawn into a pool, which is a
      // real state during setup rather than something to paper over.
      phaseGroupIds: (entrant.seeds ?? []).flatMap((seed) => (seed.phaseGroup ? [seed.phaseGroup.id] : [])),
    }));
    res.json({ entrants });
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : 'Failed to look up players' });
  }
});

/**
 * How many names a pool row previews, matching start.gg's own pool cards.
 * standings answers this in every pool state — a finished pool returns who
 * came out of it, a running one returns the current order — so there's no
 * separate seeds path to keep in step.
 */
const POOL_PREVIEW_NAMES = 4;
const POOL_PREVIEW_BASE_COST = 3;
/** Measured live on 2026-09-11: 8 pools x 4 names came back at complexity 65. */
const POOL_PREVIEW_COST_PER_POOL = 9;
const POOL_PREVIEW_CACHE_TTL_MS = 30_000;
/**
 * A ceiling on how far the pager will walk a single phase. The page size
 * already keeps each request inside the complexity budget, so this is not
 * about complexity — it's so a phase reporting an absurd page count can't turn
 * one screen into hundreds of requests against a ~80/minute limit. The largest
 * real phase seen is 64 pools; anything past this loses its name preview and
 * falls back to showing the bracket type, which is a row that still works.
 */
const MAX_POOLS_PREVIEWED = 512;

export interface PoolPreview {
  phaseGroupId: number;
  names: string[];
  /** Entrants in the pool, so a row can say how many are not shown. */
  total: number;
}

interface PoolPreviewPage {
  phase: {
    phaseGroups: {
      pageInfo: { totalPages: number };
      nodes: { id: number; standings: { pageInfo: { total: number }; nodes: { entrant: { name: string } | null }[] | null } | null }[] | null;
    } | null;
  } | null;
}

const POOL_PREVIEW_QUERY = /* GraphQL */ `
  query PhasePoolPreviews($phaseId: ID!, $page: Int!, $perPage: Int!, $names: Int!) {
    phase(id: $phaseId) {
      phaseGroups(query: { page: $page, perPage: $perPage }) {
        pageInfo {
          totalPages
        }
        nodes {
          id
          standings(query: { perPage: $names }) {
            pageInfo {
              total
            }
            nodes {
              entrant {
                name
              }
            }
          }
        }
      }
    }
  }
`;

const poolPreviewCache = new Map<string, { at: number; previews: PoolPreview[] }>();

/**
 * Pages through a phase's pools, sizing each page from the cost model above
 * and shrinking when start.gg disagrees — the same self-healing shape as the
 * set pager, because a phase with enough pools would otherwise be a hard
 * failure that no constant can be tuned to avoid forever.
 */
async function fetchPoolPreviews(accessToken: string, phaseId: string): Promise<PoolPreview[]> {
  let perPage = pageSizeFor(POOL_PREVIEW_BASE_COST, POOL_PREVIEW_COST_PER_POOL);
  const previews: PoolPreview[] = [];
  let page = 1;

  while (true) {
    try {
      const { data } = await gqlWithCost<PoolPreviewPage>(accessToken, POOL_PREVIEW_QUERY, {
        phaseId,
        page,
        perPage,
        names: POOL_PREVIEW_NAMES,
      });
      const groups = data.phase?.phaseGroups;
      for (const node of groups?.nodes ?? []) {
        previews.push({
          phaseGroupId: node.id,
          // An entrant can be null on a seed not yet filled; that's a real
          // state mid-setup, and the row simply has one fewer name to show.
          names: (node.standings?.nodes ?? []).flatMap((s) => (s.entrant ? [s.entrant.name] : [])),
          total: node.standings?.pageInfo.total ?? 0,
        });
      }
      if (page >= (groups?.pageInfo.totalPages ?? 1)) return previews;
      if (previews.length >= MAX_POOLS_PREVIEWED) {
        console.warn(`[pool-preview] phase ${phaseId} has more than ${MAX_POOLS_PREVIEWED} pools; the rest will show no names`);
        return previews;
      }
      page += 1;
    } catch (err) {
      if (!(err instanceof StartggComplexityError)) throw err;
      const measured = Math.max(1, Math.ceil((err.actual - POOL_PREVIEW_BASE_COST) / perPage));
      const next = Math.max(1, Math.min(pageSizeFor(POOL_PREVIEW_BASE_COST, measured), perPage - 1));
      if (next >= perPage) throw err;
      // Offset paging, so a changed page size invalidates what was collected.
      perPage = next;
      previews.length = 0;
      page = 1;
    }
  }
}

setsRouter.get('/phase/:phaseId/pool-preview', async (req, res) => {
  const { phaseId } = req.params;
  const key = `${req.user!.id}:${phaseId}`;
  const hit = poolPreviewCache.get(key);
  if (hit && Date.now() - hit.at < POOL_PREVIEW_CACHE_TTL_MS) {
    res.json({ previews: hit.previews });
    return;
  }

  try {
    const previews = await fetchPoolPreviews(req.user!.accessToken, phaseId);
    poolPreviewCache.set(key, { at: Date.now(), previews });
    res.json({ previews });
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : 'Failed to load pool previews' });
  }
});

interface RawSet {
  // Real sets have a numeric id; sets in an un-started/preview bracket come
  // back as a synthetic "preview_..." string instead.
  id: number | string;
  state: number;
  round: number;
  fullRoundText: string;
  identifier: string;
  // The placement the loser of this set will finish with — start.gg
  // precomputes this from the actual bracket structure (standard, redemption,
  // round-robin-fed, whatever), so it's a reliable "how deep is this set"
  // signal without us having to model bracket shape ourselves. Null for
  // sets where that isn't determined yet (e.g. an un-started preview bracket).
  lPlacement: number | null;
  slots: {
    id: string;
    entrant: {
      id: number;
      name: string;
      participants: { player: { id: number } | null }[] | null;
    } | null;
  }[];
}

interface OpenSetEntrant {
  id: number;
  name: string;
  playerId: number | null;
}

export interface OpenSet {
  id: number | string;
  isPreview: boolean;
  isStarted: boolean;
  fullRoundText: string;
  identifier: string;
  lPlacement: number | null;
  entrants: OpenSetEntrant[];
}

// The half of a bracket that changes while a tournament runs. Everything here
// is either a scalar on the set or one of its two slots/entrants, which is why
// it costs ~6 objects per set against the ~21-27 the single combined query
// used to — see BRACKET_LIVE_QUERY.
interface RawLiveSet {
  id: number | string;
  identifier: string;
  round: number;
  fullRoundText: string;
  state: number;
  winnerId: number | null;
  lPlacement: number | null;
  // Rendered result string ("Name 3 - Other 1", or "DQ"), parsed into per-slot
  // scores. A scalar, unlike the standing.stats.score objects it replaces.
  displayScore: string | null;
  // Unix seconds, set only once a set is actually finished — so it doubles as
  // a completion marker. Free: a scalar on the node costs nothing.
  completedAt: number | null;
  slots: {
    entrant: { id: number; name: string } | null;
    // "set" | "seed" | "bye" — only "set" ever resolves to another node in
    // this same response, so that's the only one the slot carries forward.
    prereqType: string | null;
    prereqId: string | null;
    // 1 = the winner of the prereq set advances into this slot, 2 = the
    // loser drops into it. Confirmed against live start.gg data (e.g. Grand
    // Final's two slots are both prereqPlacement 1 — winner of Winners
    // Final, winner of Losers Final).
    prereqPlacement: number | null;
  }[];
}

// The cross-phase wiring, which is a property of how the bracket was built
// rather than of how it is going. Fetched on its own slow clock because it is
// the expensive half — every field here is a nested object.
interface RawStructureSet {
  id: number | string;
  // Present only on a set whose winner/loser placement is itself seeded
  // into a *later* phase (a pool's terminal matches feeding the next
  // bracket) — null for a set whose result only matters within this same
  // phaseGroup.
  winnerProgressionSeed: { phase: { name: string } } | null;
  loserProgressionSeed: { phase: { name: string } } | null;
  slots: {
    // Only meaningful when prereqType is "seed" — the seed this slot was
    // freshly filled from, whose progressionSource (present only if that
    // seed was itself produced by an earlier phase, e.g. a pool feeding a
    // bracket) says where this entrant qualified in from.
    seed: {
      // The entrant's seed in this phase group. Free here — a scalar on an
      // object this query already returns — where adding it to the polled
      // live query measured at +2 objects per set (5.95 -> 7.95), past the
      // cost model and into a smaller page size on every poll.
      seedNum: number | null;
      progressionSource: {
        originPhase: { name: string } | null;
        originPhaseGroup: { displayIdentifier: string } | null;
      } | null;
    } | null;
  }[];
}

// The bracket queries and the open-sets query select different fields on
// phaseGroup itself, so the pager is generic over that header — everything it
// actually needs is the sets connection.
interface BracketHeader {
  id: number;
  displayIdentifier: string;
  bracketType: string;
  phase: { name: string };
}

interface OpenSetsHeader {
  phase: { event: { videogame: { id: number } | null } | null } | null;
}

interface SetsPage<N, H> {
  phaseGroup:
    | (H & {
        sets: {
          pageInfo: { total: number | null; totalPages: number };
          nodes: N[];
        };
      })
    | null;
}

export interface BracketSlot {
  entrant: { id: number; name: string } | null;
  score: number | null;
  // The character this entrant is shown as having played, for a finished set.
  // Null whenever start.gg carries no picks for the set, which is common —
  // plenty of TOs never report them. See pickSetCharacter.
  characterId: number | null;
  // A same-response Set.id this slot is fed by (winner or loser, per
  // prereqPlacement below), or null once the slot is already filled, or if
  // the prereq is a seed rather than another set (first-round slots).
  prereqSetId: string | null;
  prereqPlacement: 1 | 2 | null;
  // Where this slot's entrant qualified in from, if this phaseGroup itself
  // isn't the first phase they entered — null for a slot fed by a prior set
  // in this same group, or seeded from the event's initial registration.
  progressionOrigin: { phaseName: string; poolName: string | null } | null;
  // The entrant's seed, from the structure query's slow clock — so a slot
  // filled in the last minute may not have it yet, which only delays a label.
  seedNum: number | null;
}

export interface BracketSet {
  id: number | string;
  identifier: string;
  round: number;
  fullRoundText: string;
  state: number;
  winnerId: number | null;
  lPlacement: number | null;
  // Unix seconds, null until the set is finished. Lets the client order
  // completed sets most-recent-first when a TO searches for one to correct.
  completedAt: number | null;
  slots: [BracketSlot, BracketSlot];
  // The later phase this set's winner/loser placement advances into, if
  // any (a pool's terminal matches) — null when this set's result is only
  // meaningful within its own phaseGroup.
  winnerAdvancesToPhase: string | null;
  loserAdvancesToPhase: string | null;
}

export interface BracketGroup {
  phaseGroupId: number;
  phaseName: string;
  displayIdentifier: string;
  bracketType: string;
  sets: BracketSet[];
}

// Deliberately no sortType here (e.g. STANDARD) — combined with
// filters.hideEmpty, start.gg's API has an eventual-consistency bug where a
// set that just became non-empty (most notably a bracket-reset grand final,
// right after game 1 sends it to a true final) is dropped from the results
// entirely for a while, then reappears wildly out of order. hideEmpty alone
// doesn't hit this. Confirmed against a live event on 2026-09-04.
const SETS_QUERY = /* GraphQL */ `
  query PhaseGroupOpenSets($phaseGroupId: ID!, $page: Int!, $perPage: Int!) {
    phaseGroup(id: $phaseGroupId) {
      phase {
        event {
          videogame {
            id
          }
        }
      }
      sets(page: $page, perPage: $perPage, filters: { hideEmpty: true }) {
        pageInfo {
          total
          totalPages
        }
        nodes {
          id
          state
          round
          fullRoundText
          identifier
          lPlacement
          slots {
            id
            entrant {
              id
              name
              participants {
                player {
                  id
                }
              }
            }
          }
        }
      }
    }
  }
`;

const START_SET_MUTATION = /* GraphQL */ `
  mutation StartSet($setId: ID!) {
    markSetInProgress(setId: $setId) {
      id
    }
  }
`;

// Split in two on purpose. start.gg charges per object returned, and the two
// halves of a bracket have very different shapes and very different refresh
// needs: what is happening right now is almost all scalars, while the
// cross-phase wiring is all nested objects but barely changes.
//
// Neither uses filters.hideEmpty or skips completed sets — the bracket needs
// the whole tree, including not-yet-reachable "winner of X" slots. No sortType
// either, for the same eventual-consistency caution as SETS_QUERY; every
// consumer sorts by round/identifier itself.

// ~6 objects per set, so a pool of any realistic size comes back in a single
// request. displayScore stands in for standing.stats.score, which alone cost
// 10 objects per set — about half of what a bracket page used to cost.
const BRACKET_LIVE_QUERY = /* GraphQL */ `
  query PhaseGroupBracket($phaseGroupId: ID!, $page: Int!, $perPage: Int!) {
    phaseGroup(id: $phaseGroupId) {
      id
      displayIdentifier
      bracketType
      phase {
        name
      }
      sets(page: $page, perPage: $perPage) {
        pageInfo {
          total
          totalPages
        }
        nodes {
          id
          identifier
          round
          fullRoundText
          state
          winnerId
          lPlacement
          displayScore
          completedAt
          slots {
            entrant {
              id
              name
            }
            prereqType
            prereqId
            prereqPlacement
          }
        }
      }
    }
  }
`;

// 8-12 objects per set — the expensive half, and the reason it is not polled.
// It is not perfectly static: a phase fed by pools gains progressionSource
// entries as those pools finish, so it refreshes on its own slow clock rather
// than being fetched once and kept forever.
const BRACKET_STRUCTURE_QUERY = /* GraphQL */ `
  query PhaseGroupProgression($phaseGroupId: ID!, $page: Int!, $perPage: Int!) {
    phaseGroup(id: $phaseGroupId) {
      id
      displayIdentifier
      bracketType
      phase {
        name
      }
      sets(page: $page, perPage: $perPage) {
        pageInfo {
          total
          totalPages
        }
        nodes {
          id
          winnerProgressionSeed {
            phase {
              name
            }
          }
          loserProgressionSeed {
            phase {
              name
            }
          }
          slots {
            seed {
              seedNum
              progressionSource {
                originPhase {
                  name
                }
                originPhaseGroup {
                  displayIdentifier
                }
              }
            }
          }
        }
      }
    }
  }
`;

// Exported for the start.gg contract canary (src/startgg.contract.test.ts),
// which re-measures these against the live API on a schedule. Every number
// here came from a real measurement, and a measurement that lives only in a
// comment is exactly how the query-complexity outage happened — encoding it
// somewhere a scheduled job can check is the point.
/**
 * Per-game character picks, fetched once per completed set and then kept.
 *
 * Deliberately not on the structure query, where it would look like it
 * belongs. Measured live: adding games there takes it from ~12.6 objects per
 * set to over 37 on a phase of full Bo5s, which drops the page size from 64
 * sets to ~22 and triples that query's requests — every 60 seconds, forever,
 * for data that cannot change. A set's games are fixed once it is complete;
 * the only thing that moves them is somebody correcting the set, which the
 * fingerprint below notices.
 *
 * selectionValue rather than character { id }: it is the same character id as
 * a scalar instead of an object, measured 19% cheaper for identical data.
 */
const SET_CHARACTERS_BASE_COST = 3;
/** Measured 20.4/set on a Bo5-heavy top 8; ~5 objects a game caps all-Bo5 near 26. */
const SET_CHARACTERS_MAX_COST_PER_SET = 28;

const SET_CHARACTERS_QUERY = /* GraphQL */ `
  query PhaseGroupSetCharacters($phaseGroupId: ID!, $page: Int!, $perPage: Int!) {
    phaseGroup(id: $phaseGroupId) {
      id
      displayIdentifier
      bracketType
      phase {
        name
      }
      sets(page: $page, perPage: $perPage) {
        pageInfo {
          total
          totalPages
        }
        nodes {
          id
          winnerId
          displayScore
          games {
            orderNum
            selections {
              entrant {
                id
              }
              selectionValue
            }
          }
        }
      }
    }
  }
`;

// Only the prereq graph, for working out what resetting a set would unmake.
//
// showByes matters and is not cosmetic: a losers-bracket slot does not point
// back at the winners set whose loser drops into it, it points at a bye set in
// between, and phaseGroup.sets omits those by default. Without this filter the
// walk sees the winner's path only — measured on the live test bracket, that
// named 2 of the 3 sets a real reset actually cleared.
const CASCADE_BASE_COST = 1;
/** Measured live 2026-09-12: exactly 2 (one node plus its two slots). */
const CASCADE_MAX_COST_PER_SET = 3;
const CASCADE_QUERY = /* GraphQL */ `
  query PhaseGroupCascade($phaseGroupId: ID!, $page: Int!, $perPage: Int!) {
    phaseGroup(id: $phaseGroupId) {
      id
      sets(page: $page, perPage: $perPage, filters: { showByes: true }) {
        pageInfo {
          totalPages
        }
        nodes {
          id
          identifier
          state
          slots {
            prereqId
            prereqType
          }
        }
      }
    }
  }
`;

export const COST_MODEL = {
  budget: COMPLEXITY_BUDGET,
  cap: 1000, // start.gg's own hard limit, which `budget` stays under
  live: { base: BRACKET_BASE_COST, maxPerSet: BRACKET_MAX_COST_PER_SET, query: BRACKET_LIVE_QUERY },
  structure: { base: STRUCTURE_BASE_COST, maxPerSet: STRUCTURE_MAX_COST_PER_SET, query: BRACKET_STRUCTURE_QUERY },
  openSets: { base: SETS_BASE_COST, maxPerSet: SETS_MAX_COST_PER_SET, query: SETS_QUERY },
  setCharacters: {
    base: SET_CHARACTERS_BASE_COST,
    maxPerSet: SET_CHARACTERS_MAX_COST_PER_SET,
    query: SET_CHARACTERS_QUERY,
  },
  cascade: { base: CASCADE_BASE_COST, maxPerSet: CASCADE_MAX_COST_PER_SET, query: CASCADE_QUERY },
  poolPreview: {
    base: POOL_PREVIEW_BASE_COST,
    maxPerPool: POOL_PREVIEW_COST_PER_POOL,
    names: POOL_PREVIEW_NAMES,
    maxPools: MAX_POOLS_PREVIEWED,
    query: POOL_PREVIEW_QUERY,
  },
} as const;

interface OpenSetsResult {
  sets: OpenSet[];
  videogameId: number | null;
}

const cache = new Map<string, { at: number; result: OpenSetsResult }>();

// Keyed by user as well as pool. These responses are fetched with one user's
// start.gg token, and start.gg decides per token which tournaments are
// visible — so a pool-only key would let one TO's cached bracket answer
// another TO's request for a tournament start.gg would not have shown them.
function cacheKey(userId: number, phaseGroupId: string): string {
  return `${userId}:${phaseGroupId}`;
}

// Cleared wholesale on any mutation: reporting or starting a set changes what
// every viewer's list and bracket should show, and a TO mutates a handful of
// times a minute — far too rarely for the extra refetch to cost anything next
// to serving a result the TO already knows is out of date.
export function invalidateSetCaches(): void {
  cache.clear();
  bracketCache.clear();
}

async function fetchOpenSets(accessToken: string, userId: number, phaseGroupId: string): Promise<OpenSetsResult> {
  const key = cacheKey(userId, phaseGroupId);
  const cached = cache.get(key);
  if (cached && Date.now() - cached.at < OPEN_SETS_CACHE_TTL_MS) {
    return cached.result;
  }

  // Through the same pager as the bracket queries, so this path gets the same
  // recovery: it was the one query left that would simply fail if start.gg
  // ever judged a page too complex.
  const paged = await fetchSetsPaged<RawSet, OpenSetsHeader>(accessToken, phaseGroupId, SETS_QUERY, {
    name: 'opensets',
    base: SETS_BASE_COST,
    maxPerRow: SETS_MAX_COST_PER_SET,
  });

  const open: OpenSet[] = [];
  const videogameId = paged?.header.phase?.event?.videogame?.id ?? null;

  for (const s of paged?.nodes ?? []) {
    if (s.state === COMPLETED_STATE) continue;
    const entrants = s.slots
      .map((slot) => slot.entrant)
      .filter((e): e is NonNullable<RawSet['slots'][number]['entrant']> => e !== null)
      .map(
        (e): OpenSetEntrant => ({
          id: e.id,
          name: e.name,
          // First participant only — a deliberate simplification for
          // doubles/teams (there's no single coherent "team main" anyway,
          // and the old hardcoded mains.ts lookup doesn't handle doubles
          // either), correct as-is for singles.
          playerId: e.participants?.[0]?.player?.id ?? null,
        })
      );
    if (entrants.length !== 2) continue; // skip byes / not-yet-determined slots
    const isPreview = typeof s.id === 'string' && s.id.startsWith('preview_');
    open.push({
      id: s.id,
      isPreview,
      isStarted: s.state === STARTED_STATE,
      fullRoundText: s.fullRoundText,
      identifier: s.identifier,
      lPlacement: s.lPlacement,
      entrants,
    });
  }

  const result: OpenSetsResult = { sets: open, videogameId };
  cache.set(key, { at: Date.now(), result });
  return result;
}

// Separate from `cache` above — different query, different shape, and this
// one's read far less often (once per bracket-view poll cycle vs. every
// open-sets poll), so it shouldn't share a TTL clock or a key namespace with it.
const bracketCache = new Map<string, { at: number; result: BracketGroup | null }>();

// Progression wiring, on its own much slower clock — it is the expensive half
// and barely changes. Shared across users: unlike the caches above this holds
// no entrant or result data, only which phase a slot came from or goes to.
const structureCache = new Map<string, { at: number; result: Map<string, RawStructureSet> }>();

// The worst per-set cost actually seen, per query and phase group. start.gg
// reports what every response cost, so this is a measurement rather than an
// estimate. Only ever raised: a pool that turns out pricier than its measured
// ceiling permanently shrinks its own page size instead of failing twice.
const observedCostPerSet = new Map<string, number>();

interface CostModel {
  /** Namespaces the learned cost, so two queries don't overwrite each other. */
  name: string;
  base: number;
  maxPerRow: number;
}

/**
 * Pages through a phaseGroup.sets query, shrinking the page and starting over
 * if start.gg rejects one as too complex.
 *
 * The rejection carries the exact object count the response would have been,
 * so the real per-row cost is recoverable rather than guessed. That figure is
 * a floor — a page that returned fewer rows than asked for reads low — so the
 * next attempt is also forced strictly smaller, which is what guarantees this
 * terminates. Restarting rather than continuing is required: pages are
 * offsets, so changing perPage mid-run would skip or repeat sets.
 */
export async function fetchSetsPaged<N, H>(
  accessToken: string,
  phaseGroupId: string,
  query: string,
  cost: CostModel
): Promise<{ header: NonNullable<SetsPage<N, H>['phaseGroup']>; nodes: N[] } | null> {
  const costKey = `${cost.name}:${phaseGroupId}`;
  let perPage = pageSizeFor(cost.base, Math.max(cost.maxPerRow, observedCostPerSet.get(costKey) ?? 0));

  for (;;) {
    try {
      let header: NonNullable<SetsPage<N, H>['phaseGroup']> | null = null;
      const nodes: N[] = [];
      let page = 1;
      let totalPages = 1;

      // Bounded by sets, not pages. A page ceiling computed from the nominal
      // page size would silently shrink the bracket whenever a complexity
      // retry shrank perPage — half the page size, half the sets, no error.
      while (page <= totalPages && nodes.length < MAX_SETS) {
        const { data, complexity } = await gqlWithCost<SetsPage<N, H>>(accessToken, query, { phaseGroupId, page, perPage });
        const pg = data.phaseGroup;
        if (!pg) break;

        if (complexity !== null && pg.sets.nodes.length > 0) {
          const perSet = Math.ceil((complexity - cost.base) / pg.sets.nodes.length);
          observedCostPerSet.set(costKey, Math.max(observedCostPerSet.get(costKey) ?? 0, perSet));
        }
        if (page === 1 && (pg.sets.pageInfo.total ?? 0) > MAX_SETS) {
          console.warn(
            `[bracket] phaseGroup ${phaseGroupId} has ${pg.sets.pageInfo.total} sets; only the first ${MAX_SETS} will load`
          );
        }
        if (!header) header = pg;
        totalPages = pg.sets.pageInfo.totalPages;
        nodes.push(...pg.sets.nodes);
        page++;
      }

      return header ? { header, nodes } : null;
    } catch (err) {
      if (!(err instanceof StartggComplexityError) || perPage <= 1) throw err;
      const measured = Math.max(1, Math.ceil((err.actual - cost.base) / perPage));
      observedCostPerSet.set(costKey, Math.max(observedCostPerSet.get(costKey) ?? 0, measured));
      perPage = Math.max(1, Math.min(pageSizeFor(cost.base, measured), perPage - 1));
    }
  }
}

async function fetchBracketStructure(accessToken: string, phaseGroupId: string): Promise<Map<string, RawStructureSet>> {
  const cached = structureCache.get(phaseGroupId);
  if (cached && Date.now() - cached.at < STRUCTURE_CACHE_TTL_MS) {
    return cached.result;
  }

  // Cross-phase links are decoration on a bracket that renders correctly
  // without them, so a failure here must never take the bracket down with it.
  // What it must also not do is retry on every bracket poll: this query is the
  // expensive one, and the bracket polls 30x more often than this cache
  // expires. So a failure keeps serving the last good map (or nothing) and is
  // cached like any other result, which caps a start.gg outage at one attempt
  // a minute instead of one every two seconds.
  let result;
  try {
    result = await fetchSetsPaged<RawStructureSet, BracketHeader>(
      accessToken,
      phaseGroupId,
      BRACKET_STRUCTURE_QUERY,
      { name: 'structure', base: STRUCTURE_BASE_COST, maxPerRow: STRUCTURE_MAX_COST_PER_SET }
    );
  } catch (err) {
    console.error(`[bracket] progression lookup failed for phaseGroup ${phaseGroupId}:`, err);
    result = null;
  }

  // A null result means the query errored or the phase group came back empty;
  // either way the previous map is better information than an empty one.
  if (!result) {
    const fallback = cached?.result ?? new Map<string, RawStructureSet>();
    structureCache.set(phaseGroupId, { at: Date.now(), result: fallback });
    return fallback;
  }

  const byId = new Map<string, RawStructureSet>();
  for (const node of result.nodes) byId.set(String(node.id), node);
  structureCache.set(phaseGroupId, { at: Date.now(), result: byId });
  return byId;
}

interface RawCharacterSet {
  id: number | string;
  winnerId: number | null;
  displayScore: string | null;
  games: { orderNum: number | null; selections: { entrant: { id: number } | null; selectionValue: number | null }[] | null }[] | null;
}


/**
 * What a set's result looks like right now. A correction made elsewhere on
 * start.gg changes the winner or the score, which is how a cached set that is
 * no longer accurate gets noticed — the live query already carries both, so
 * this costs nothing.
 */
function resultFingerprint(set: { winnerId: number | null; displayScore: string | null }): string {
  return `${set.winnerId ?? ''}|${set.displayScore ?? ''}`;
}

const setCharacterCache = new Map<string, { fingerprint: string; byEntrant: Record<number, number> }>();

async function refreshSetCharacters(accessToken: string, userId: number, phaseGroupId: string): Promise<void> {
  const paged = await fetchSetsPaged<RawCharacterSet, BracketHeader>(accessToken, phaseGroupId, SET_CHARACTERS_QUERY, {
    name: 'setCharacters',
    base: SET_CHARACTERS_BASE_COST,
    maxPerRow: SET_CHARACTERS_MAX_COST_PER_SET,
  });
  if (!paged) return;

  for (const set of paged.nodes) {
    const games: SetGame[] = (set.games ?? []).flatMap((game) => {
      if (game.orderNum == null) return [];
      const characterIdByEntrantId: Record<number, number> = {};
      for (const selection of game.selections ?? []) {
        if (selection.entrant && selection.selectionValue != null) {
          characterIdByEntrantId[selection.entrant.id] = selection.selectionValue;
        }
      }
      return [{ orderNum: game.orderNum, characterIdByEntrantId }];
    });

    const byEntrant: Record<number, number> = {};
    for (const entrantId of new Set(games.flatMap((g) => Object.keys(g.characterIdByEntrantId).map(Number)))) {
      const character = pickSetCharacter(games, entrantId);
      if (character != null) byEntrant[entrantId] = character;
    }
    setCharacterCache.set(`${userId}:${set.id}`, { fingerprint: resultFingerprint(set), byEntrant });
  }
}

async function fetchBracketData(accessToken: string, userId: number, phaseGroupId: string): Promise<BracketGroup | null> {
  const key = cacheKey(userId, phaseGroupId);
  const cached = bracketCache.get(key);
  if (cached && Date.now() - cached.at < BRACKET_CACHE_TTL_MS) {
    return cached.result;
  }

  const live = await fetchSetsPaged<RawLiveSet, BracketHeader>(
    accessToken,
    phaseGroupId,
    BRACKET_LIVE_QUERY,
    { name: 'live', base: BRACKET_BASE_COST, maxPerRow: BRACKET_MAX_COST_PER_SET }
  );
  if (!live) {
    bracketCache.set(key, { at: Date.now(), result: null });
    return null;
  }

  const structure = await fetchBracketStructure(accessToken, phaseGroupId);

  // Games exist only once a set is finished, and then never move unless it is
  // corrected — which changes its winner or score, and so its fingerprint. In
  // practice this walks the pool once and then not again, rather than paying
  // for it on a clock. Not invalidated by invalidateSetCaches either: a local
  // correction changes the fingerprint too, so it is noticed the same way.
  const charactersAreStale = live.nodes.some((set) => {
    if (set.state !== 3) return false;
    const cached = setCharacterCache.get(`${userId}:${set.id}`);
    return !cached || cached.fingerprint !== resultFingerprint(set);
  });
  if (charactersAreStale) await refreshSetCharacters(accessToken, userId, phaseGroupId);

  const pg = live.header;
  const group: BracketGroup = {
    phaseGroupId: pg.id,
    phaseName: pg.phase.name,
    displayIdentifier: pg.displayIdentifier,
    bracketType: pg.bracketType,
    sets: [],
  };

  for (const s of live.nodes) {
    // Defensive: this app only deals in 1v1 sets; skip anything else
    // rather than let a malformed node reach the frontend's layout code.
    if (s.slots.length !== 2) continue;

    const wiring = structure.get(String(s.id));
    // Which slot won, so the parse can orient itself rather than trusting the
    // string's order — the only thing that can separate two same-named slots.
    const winnerAt = s.winnerId == null ? -1 : s.slots.findIndex((slot) => slot.entrant?.id === s.winnerId);
    const winnerSlot = winnerAt === 0 || winnerAt === 1 ? winnerAt : null;
    const scores = parseDisplayScore(s.displayScore, s.slots[0].entrant?.name, s.slots[1].entrant?.name, winnerSlot);

    const characters = setCharacterCache.get(`${userId}:${s.id}`)?.byEntrant ?? {};

    const slots = s.slots.map((slot, i): BracketSlot => {
      const seed = wiring?.slots?.[i]?.seed;
      const origin = seed?.progressionSource;
      return {
        entrant: slot.entrant,
        // Only meaningful with an entrant in the slot: start.gg returns the
        // seed of whoever is in it, and an empty slot has nobody.
        seedNum: slot.entrant ? (seed?.seedNum ?? null) : null,
        score: scores[i],
        characterId: slot.entrant ? (characters[slot.entrant.id] ?? null) : null,
        prereqSetId: slot.prereqType === 'set' ? slot.prereqId : null,
        prereqPlacement: slot.prereqPlacement === 1 || slot.prereqPlacement === 2 ? slot.prereqPlacement : null,
        progressionOrigin: origin?.originPhase
          ? { phaseName: origin.originPhase.name, poolName: origin.originPhaseGroup?.displayIdentifier ?? null }
          : null,
      };
    }) as [BracketSlot, BracketSlot];

    group.sets.push({
      id: s.id,
      identifier: s.identifier,
      round: s.round,
      fullRoundText: s.fullRoundText,
      state: s.state,
      winnerId: s.winnerId,
      lPlacement: s.lPlacement,
      completedAt: s.completedAt,
      slots,
      winnerAdvancesToPhase: wiring?.winnerProgressionSeed?.phase.name ?? null,
      loserAdvancesToPhase: wiring?.loserProgressionSeed?.phase.name ?? null,
    });
  }

  bracketCache.set(key, { at: Date.now(), result: group });
  return group;
}

/**
 * Tells a TO when this pool changes, so a report by someone else at the same
 * venue lands immediately instead of up to a poll-interval later — and without
 * either of them asking start.gg about it.
 *
 * Carries no set data on purpose: the client refetches with its own token, so
 * visibility stays start.gg's decision rather than this server's.
 */
const HEARTBEAT_MS = 25_000;

/**
 * Everyone entered in a pool, with the main on file for each.
 *
 * Separate from open-sets because that only reaches players with a set still
 * to play, which is the wrong set of people to offer a TO: mains are most
 * useful filled in *before* anything starts, and a player whose current set is
 * finished still has later ones. Seeds carry every entrant in the pool.
 *
 * Kicks off the background main lookup for anyone without one, the same way
 * open-sets does. That is a request per player, but ensureMainComputed already
 * bounds the burst to six concurrent calls, de-dupes in flight, and backs off
 * after a failure — machinery written for precisely this case ("~100 entrants
 * all uncached on a large bracket's first poll"). Not firing it here would
 * leave a player who has no set outstanding permanently unlooked, which is the
 * half of the pool this endpoint exists to reach.
 */
const POOL_PLAYERS_BASE_COST = 3;
/** Measured live: 3.06 objects per seed, entrant plus participant plus player. */
const POOL_PLAYERS_MAX_COST_PER_SEED = 4;
const POOL_PLAYERS_PER_PAGE = pageSizeFor(POOL_PLAYERS_BASE_COST, POOL_PLAYERS_MAX_COST_PER_SEED);

export interface PoolPlayer {
  playerId: number;
  name: string;
  /** Null when no lookup has ever run for them — distinct from a known "none". */
  main: { characterId: number | null; gamesTallied: number; setsConsidered: number } | null;
}

interface PoolPlayersResult {
  phaseGroup: {
    phase: { event: { videogame: { id: number } | null } | null } | null;
    seeds: {
      pageInfo: { totalPages: number };
      nodes: { entrant: { id: number; name: string; participants: { player: { id: number } | null }[] | null } | null }[] | null;
    };
  } | null;
}

const POOL_PLAYERS_QUERY = /* GraphQL */ `
  query PhaseGroupPlayers($phaseGroupId: ID!, $page: Int!, $perPage: Int!) {
    phaseGroup(id: $phaseGroupId) {
      id
      phase {
        event {
          videogame {
            id
          }
        }
      }
      seeds(query: { page: $page, perPage: $perPage }) {
        pageInfo {
          totalPages
        }
        nodes {
          entrant {
            id
            name
            participants {
              player {
                id
              }
            }
          }
        }
      }
    }
  }
`;

// Which entrant is which player cannot change for an event once it is seeded,
// so this is fetched once per pool and kept. The mains themselves are read
// from Postgres on every request, because those change as a TO fills them in.
const poolRosterCache = new Map<string, { videogameId: number | null; players: { playerId: number; name: string }[] }>();

setsRouter.get('/phase-group/:phaseGroupId/players', async (req, res) => {
  const { phaseGroupId } = req.params;
  try {
    let roster = poolRosterCache.get(phaseGroupId);
    if (!roster) {
      const players: { playerId: number; name: string }[] = [];
      let videogameId: number | null = null;
      let page = 1;
      while (true) {
        const data: PoolPlayersResult = await gql<PoolPlayersResult>(req.user!.accessToken, POOL_PLAYERS_QUERY, {
          phaseGroupId,
          page,
          perPage: POOL_PLAYERS_PER_PAGE,
        });
        const group = data.phaseGroup;
        if (!group) {
          res.status(404).json({ error: 'Phase group not found' });
          return;
        }
        videogameId = group.phase?.event?.videogame?.id ?? videogameId;
        for (const node of group.seeds.nodes ?? []) {
          const playerId = node.entrant?.participants?.[0]?.player?.id;
          // A seed with no entrant is an unfilled slot, and a doubles entrant
          // has several players; this app is 1v1, so take the first or skip.
          if (node.entrant && playerId != null) players.push({ playerId, name: node.entrant.name });
        }
        if (page >= group.seeds.pageInfo.totalPages) break;
        page += 1;
      }
      roster = { videogameId, players };
      poolRosterCache.set(phaseGroupId, roster);
    }

    const mains =
      roster.videogameId !== null && roster.players.length > 0
        ? await getPlayerMains(
            roster.players.map((p) => p.playerId),
            roster.videogameId
          )
        : new Map();

    const players: PoolPlayer[] = roster.players.map((player) => {
      const main = mains.get(player.playerId);
      return {
        playerId: player.playerId,
        name: player.name,
        main: main ? { characterId: main.characterId, gamesTallied: main.gamesTallied, setsConsidered: main.setsConsidered } : null,
      };
    });

    // Fire-and-forget, throttled inside ensureMainComputed. A player with no
    // set outstanding is never reached by the open-sets path, so without this
    // they stay unlooked however long the tournament runs.
    if (roster.videogameId !== null) {
      for (const player of players) {
        if (!player.main) ensureMainComputed(req.user!.accessToken, player.playerId, roster.videogameId);
      }
    }
    res.json({ players, videogameId: roster.videogameId });
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : 'Failed to load pool players' });
  }
});

setsRouter.get('/phase-group/:phaseGroupId/events', (req, res) => {
  const { phaseGroupId } = req.params;
  const userId = req.user!.id;
  // Even a data-free ping reveals that a pool exists and just moved, so it
  // takes the same access this server has already seen start.gg grant.
  if (!hasSeenPool(userId, phaseGroupId)) {
    res.status(403).json({ error: 'Load this pool before subscribing to its changes' });
    return;
  }

  res.status(200).set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    // Without this a buffering proxy holds every frame until the stream ends,
    // which for a stream that never ends means forever.
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();
  res.write(': connected\n\n');

  // One detector for the pool, however many TOs are watching it.
  startWatching(phaseGroupId);

  const unsubscribe = subscribe(phaseGroupId, {
    userId,
    send: (event) => {
      if (res.writableEnded || res.destroyed) return false;
      res.write(`event: ${event}\ndata: {}\n\n`);
      return true;
    },
  });

  // A comment frame, not an event: it keeps proxies from closing an idle
  // connection without waking the client up.
  const heartbeat = setInterval(() => {
    if (!res.writableEnded && !res.destroyed) res.write(': ping\n\n');
  }, HEARTBEAT_MS);

  req.on('close', () => {
    clearInterval(heartbeat);
    unsubscribe();
    // Nobody left to tell, so stop asking start.gg about this pool at all.
    if (subscriberCount(phaseGroupId) === 0) stopWatching(phaseGroupId);
  });
});

setsRouter.get('/phase-group/:phaseGroupId/bracket', async (req, res) => {
  const { phaseGroupId } = req.params;
  try {
    const group = await fetchBracketData(req.user!.accessToken, req.user!.id, phaseGroupId);
    if (!group) {
      res.status(404).json({ error: 'Phase group not found' });
      return;
    }
    // start.gg served this pool to their token, so they may be told when it
    // changes. See poolEvents.
    recordPoolAccess(req.user!.id, phaseGroupId);
    res.json(group);
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : 'Failed to load bracket' });
  }
});

setsRouter.get('/phase-group/:phaseGroupId/open-sets', async (req, res) => {
  const { phaseGroupId } = req.params;
  try {
    const { sets, videogameId } = await fetchOpenSets(req.user!.accessToken, req.user!.id, phaseGroupId);

    const playerIds = [...new Set(sets.flatMap((s) => s.entrants.map((e) => e.playerId)).filter((id): id is number => id !== null))];

    // Deliberately NOT folded into the 4s raw-sets cache above — a Postgres
    // read every request, so a background computation that finishes between
    // polls shows up on the very next poll instead of being stuck behind
    // stale cached data for up to 4 extra seconds.
    const mains = videogameId !== null && playerIds.length > 0 ? await getPlayerMains(playerIds, videogameId) : new Map();

    if (videogameId !== null) {
      for (const playerId of playerIds) {
        if (!mains.has(playerId)) {
          ensureMainComputed(req.user!.accessToken, playerId, videogameId);
        }
      }
    }

    // Explicit rebuild, not a spread, so new OpenSetEntrant fields don't leak
    // onto the wire unreviewed. playerId is now included deliberately (the
    // account-management main-correction feature needs it to identify who
    // it's editing) — it's start.gg's own public player id, not sensitive.
    const responseSets = sets.map((s) => ({
      ...s,
      entrants: s.entrants.map((e) => {
        const main = e.playerId !== null ? mains.get(e.playerId) : undefined;
        return {
          id: e.id,
          name: e.name,
          playerId: e.playerId ?? undefined,
          // Nested, and only present once a row actually exists, so the
          // frontend can tell "still computing in the background" (no
          // suggestedMain at all) apart from "checked, found no dominant
          // character" (present, with characterId: null) — both used to
          // collapse to the same bare `undefined` when this was a single
          // suggestedMainCharacterId field, which is exactly the ambiguity
          // that made a silent `m` no-op indistinguishable from "not ready
          // yet." characterId stays a real null here (not `?? undefined`
          // like before) since the object's mere presence already carries
          // that distinction.
          suggestedMain: main
            ? { characterId: main.characterId, gamesTallied: main.gamesTallied, setsConsidered: main.setsConsidered }
            : undefined,
        };
      }),
    }));

    res.json({ sets: responseSets });
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : 'Failed to load sets' });
  }
});

setsRouter.post('/:setId/start', async (req, res) => {
  const { setId } = req.params;
  if (setId.startsWith('preview_')) {
    res.status(400).json({
      error: 'This set is still a bracket preview (the bracket hasn\'t been started on start.gg yet), so there\'s no real set to start.',
    });
    return;
  }
  try {
    await gql<{ markSetInProgress: { id: number } | null }>(req.user!.accessToken, START_SET_MUTATION, { setId });
    invalidateSetCaches(); // force the next fetch to pick up the new state
    // The client sends the pool it is viewing, because a set id alone does not
    // say which bracket moved and looking it up would cost a request.
    if (typeof req.body?.phaseGroupId === 'string') publishPoolChanged(req.body.phaseGroupId);
    res.json({ ok: true });
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : 'Failed to start set' });
  }
});

interface RawGameSelection {
  entrant: { id: number } | null;
  character: { id: number } | null;
}

interface RawGame {
  winnerId: number | null;
  orderNum: number | null;
  stage: { id: number } | null;
  selections: RawGameSelection[] | null;
}

interface SetDetailQueryResult {
  set: {
    games: RawGame[] | null;
  } | null;
}

// Extends the shape pickSetCharacter reads — the character map is the same
// start.gg data either way, so it is modelled once. The frontend already knows
// which entrant won the set (from the bracket data it has), so the map stays
// flat and side-agnostic rather than this endpoint re-deriving that.
export interface SetDetailGame extends SetGame {
  // Narrower than SetGame's: this endpoint drops games with no winner, because
  // the correction UI it feeds replays a set game by game.
  winnerEntrantId: number;
  stageId: number | null;
}

// Root-level `set(id:)`, not scoped through an event — matches the existing
// `/:setId/start` route above. Fetched on demand only when a TO actually
// opens a completed set to correct it, not on every bracket poll — this
// per-game detail (with character/stage picks) is much heavier than the
// aggregate score the bracket endpoint already carries, and is wasted for
// the vast majority of polls where nothing is being corrected.
const SET_DETAIL_QUERY = /* GraphQL */ `
  query SetDetail($setId: ID!) {
    set(id: $setId) {
      games {
        winnerId
        orderNum
        stage {
          id
        }
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
`;

setsRouter.get('/:setId/detail', async (req, res) => {
  const { setId } = req.params;
  try {
    const data = await gql<SetDetailQueryResult>(req.user!.accessToken, SET_DETAIL_QUERY, { setId });
    const rawGames = data.set?.games ?? [];
    const games: SetDetailGame[] = rawGames
      .filter((g): g is RawGame & { winnerId: number; orderNum: number } => g.winnerId !== null && g.orderNum !== null)
      .map((g) => {
        const characterIdByEntrantId: Record<number, number> = {};
        for (const sel of g.selections ?? []) {
          if (sel.entrant && sel.character) characterIdByEntrantId[sel.entrant.id] = sel.character.id;
        }
        return { orderNum: g.orderNum, winnerEntrantId: g.winnerId, stageId: g.stage?.id ?? null, characterIdByEntrantId };
      });
    res.json({ games });
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : 'Failed to load set detail' });
  }
});
