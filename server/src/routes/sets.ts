import { Router } from 'express';
import { gql } from '../startgg.js';
import { getPlayerMains } from '../db/mains.js';
import { ensureMainComputed } from '../mainLookup.js';

export const setsRouter = Router();

const COMPLETED_STATE = 3;
const STARTED_STATE = 2; // ActivityState.ACTIVE — someone's actively playing this set
const PER_PAGE = 75;
const MAX_PAGES = 12;
const CACHE_TTL_MS = 4000;

interface SetsQueryResult {
  event: {
    videogame: { id: number } | null;
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

// Deliberately no sortType here (e.g. STANDARD) — combined with
// filters.hideEmpty, start.gg's API has an eventual-consistency bug where a
// set that just became non-empty (most notably a bracket-reset grand final,
// right after game 1 sends it to a true final) is dropped from the results
// entirely for a while, then reappears wildly out of order. hideEmpty alone
// doesn't hit this. Confirmed against a live event on 2026-09-04.
const SETS_QUERY = /* GraphQL */ `
  query EventOpenSets($eventId: ID!, $page: Int!, $perPage: Int!) {
    event(id: $eventId) {
      videogame {
        id
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

interface OpenSetsResult {
  sets: OpenSet[];
  videogameId: number | null;
}

const cache = new Map<string, { at: number; result: OpenSetsResult }>();

async function fetchOpenSets(accessToken: string, eventId: string): Promise<OpenSetsResult> {
  const cached = cache.get(eventId);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
    return cached.result;
  }

  const open: OpenSet[] = [];
  let page = 1;
  let totalPages = 1;
  let videogameId: number | null = null;

  while (page <= totalPages && page <= MAX_PAGES) {
    const data = await gql<SetsQueryResult>(accessToken, SETS_QUERY, { eventId, page, perPage: PER_PAGE });
    const event = data.event;
    const sets = event?.sets;
    if (!sets) break;
    if (page === 1) videogameId = event.videogame?.id ?? null;
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
  cache.set(eventId, { at: Date.now(), result });
  return result;
}

setsRouter.get('/:eventId/open-sets', async (req, res) => {
  const { eventId } = req.params;
  try {
    const { sets, videogameId } = await fetchOpenSets(req.user!.accessToken, eventId);

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

    // Explicit rebuild, not a spread — playerId is server-internal and must
    // never leak into the response even if OpenSetEntrant gains fields later.
    const responseSets = sets.map((s) => ({
      ...s,
      entrants: s.entrants.map((e) => ({
        id: e.id,
        name: e.name,
        // `?? undefined` matters here: a cached tombstone row (confirmed no
        // computable main) has characterId: null, which needs to become an
        // omitted key on the wire, not a JSON `null`.
        suggestedMainCharacterId: e.playerId !== null ? (mains.get(e.playerId)?.characterId ?? undefined) : undefined,
      })),
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
