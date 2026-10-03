-- Up Migration

-- Who played and what the score was, so the admin list reads as sets rather
-- than as entrant ids. Both are already in hand when a report is recorded —
-- the names come back from start.gg in the read the route makes before
-- writing, and the score from the games the route parsed — so recording them
-- costs no extra request.
--
-- Names are as start.gg had them at the time. A player who renames later still
-- reads as the tag they had at the event, which is what a TO would recognise.
-- Nullable: rows written before this column existed have no names to give.
ALTER TABLE set_reports ADD COLUMN IF NOT EXISTS winner_name TEXT;
ALTER TABLE set_reports ADD COLUMN IF NOT EXISTS loser_name TEXT;
ALTER TABLE set_reports ADD COLUMN IF NOT EXISTS winner_score INTEGER;
ALTER TABLE set_reports ADD COLUMN IF NOT EXISTS loser_score INTEGER;

-- Down Migration

ALTER TABLE set_reports DROP COLUMN IF EXISTS winner_name;
ALTER TABLE set_reports DROP COLUMN IF EXISTS loser_name;
ALTER TABLE set_reports DROP COLUMN IF EXISTS winner_score;
ALTER TABLE set_reports DROP COLUMN IF EXISTS loser_score;
