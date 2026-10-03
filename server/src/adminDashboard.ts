/**
 * Turns the raw report log into what the admin dashboard shows.
 *
 * Pure, so every rule below is tested directly rather than through SQL. The
 * volume is one row per report a TO made, which stays small enough to read
 * whole for a page only the admin opens.
 *
 * The rules, decided before any number was collected:
 * - A set is a distinct set_id. Corrections and retries add rows, not sets.
 * - Timings come from each set's FIRST real report. "Time to report a set" is
 *   how long it took to report it; a later correction is a separate action.
 * - Names, score and characters come from its LATEST real report — the state
 *   the set was left in.
 * - A retry that found its result already on start.gg is not a real report: it
 *   is counted, but never supplies a timing. A set that has only such a row
 *   (its first row lost) still counts as reported, with no timings.
 * - Medians, never means: one panel left open would drag a mean anywhere.
 */

export interface ReportRow {
  id: number;
  set_id: string;
  phase_group_id: string;
  reporter: string | null;
  winner_name: string | null;
  loser_name: string | null;
  winner_score: number | null;
  loser_score: number | null;
  games: number | null;
  winner_character_games: number | null;
  loser_character_games: number | null;
  already_on_file: boolean;
  open_to_report_ms: number | null;
  delivery_ms: number | null;
  source: 'server' | 'log';
  reported_at: Date;
}

export interface BracketRow {
  phase_group_id: string;
  display_identifier: string | null;
  phase_name: string | null;
  event_name: string | null;
  tournament_name: string | null;
  tournament_slug: string | null;
  total_sets: number | null;
}

export interface Summary {
  reportedSets: number;
  medianOpenToReportMs: number | null;
  /** Sets that contributed to that median — a median of three says little. */
  timedSets: number;
  medianDeliveryMs: number | null;
  deliveredSets: number;
  /** Sets whose latest report had a character for both players. */
  bothCharacters: number;
  /** For at least one of the two. */
  anyCharacters: number;
  /** The denominator for both: sets whose character data is known at all. */
  charactersKnown: number;
  /** Sets reported more than once — a TO correcting a score. */
  correctedSets: number;
  /** Retries that found the result already on start.gg. */
  foundOnFile: number;
}

export interface DashboardSet {
  setId: string;
  firstReportedAt: string;
  reporter: string | null;
  winnerName: string | null;
  loserName: string | null;
  winnerScore: number | null;
  loserScore: number | null;
  games: number | null;
  winnerCharacterGames: number | null;
  loserCharacterGames: number | null;
  openToReportMs: number | null;
  deliveryMs: number | null;
  reports: number;
  foundOnFile: number;
  /** Recovered from Railway's logs after the fact, so it has no timings. */
  fromLog: boolean;
}

export interface DashboardBracket {
  phaseGroupId: string;
  tournamentName: string | null;
  tournamentSlug: string | null;
  eventName: string | null;
  phaseName: string | null;
  displayIdentifier: string | null;
  /** Null until counted. Never zero — see the migration. */
  totalSets: number | null;
  summary: Summary;
  /** Newest first. */
  sets: DashboardSet[];
}

export interface Dashboard {
  overall: Summary;
  /** Most recently active first. */
  brackets: DashboardBracket[];
}

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

function byTime(a: ReportRow, b: ReportRow): number {
  return a.reported_at.getTime() - b.reported_at.getTime() || a.id - b.id;
}

function summariseSet(rows: ReportRow[]): DashboardSet {
  const ordered = [...rows].sort(byTime);
  const real = ordered.filter((r) => !r.already_on_file);
  const first = real[0] ?? null;
  // A set with only a found-on-file row still has to show something; that row
  // is the only description of it there is.
  const latest = real[real.length - 1] ?? ordered[ordered.length - 1];
  return {
    setId: latest.set_id,
    firstReportedAt: ordered[0].reported_at.toISOString(),
    reporter: latest.reporter,
    winnerName: latest.winner_name,
    loserName: latest.loser_name,
    winnerScore: latest.winner_score,
    loserScore: latest.loser_score,
    games: latest.games,
    winnerCharacterGames: latest.winner_character_games,
    loserCharacterGames: latest.loser_character_games,
    openToReportMs: first?.open_to_report_ms ?? null,
    deliveryMs: first?.delivery_ms ?? null,
    reports: real.length,
    foundOnFile: ordered.length - real.length,
    fromLog: ordered.some((r) => r.source === 'log'),
  };
}

export function summarise(sets: DashboardSet[]): Summary {
  const open = sets.map((s) => s.openToReportMs).filter((ms): ms is number => ms !== null);
  const delivery = sets.map((s) => s.deliveryMs).filter((ms): ms is number => ms !== null);
  const known = sets.filter((s) => s.winnerCharacterGames !== null && s.loserCharacterGames !== null);
  return {
    reportedSets: sets.length,
    medianOpenToReportMs: median(open),
    timedSets: open.length,
    medianDeliveryMs: median(delivery),
    deliveredSets: delivery.length,
    bothCharacters: known.filter((s) => s.winnerCharacterGames! > 0 && s.loserCharacterGames! > 0).length,
    anyCharacters: known.filter((s) => s.winnerCharacterGames! > 0 || s.loserCharacterGames! > 0).length,
    charactersKnown: known.length,
    correctedSets: sets.filter((s) => s.reports > 1).length,
    foundOnFile: sets.reduce((n, s) => n + s.foundOnFile, 0),
  };
}

export function buildDashboard(rows: ReportRow[], brackets: BracketRow[]): Dashboard {
  const bracketById = new Map(brackets.map((b) => [b.phase_group_id, b]));

  const rowsBySet = new Map<string, ReportRow[]>();
  for (const row of rows) {
    const list = rowsBySet.get(row.set_id);
    if (list) list.push(row);
    else rowsBySet.set(row.set_id, [row]);
  }

  const setsByBracket = new Map<string, DashboardSet[]>();
  const lastActivity = new Map<string, number>();
  for (const setRows of rowsBySet.values()) {
    const set = summariseSet(setRows);
    const phaseGroupId = setRows[0].phase_group_id;
    const list = setsByBracket.get(phaseGroupId);
    if (list) list.push(set);
    else setsByBracket.set(phaseGroupId, [set]);
    const newest = Math.max(...setRows.map((r) => r.reported_at.getTime()));
    lastActivity.set(phaseGroupId, Math.max(lastActivity.get(phaseGroupId) ?? 0, newest));
  }

  const out: DashboardBracket[] = [...setsByBracket.entries()].map(([phaseGroupId, sets]) => {
    const b = bracketById.get(phaseGroupId);
    return {
      phaseGroupId,
      tournamentName: b?.tournament_name ?? null,
      tournamentSlug: b?.tournament_slug ?? null,
      eventName: b?.event_name ?? null,
      phaseName: b?.phase_name ?? null,
      displayIdentifier: b?.display_identifier ?? null,
      totalSets: b?.total_sets ?? null,
      summary: summarise(sets),
      sets: [...sets].sort((a, z) => z.firstReportedAt.localeCompare(a.firstReportedAt)),
    };
  });
  out.sort((a, z) => (lastActivity.get(z.phaseGroupId) ?? 0) - (lastActivity.get(a.phaseGroupId) ?? 0));

  return { overall: summarise(out.flatMap((b) => b.sets)), brackets: out };
}
