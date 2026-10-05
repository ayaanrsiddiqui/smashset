-- Up Migration

-- Bring More Setups 218 (2 Oct 2026), the only smashset history from before
-- set_reports existed. Its source is server/backfill/report-log-lines-2026-10-03.jsonl:
-- the report-delivered lines the client beacon left in Railway's logs, saved
-- to the repo because Railway purges logs along with their deployment. Data
-- lives in a migration so it is reviewed, gated by CI and applied exactly once,
-- instead of written to production by hand.
--
-- One row per log line, as the server keeps one per confirmed report: three
-- sets were reported twice, 20-40s apart, and the dashboard marks them corrected.
--
-- Winner, score and characters are start.gg's record of each set, which here
-- is exactly what smashset sent. start.gg's updatedAt moves on every re-report,
-- and for all 13 sets it lands 3-11s before smashset's last log line (the
-- beacon trailing start.gg's confirmation), so nothing edited them afterwards.
-- That is why characters are here after all, despite the note in
-- 1791000000000_set-reports. The earlier row of a corrected set was overwritten
-- by the correction, so its result stays null rather than borrowing that one.
--
-- Still null, because nothing recorded them: who reported (the beacon carried
-- a random tab id, not an account) and both timings. reported_at is when the
-- log line arrived, a few seconds after start.gg confirmed.
--
-- A report reached the logs only if the browser's follow-up beacon did, so
-- these sets are a floor on what smashset reported that night, not a count.

INSERT INTO report_brackets (phase_group_id, display_identifier, phase_name, event_id, event_name,
  tournament_id, tournament_name, tournament_slug, total_sets) VALUES
  ('3476627', '1', 'Bracket', '1721564', 'BMS Ultimate Singles', '958782', 'Bring More Setups 218', 'tournament/bring-more-setups-218', 125),
  ('3476629', '1', 'Bracket', '1721566', 'BMS Melee Singles', '958782', 'Bring More Setups 218', 'tournament/bring-more-setups-218', 58)
-- A row the server already wrote describes the bracket as recently as this one.
ON CONFLICT (phase_group_id) DO NOTHING;

INSERT INTO set_reports (set_id, phase_group_id, winner_entrant_id, loser_entrant_id, winner_name, loser_name,
  winner_score, loser_score, games, winner_character_games, loser_character_games, attempt, source, reported_at) VALUES
  ('108437297', '3476627', '24876495', '24877173', 'SNACK?', 'Raf', 2, 0, 2, 0, 0, 1, 'log', '2026-10-02T23:48:51.704100Z'),
  ('108437426', '3476627', '24875887', '24871847', 'Irvy', 'Phoenix pop', 2, 0, 2, 2, 2, 1, 'log', '2026-10-03T01:24:31.784434Z'),
  ('108437429', '3476627', '24873904', '24872779', 'hsnake', 'SMFN | Minish', 2, 1, 3, 3, 3, 1, 'log', '2026-10-03T01:26:01.958219Z'),
  ('108447394', '3476629', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 1, 'log', '2026-10-03T01:32:22.515502Z'),
  ('108447394', '3476629', '24876181', '24836535', 'BMS | Quote', 'GEI | On Der Eh', 2, 0, 2, 0, 0, 1, 'log', '2026-10-03T01:33:02.605060Z'),
  ('108437319', '3476627', '24872318', '24875421', 'Team Insano | Wrap!', 'SMFN | Chironi', 3, 1, 4, 4, 4, 1, 'log', '2026-10-03T01:37:43.348424Z'),
  ('108437439', '3476627', '24876316', '24875887', 'JL | FireSlam23', 'Irvy', 2, 1, 3, 3, 3, 1, 'log', '2026-10-03T01:49:07.642759Z'),
  ('108437443', '3476627', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 1, 'log', '2026-10-03T02:07:11.921472Z'),
  ('108437443', '3476627', '24876316', '24864639', 'JL | FireSlam23', 'Big lando', 2, 1, 3, 3, 3, 1, 'log', '2026-10-03T02:07:32.108043Z'),
  ('108437446', '3476627', '24876316', '24874199', 'JL | FireSlam23', 'SK | SMFN | Karan', 3, 1, 4, 4, 4, 1, 'log', '2026-10-03T02:24:15.960010Z'),
  ('108447339', '3476629', '24872682', '24873338', 'Anakin', 'PicanteThought', 3, 2, 5, 5, 5, 1, 'log', '2026-10-03T02:36:49.797296Z'),
  ('108447402', '3476629', '24872683', '24879394', 'sampy', 'BUG | Bob-omb', 3, 0, 3, 3, 3, 1, 'log', '2026-10-03T02:56:04.294955Z'),
  ('108447403', '3476629', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 1, 'log', '2026-10-03T03:06:07.341723Z'),
  ('108447403', '3476629', '24873338', '24872683', 'PicanteThought', 'sampy', 3, 0, 3, 3, 3, 1, 'log', '2026-10-03T03:06:27.185796Z'),
  ('108447340', '3476629', '24872682', '24873338', 'Anakin', 'PicanteThought', 3, 2, 5, 5, 5, 1, 'log', '2026-10-03T03:21:40.263466Z'),
  ('108447310', '3476629', '24877381', '24837239', 'Bill The Chicken Jr.', 'Riiku Laylee', 2, 0, 2, 2, 2, 1, 'log', '2026-10-03T05:08:27.297883Z');

-- Down Migration

-- Removes exactly the rows Up added. The bracket rows stay: they only name and
-- size brackets, show nothing without reports, and may predate this migration.
DELETE FROM set_reports WHERE source = 'log' AND set_id IN (
  '108437297', '108437319', '108437426', '108437429', '108437439', '108437443', '108437446', '108447310', '108447339', '108447340', '108447394', '108447402', '108447403'
);
