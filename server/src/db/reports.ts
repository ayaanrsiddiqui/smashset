import { pool } from './pool.js';
import type { BracketRow, ReportRow } from '../adminDashboard.js';

export interface SetReportRecord {
  setId: string;
  phaseGroupId: string;
  userId: number | null;
  winnerEntrantId: string | null;
  loserEntrantId: string | null;
  winnerName: string | null;
  loserName: string | null;
  winnerScore: number | null;
  loserScore: number | null;
  games: number | null;
  winnerCharacterGames: number | null;
  loserCharacterGames: number | null;
  attempt: number | null;
  alreadyOnFile: boolean;
  openToReportMs: number | null;
  deliveryMs: number | null;
  source: 'server' | 'log';
  /** Only for recovered history; a live report is stamped by the database. */
  reportedAt?: Date;
}

export async function recordSetReport(r: SetReportRecord): Promise<void> {
  await pool.query(
    `INSERT INTO set_reports (set_id, phase_group_id, user_id, winner_entrant_id, loser_entrant_id, games,
       winner_character_games, loser_character_games, attempt, already_on_file, open_to_report_ms, delivery_ms,
       source, reported_at, winner_name, loser_name, winner_score, loser_score)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, COALESCE($14, now()), $15, $16, $17, $18)`,
    [
      r.setId,
      r.phaseGroupId,
      r.userId,
      r.winnerEntrantId,
      r.loserEntrantId,
      r.games,
      r.winnerCharacterGames,
      r.loserCharacterGames,
      r.attempt,
      r.alreadyOnFile,
      r.openToReportMs,
      r.deliveryMs,
      r.source,
      r.reportedAt ?? null,
      r.winnerName,
      r.loserName,
      r.winnerScore,
      r.loserScore,
    ]
  );
}

export interface ReportBracket {
  phaseGroupId: string;
  displayIdentifier: string | null;
  phaseName: string | null;
  eventId: string | null;
  eventName: string | null;
  tournamentId: string | null;
  tournamentName: string | null;
  tournamentSlug: string | null;
  /** Null until counted; never zero — see the migration. */
  totalSets: number | null;
}

/** Whether this bracket still needs naming or counting. */
export async function bracketNeedsDetail(phaseGroupId: string): Promise<boolean> {
  const { rows } = await pool.query<{ total_sets: number | null }>(
    'SELECT total_sets FROM report_brackets WHERE phase_group_id = $1',
    [phaseGroupId]
  );
  return rows.length === 0 || rows[0].total_sets === null;
}

/**
 * Names a bracket and records its size. A known total is never overwritten
 * with null: a later fetch that lands in the post-materialisation window, when
 * start.gg briefly reports no sets, must not erase a count already made.
 */
export async function saveReportBracket(b: ReportBracket): Promise<void> {
  await pool.query(
    `INSERT INTO report_brackets (phase_group_id, display_identifier, phase_name, event_id, event_name,
       tournament_id, tournament_name, tournament_slug, total_sets)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (phase_group_id) DO UPDATE SET
       display_identifier = EXCLUDED.display_identifier,
       phase_name         = EXCLUDED.phase_name,
       event_id           = EXCLUDED.event_id,
       event_name         = EXCLUDED.event_name,
       tournament_id      = EXCLUDED.tournament_id,
       tournament_name    = EXCLUDED.tournament_name,
       tournament_slug    = EXCLUDED.tournament_slug,
       total_sets         = COALESCE(EXCLUDED.total_sets, report_brackets.total_sets),
       updated_at         = now()`,
    [
      b.phaseGroupId,
      b.displayIdentifier,
      b.phaseName,
      b.eventId,
      b.eventName,
      b.tournamentId,
      b.tournamentName,
      b.tournamentSlug,
      b.totalSets,
    ]
  );
}

/**
 * Everything the admin dashboard is built from. Read whole and aggregated in
 * code (see adminDashboard) so the rules live somewhere they can be tested.
 * The reporter's name is joined in, and is null once their account is gone.
 */
export async function readDashboardRows(): Promise<{ rows: ReportRow[]; brackets: BracketRow[] }> {
  const [reports, brackets] = await Promise.all([
    pool.query<ReportRow>(
      `SELECT r.id, r.set_id, r.phase_group_id, u.display_name AS reporter, r.winner_name, r.loser_name,
              r.winner_score, r.loser_score, r.games, r.winner_character_games, r.loser_character_games,
              r.already_on_file, r.open_to_report_ms, r.delivery_ms, r.source, r.reported_at
       FROM set_reports r LEFT JOIN users u ON u.id = r.user_id`
    ),
    pool.query<BracketRow>(
      `SELECT phase_group_id, display_identifier, phase_name, event_name, tournament_name, tournament_slug, total_sets
       FROM report_brackets`
    ),
  ]);
  return { rows: reports.rows, brackets: brackets.rows };
}
