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
 * Bounds the walk rather than trusting this pager to terminate — the same
 * field reports totalPages for pages that do not exist, so an unbounded loop
 * against it would spin through an 80/minute budget.
 *
 * 400 stations is roughly twenty times the largest list found on a real
 * tournament (20, measured 2026-09-26), so reaching it means the pager is
 * misbehaving rather than that a venue is enormous.
 */
const MAX_PAGES = 8;

async function fetchEventStations(accessToken: string, eventId: string): Promise<Station[]> {
  const byNumber = new Map<number, Station>();

  // One page past the bound is fetched on purpose. Exactly MAX_PAGES full
  // pages is indistinguishable from a pager that will not stop until the next
  // page is asked for: empty means the list really was that long, anything
  // else means it is still going.
  for (let page = 1; ; page++) {
    const data = await gql<StationsQueryResult>(accessToken, STATIONS_QUERY, { eventId, page, perPage: PER_PAGE });
    const nodes = data.event?.tournament?.stations?.nodes ?? [];
    if (nodes.length === 0) break;

    // Data beyond the bound is a pager that will not stop, not a long list.
    // Returning what was collected would be worse than failing: the caller
    // reports the highest station it saw back to the TO, so a truncated list
    // becomes a confident "it goes up to 400" that is simply untrue.
    if (page > MAX_PAGES) {
      throw new Error(`start.gg kept returning station pages past ${MAX_PAGES * PER_PAGE} for event ${eventId}`);
    }

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
