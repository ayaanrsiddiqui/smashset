import { gql } from './startgg.js';
import { bracketNeedsDetail, saveReportBracket } from './db/reports.js';

/**
 * What a bracket is called and how many sets it has.
 *
 * pageInfo.total is trusted here and only here: on sets it matched a full walk
 * of the nodes on four real brackets (125, 58, 110 and 11), at a cost of one
 * object. The same field on stations is wrong, which is why that walk ignores
 * it — the lie is specific to stations, not to start.gg's paging.
 */
const BRACKET_DETAIL_QUERY = /* GraphQL */ `
  query ReportBracket($phaseGroupId: ID!) {
    phaseGroup(id: $phaseGroupId) {
      displayIdentifier
      phase {
        name
        event {
          id
          name
          tournament {
            id
            name
            slug
          }
        }
      }
      sets(page: 1, perPage: 1) {
        pageInfo {
          total
        }
      }
    }
  }
`;

interface BracketDetailResult {
  phaseGroup: {
    displayIdentifier: string | null;
    phase: {
      name: string | null;
      event: { id: number; name: string; tournament: { id: number; name: string; slug: string } | null } | null;
    } | null;
    sets: { pageInfo: { total: number | null } | null } | null;
  } | null;
}

const inFlight = new Map<string, Promise<void>>();

/**
 * Names and counts a bracket the first time a report lands in it.
 *
 * Fire-and-forget, like ensureMainComputed: the first report in a bracket must
 * not wait on a start.gg round trip to describe the bracket it is in. A failure
 * is logged and leaves the row incomplete, which is what makes the next report
 * in that bracket try again — no separate retry machinery needed.
 */
export function ensureBracketRecorded(accessToken: string, phaseGroupId: string): void {
  if (inFlight.has(phaseGroupId)) return;

  const task = (async () => {
    if (!(await bracketNeedsDetail(phaseGroupId))) return;
    const data = await gql<BracketDetailResult>(accessToken, BRACKET_DETAIL_QUERY, { phaseGroupId });
    const pg = data.phaseGroup;
    if (!pg) {
      console.warn(`[reports] start.gg has no phase group ${phaseGroupId} to describe`);
      return;
    }
    const event = pg.phase?.event ?? null;
    const total = pg.sets?.pageInfo?.total ?? null;
    await saveReportBracket({
      phaseGroupId,
      displayIdentifier: pg.displayIdentifier,
      phaseName: pg.phase?.name ?? null,
      eventId: event ? String(event.id) : null,
      eventName: event?.name ?? null,
      tournamentId: event?.tournament ? String(event.tournament.id) : null,
      tournamentName: event?.tournament?.name ?? null,
      tournamentSlug: event?.tournament?.slug ?? null,
      // Zero is the post-materialisation window, not an empty bracket — a
      // bracket somebody just reported a set in has at least that set.
      totalSets: total && total > 0 ? total : null,
    });
  })()
    .catch((err) => console.error(`[reports] could not describe phase group ${phaseGroupId}:`, err))
    .finally(() => inFlight.delete(phaseGroupId));
  inFlight.set(phaseGroupId, task);
}

/**
 * Tests only. Waits for every bracket description still running, so a test
 * can assert on what it wrote — and so none of them is left writing to a
 * database pool the suite has already closed.
 */
export async function settleBracketRecording(): Promise<void> {
  await Promise.allSettled([...inFlight.values()]);
}
