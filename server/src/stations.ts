import { gql } from './startgg.js';

export interface Station {
  id: number;
  number: number;
}

/**
 * Every station an event's tournament has, by number.
 *
 * Paged until a page comes back empty, and `pageInfo` is deliberately ignored.
 * Its `total` is not a station count — measured 42 against a tournament with
 * 16 stations, 76 against one with 15, and 15 against one with 8 — and
 * `totalPages` is derived from it, so both lie. Reading `total` once produced a
 * confident and wrong conclusion that most stations were unreachable; the
 * `nodes` list was complete all along.
 */
const STATIONS_QUERY = /* GraphQL */ `
  query EventStations($eventId: ID!, $page: Int!, $perPage: Int!) {
    event(id: $eventId) {
      tournament {
        stations(page: $page, perPage: $perPage) {
          nodes {
            id
            number
          }
        }
      }
    }
  }
`;

interface StationsQueryResult {
  event: { tournament: { stations: { nodes: { id: number; number: number | null }[] | null } | null } | null } | null;
}

const PER_PAGE = 50;
/**
 * Bounds the walk rather than trusting the answer to terminate. A venue with
 * more setups than this does not exist; a paging field that never returns an
 * empty page does, and it would spin against an 80/minute rate limit.
 */
const MAX_PAGES = 8;

async function fetchEventStations(accessToken: string, eventId: string): Promise<Station[]> {
  const byNumber = new Map<number, Station>();

  for (let page = 1; page <= MAX_PAGES; page++) {
    const data = await gql<StationsQueryResult>(accessToken, STATIONS_QUERY, { eventId, page, perPage: PER_PAGE });
    const nodes = data.event?.tournament?.stations?.nodes ?? [];
    if (nodes.length === 0) break;
    for (const node of nodes) {
      // A station with no number cannot be named by a TO, so it is not one we
      // can offer — dropped rather than shown as a blank choice.
      if (node.number != null) byNumber.set(node.number, { id: node.id, number: node.number });
    }
    if (nodes.length < PER_PAGE) break;
  }

  return [...byNumber.values()].sort((a, b) => a.number - b.number);
}

/**
 * Cached because starting a set has to resolve a number to an id, so without
 * this every start costs an extra upstream round trip against an 80/minute
 * limit — on the one action a TO does most at a bracket table. Stations are
 * configured before an event runs and barely change during it, so a minute of
 * staleness costs nothing; a station added mid-tournament shows up on the next
 * fetch rather than needing a restart.
 */
const CACHE_TTL_MS = 60_000;
const cache = new Map<string, { at: number; stations: Station[] }>();

export async function getEventStations(accessToken: string, eventId: string): Promise<Station[]> {
  const hit = cache.get(eventId);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.stations;

  const stations = await fetchEventStations(accessToken, eventId);
  cache.set(eventId, { at: Date.now(), stations });
  return stations;
}

/** Tests only; the cache is module state that outlives one of them. */
export function resetStationCache(): void {
  cache.clear();
}
