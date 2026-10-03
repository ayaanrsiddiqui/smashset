import { describe, expect, it } from 'vitest';
import { buildDashboard, median, type BracketRow, type ReportRow } from './adminDashboard.js';

let nextId = 1;
function row(over: Partial<ReportRow> & { set_id: string; at: string }): ReportRow {
  const { at, ...rest } = over;
  return {
    id: nextId++,
    phase_group_id: 'pg1',
    reporter: 'FireSlam23',
    winner_name: 'Ada',
    loser_name: 'mudd',
    winner_score: 2,
    loser_score: 0,
    games: 2,
    winner_character_games: 0,
    loser_character_games: 0,
    already_on_file: false,
    open_to_report_ms: null,
    delivery_ms: null,
    source: 'server',
    reported_at: new Date(at),
    ...rest,
  };
}

const BRACKET: BracketRow = {
  phase_group_id: 'pg1',
  display_identifier: '1',
  phase_name: 'Bracket',
  event_name: 'BMS Melee Singles',
  tournament_name: 'Bring More Setups 218',
  tournament_slug: 'tournament/bring-more-setups-218',
  total_sets: 58,
};

describe('median', () => {
  it('takes the middle of an odd count', () => {
    expect(median([9000, 5000, 7000])).toBe(7000);
  });

  it('averages the middle pair of an even count', () => {
    expect(median([5000, 6000, 8000, 30000])).toBe(7000);
  });

  it('is unmoved by one panel left open, where a mean would not be', () => {
    expect(median([6000, 6500, 7000, 9 * 60_000])).toBe(6750);
  });

  it('is nothing for no values, not zero', () => {
    // Zero would read as "instant", which is the most flattering wrong answer.
    expect(median([])).toBeNull();
  });
});

describe('buildDashboard', () => {
  it('counts sets, not reports, so a correction does not inflate the total', () => {
    const d = buildDashboard(
      [row({ set_id: 's1', at: '2026-10-02T20:00:00Z' }), row({ set_id: 's1', at: '2026-10-02T20:01:00Z' })],
      [BRACKET]
    );

    expect(d.brackets[0].summary.reportedSets).toBe(1);
    expect(d.brackets[0].summary.correctedSets).toBe(1);
  });

  it('carries the bracket total so the page can say reported X of Y', () => {
    const d = buildDashboard([row({ set_id: 's1', at: '2026-10-02T20:00:00Z' })], [BRACKET]);

    expect(d.brackets[0]).toMatchObject({ totalSets: 58, tournamentName: 'Bring More Setups 218' });
    expect(d.brackets[0].summary.reportedSets).toBe(1);
  });

  it('times a set by its first report, not by a later correction', () => {
    const d = buildDashboard(
      [
        row({ set_id: 's1', at: '2026-10-02T20:00:00Z', open_to_report_ms: 6000 }),
        row({ set_id: 's1', at: '2026-10-02T20:05:00Z', open_to_report_ms: 40000 }),
      ],
      [BRACKET]
    );

    expect(d.brackets[0].sets[0].openToReportMs).toBe(6000);
  });

  it('shows the score a set was left at, from its latest report', () => {
    const d = buildDashboard(
      [
        row({ set_id: 's1', at: '2026-10-02T20:00:00Z', winner_score: 2, loser_score: 0 }),
        row({ set_id: 's1', at: '2026-10-02T20:05:00Z', winner_score: 2, loser_score: 1 }),
      ],
      [BRACKET]
    );

    expect(d.brackets[0].sets[0]).toMatchObject({ winnerScore: 2, loserScore: 1 });
  });

  it('never takes a timing from a retry that found its result already on start.gg', () => {
    // That retry reported nothing. Its timings were never stored, and even if
    // they were they would describe the attempt that actually landed.
    const d = buildDashboard(
      [
        row({ set_id: 's1', at: '2026-10-02T20:00:00Z', open_to_report_ms: 6000 }),
        row({ set_id: 's1', at: '2026-10-02T20:00:30Z', already_on_file: true, open_to_report_ms: 99000 }),
      ],
      [BRACKET]
    );

    expect(d.brackets[0].sets[0]).toMatchObject({ openToReportMs: 6000, reports: 1, foundOnFile: 1 });
    expect(d.brackets[0].summary).toMatchObject({ reportedSets: 1, correctedSets: 0, foundOnFile: 1 });
  });

  it('still counts a set whose only record is a found-on-file retry', () => {
    // The server died between start.gg confirming and the first row being
    // written. The retry is the only proof the set was reported at all.
    const d = buildDashboard(
      [row({ set_id: 's1', at: '2026-10-02T20:00:00Z', already_on_file: true })],
      [BRACKET]
    );

    expect(d.brackets[0].summary.reportedSets).toBe(1);
    expect(d.brackets[0].sets[0].openToReportMs).toBeNull();
  });

  it('takes medians over sets that were timed, and says how many', () => {
    const d = buildDashboard(
      [
        row({ set_id: 's1', at: '2026-10-02T20:00:00Z', open_to_report_ms: 5000, delivery_ms: 400 }),
        row({ set_id: 's2', at: '2026-10-02T20:01:00Z', open_to_report_ms: 7000, delivery_ms: 600 }),
        row({ set_id: 's3', at: '2026-10-02T20:02:00Z' }),
      ],
      [BRACKET]
    );

    expect(d.brackets[0].summary).toMatchObject({
      reportedSets: 3,
      medianOpenToReportMs: 6000,
      timedSets: 2,
      medianDeliveryMs: 500,
      deliveredSets: 2,
    });
  });

  it('counts sets with characters for both players, for either, and out of how many', () => {
    const d = buildDashboard(
      [
        row({ set_id: 's1', at: '2026-10-02T20:00:00Z', winner_character_games: 2, loser_character_games: 2 }),
        row({ set_id: 's2', at: '2026-10-02T20:01:00Z', winner_character_games: 2, loser_character_games: 0 }),
        row({ set_id: 's3', at: '2026-10-02T20:02:00Z' }),
        // Recovered from logs: character data unknown, so in no denominator.
        row({ set_id: 's4', at: '2026-10-02T20:03:00Z', source: 'log', winner_character_games: null, loser_character_games: null }),
      ],
      [BRACKET]
    );

    expect(d.brackets[0].summary).toMatchObject({ bothCharacters: 1, anyCharacters: 2, charactersKnown: 3 });
  });

  it('marks a set recovered from the logs, so its missing timings read as expected', () => {
    const d = buildDashboard([row({ set_id: 's1', at: '2026-10-02T20:00:00Z', source: 'log' })], [BRACKET]);

    expect(d.brackets[0].sets[0].fromLog).toBe(true);
  });

  it('keeps brackets apart and puts the most recently active first', () => {
    const d = buildDashboard(
      [
        row({ set_id: 'old', phase_group_id: 'pg-old', at: '2026-09-01T20:00:00Z' }),
        row({ set_id: 'new', phase_group_id: 'pg-new', at: '2026-10-02T20:00:00Z' }),
      ],
      []
    );

    expect(d.brackets.map((b) => b.phaseGroupId)).toEqual(['pg-new', 'pg-old']);
  });

  it('lists the newest set first within a bracket', () => {
    const d = buildDashboard(
      [row({ set_id: 'first', at: '2026-10-02T20:00:00Z' }), row({ set_id: 'second', at: '2026-10-02T21:00:00Z' })],
      [BRACKET]
    );

    expect(d.brackets[0].sets.map((s) => s.setId)).toEqual(['second', 'first']);
  });

  it('shows a bracket that has not been named or counted yet, rather than dropping its sets', () => {
    const d = buildDashboard([row({ set_id: 's1', phase_group_id: 'unnamed', at: '2026-10-02T20:00:00Z' })], []);

    expect(d.brackets[0]).toMatchObject({ phaseGroupId: 'unnamed', tournamentName: null, totalSets: null });
    expect(d.brackets[0].summary.reportedSets).toBe(1);
  });

  it('computes the overall figures across every bracket, not as a median of medians', () => {
    const d = buildDashboard(
      [
        row({ set_id: 'a1', phase_group_id: 'A', at: '2026-10-02T20:00:00Z', open_to_report_ms: 1000 }),
        row({ set_id: 'a2', phase_group_id: 'A', at: '2026-10-02T20:01:00Z', open_to_report_ms: 2000 }),
        row({ set_id: 'a3', phase_group_id: 'A', at: '2026-10-02T20:02:00Z', open_to_report_ms: 3000 }),
        row({ set_id: 'b1', phase_group_id: 'B', at: '2026-10-02T20:03:00Z', open_to_report_ms: 100000 }),
      ],
      []
    );

    // Median of the four sets is 2500; the median of the two bracket medians
    // (2000 and 100000) would be 51000.
    expect(d.overall).toMatchObject({ reportedSets: 4, medianOpenToReportMs: 2500 });
  });

  it('is empty, not broken, before anything has been reported', () => {
    const d = buildDashboard([], []);

    expect(d.brackets).toEqual([]);
    expect(d.overall).toMatchObject({ reportedSets: 0, medianOpenToReportMs: null });
  });
});
