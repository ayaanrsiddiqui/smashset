import { Router } from 'express';
import { gql } from '../startgg.js';

export const setsRouter = Router();

const COMPLETED_STATE = 3;
const PER_PAGE = 75;
const MAX_PAGES = 12;
const CACHE_TTL_MS = 4000;

interface SetsQueryResult {
  event: {
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
  slots: { id: string; entrant: { id: number; name: string } | null }[];
}

export interface OpenSet {
  id: number | string;
  isPreview: boolean;
  fullRoundText: string;
  identifier: string;
  entrants: { id: number; name: string }[];
}

const SETS_QUERY = /* GraphQL */ `
  query EventOpenSets($eventId: ID!, $page: Int!, $perPage: Int!) {
    event(id: $eventId) {
      sets(page: $page, perPage: $perPage, sortType: STANDARD, filters: { hideEmpty: true }) {
        pageInfo {
          totalPages
        }
        nodes {
          id
          state
          round
          fullRoundText
          identifier
          slots {
            id
            entrant {
              id
              name
            }
          }
        }
      }
    }
  }
`;

const cache = new Map<string, { at: number; sets: OpenSet[] }>();

async function fetchOpenSets(eventId: string): Promise<OpenSet[]> {
  const cached = cache.get(eventId);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
    return cached.sets;
  }

  const open: OpenSet[] = [];
  let page = 1;
  let totalPages = 1;

  while (page <= totalPages && page <= MAX_PAGES) {
    const data = await gql<SetsQueryResult>(SETS_QUERY, { eventId, page, perPage: PER_PAGE });
    const sets = data.event?.sets;
    if (!sets) break;
    totalPages = sets.pageInfo.totalPages;

    for (const s of sets.nodes) {
      if (s.state === COMPLETED_STATE) continue;
      const entrants = s.slots
        .map((slot) => slot.entrant)
        .filter((e): e is { id: number; name: string } => e !== null);
      if (entrants.length !== 2) continue; // skip byes / not-yet-determined slots
      const isPreview = typeof s.id === 'string' && s.id.startsWith('preview_');
      open.push({ id: s.id, isPreview, fullRoundText: s.fullRoundText, identifier: s.identifier, entrants });
    }
    page++;
  }

  cache.set(eventId, { at: Date.now(), sets: open });
  return open;
}

setsRouter.get('/:eventId/open-sets', async (req, res) => {
  const { eventId } = req.params;
  try {
    const sets = await fetchOpenSets(eventId);
    res.json({ sets });
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : 'Failed to load sets' });
  }
});
