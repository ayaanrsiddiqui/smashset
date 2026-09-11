import { Router } from 'express';
import { gql } from '../startgg.js';
import { getPlayerMains } from '../db/mains.js';
import { ensureMainComputed } from '../mainLookup.js';

export const setsRouter = Router();

const COMPLETED_STATE = 3;
const STARTED_STATE = 2; // ActivityState.ACTIVE — someone's actively playing this set
const PER_PAGE = 75;
const MAX_PAGES = 12;
// BRACKET_QUERY's per-set payload is much heavier than SETS_QUERY's (full
// slot/prereq/progression detail vs. just entrants) — start.gg caps each
// request at 1000 "objects" of query complexity, and 75 sets' worth of that
// heavier shape alone already exceeds it (confirmed live: actual 1340 at
// perPage 75, ~18 complexity/set). 50/page stays safely under that. Both
// queries are now scoped to a single phaseGroup rather than a whole event
// (see fetchPhaseGroups below), so MAX_PAGES no longer needs to cover a
// potentially huge multi-pool event — a single pool comfortably fits well
// under the old ~900-set ceiling.
const BRACKET_PER_PAGE = 50;
const BRACKET_MAX_PAGES = 10;
const CACHE_TTL_MS = 4000;

export interface PhaseGroupSummary {
  id: number;
  displayIdentifier: string;
  phaseName: string;
  bracketType: string;
}

interface PhaseGroupsQueryResult {
  event: {
    phaseGroups: { id: number; displayIdentifier: string; bracketType: string; phase: { name: string } }[] | null;
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
          name
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
      phaseName: pg.phase.name,
      bracketType: pg.bracketType,
    }));
    res.json({ phaseGroups });
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : 'Failed to load phase groups' });
  }
});

interface SetsQueryResult {
  phaseGroup: {
    phase: { event: { videogame: { id: number } | null } | null } | null;
    sets: {
      pageInfo: { totalPages: number };
      nodes: RawSet[];
    };
  } | null;
}

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

interface RawBracketSet {
  id: number | string;
  identifier: string;
  round: number;
  fullRoundText: string;
  state: number;
  winnerId: number | null;
  lPlacement: number | null;
  // Present only on a set whose winner/loser placement is itself seeded
  // into a *later* phase (a pool's terminal matches feeding the next
  // bracket) — null for a set whose result only matters within this same
  // phaseGroup.
  winnerProgressionSeed: { phase: { name: string } } | null;
  loserProgressionSeed: { phase: { name: string } } | null;
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
    standing: { stats: { score: { value: number | null } | null } | null } | null;
    // Only meaningful when prereqType is "seed" — the seed this slot was
    // freshly filled from, whose progressionSource (present only if that
    // seed was itself produced by an earlier phase, e.g. a pool feeding a
    // bracket) says where this entrant qualified in from.
    seed: {
      progressionSource: {
        originPhase: { name: string } | null;
        originPhaseGroup: { displayIdentifier: string } | null;
      } | null;
    } | null;
  }[];
}

interface BracketQueryResult {
  phaseGroup: {
    id: number;
    displayIdentifier: string;
    bracketType: string;
    phase: { name: string };
    sets: {
      pageInfo: { totalPages: number };
      nodes: RawBracketSet[];
    };
  } | null;
}

export interface BracketSlot {
  entrant: { id: number; name: string } | null;
  score: number | null;
  // A same-response Set.id this slot is fed by (winner or loser, per
  // prereqPlacement below), or null once the slot is already filled, or if
  // the prereq is a seed rather than another set (first-round slots).
  prereqSetId: string | null;
  prereqPlacement: 1 | 2 | null;
  // Where this slot's entrant qualified in from, if this phaseGroup itself
  // isn't the first phase they entered — null for a slot fed by a prior set
  // in this same group, or seeded from the event's initial registration.
  progressionOrigin: { phaseName: string; poolName: string | null } | null;
}

export interface BracketSet {
  id: number | string;
  identifier: string;
  round: number;
  fullRoundText: string;
  state: number;
  winnerId: number | null;
  lPlacement: number | null;
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

// Unlike SETS_QUERY above, deliberately no filters.hideEmpty and no skipping
// of completed/placeholder sets below — this powers the full bracket
// (completed scores, and not-yet-reachable "winner of X" slots), which needs
// the whole tree, not just what's currently reportable. No sortType either,
// for the same eventual-consistency caution as SETS_QUERY — this endpoint
// doesn't depend on API return order since every consumer sorts by round/
// identifier itself.
const BRACKET_QUERY = /* GraphQL */ `
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
            entrant {
              id
              name
            }
            prereqType
            prereqId
            prereqPlacement
            seed {
              progressionSource {
                originPhase {
                  name
                }
                originPhaseGroup {
                  displayIdentifier
                }
              }
            }
            standing {
              stats {
                score {
                  value
                }
              }
            }
          }
        }
      }
    }
  }
`;

interface OpenSetsResult {
  sets: OpenSet[];
  videogameId: number | null;
}

const cache = new Map<string, { at: number; result: OpenSetsResult }>();

async function fetchOpenSets(accessToken: string, phaseGroupId: string): Promise<OpenSetsResult> {
  const cached = cache.get(phaseGroupId);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
    return cached.result;
  }

  const open: OpenSet[] = [];
  let page = 1;
  let totalPages = 1;
  let videogameId: number | null = null;

  while (page <= totalPages && page <= MAX_PAGES) {
    const data = await gql<SetsQueryResult>(accessToken, SETS_QUERY, { phaseGroupId, page, perPage: PER_PAGE });
    const pg = data.phaseGroup;
    const sets = pg?.sets;
    if (!sets) break;
    if (page === 1) videogameId = pg.phase?.event?.videogame?.id ?? null;
    totalPages = sets.pageInfo.totalPages;

    for (const s of sets.nodes) {
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
    page++;
  }

  const result: OpenSetsResult = { sets: open, videogameId };
  cache.set(phaseGroupId, { at: Date.now(), result });
  return result;
}

// Separate from `cache` above — different query, different shape, and this
// one's read far less often (once per bracket-view poll cycle vs. every
// open-sets poll), so it shouldn't share a TTL clock or a key namespace with it.
const bracketCache = new Map<string, { at: number; result: BracketGroup | null }>();

async function fetchBracketData(accessToken: string, phaseGroupId: string): Promise<BracketGroup | null> {
  const cached = bracketCache.get(phaseGroupId);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
    return cached.result;
  }

  let group: BracketGroup | null = null;
  let page = 1;
  let totalPages = 1;

  while (page <= totalPages && page <= BRACKET_MAX_PAGES) {
    const data = await gql<BracketQueryResult>(accessToken, BRACKET_QUERY, { phaseGroupId, page, perPage: BRACKET_PER_PAGE });
    const pg = data.phaseGroup;
    if (!pg) break;
    if (!group) {
      group = { phaseGroupId: pg.id, phaseName: pg.phase.name, displayIdentifier: pg.displayIdentifier, bracketType: pg.bracketType, sets: [] };
    }
    totalPages = pg.sets.pageInfo.totalPages;

    for (const s of pg.sets.nodes) {
      // Defensive: this app only deals in 1v1 sets; skip anything else
      // rather than let a malformed node reach the frontend's layout code.
      if (s.slots.length !== 2) continue;

      const slots = s.slots.map((slot): BracketSlot => {
        const origin = slot.seed?.progressionSource;
        return {
          entrant: slot.entrant,
          score: slot.standing?.stats?.score?.value ?? null,
          prereqSetId: slot.prereqType === 'set' ? slot.prereqId : null,
          prereqPlacement: slot.prereqPlacement === 1 || slot.prereqPlacement === 2 ? slot.prereqPlacement : null,
          progressionOrigin: origin?.originPhase ? { phaseName: origin.originPhase.name, poolName: origin.originPhaseGroup?.displayIdentifier ?? null } : null,
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
        slots,
        winnerAdvancesToPhase: s.winnerProgressionSeed?.phase.name ?? null,
        loserAdvancesToPhase: s.loserProgressionSeed?.phase.name ?? null,
      });
    }
    page++;
  }

  bracketCache.set(phaseGroupId, { at: Date.now(), result: group });
  return group;
}

setsRouter.get('/phase-group/:phaseGroupId/bracket', async (req, res) => {
  const { phaseGroupId } = req.params;
  try {
    const group = await fetchBracketData(req.user!.accessToken, phaseGroupId);
    if (!group) {
      res.status(404).json({ error: 'Phase group not found' });
      return;
    }
    res.json(group);
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : 'Failed to load bracket' });
  }
});

setsRouter.get('/phase-group/:phaseGroupId/open-sets', async (req, res) => {
  const { phaseGroupId } = req.params;
  try {
    const { sets, videogameId } = await fetchOpenSets(req.user!.accessToken, phaseGroupId);

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
    cache.clear(); // force the next open-sets fetch to pick up the new state
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

export interface SetDetailGame {
  orderNum: number;
  winnerEntrantId: number;
  stageId: number | null;
  // Character id per entrant who made a pick, keyed by that entrant's id —
  // the frontend already knows which entrant is the set's overall winner vs
  // loser (from the bracket data it already has), so this stays a flat,
  // side-agnostic map rather than this endpoint re-deriving that itself.
  characterIdByEntrantId: Record<number, number>;
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
