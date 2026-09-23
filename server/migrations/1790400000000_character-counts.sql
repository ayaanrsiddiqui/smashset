-- Up Migration

-- Every character a player has been seen on, not just the one they played
-- most. The tally is what orders the character dropdowns, so a TO opening one
-- sees that player's actual pool of characters instead of an alphabetical
-- list they have to type their way out of.
--
-- JSONB rather than a second table: nothing ever queries *by* character, only
-- ever reads one player's whole tally, and keeping it on the row leaves the
-- existing single-row-per-player read path alone.
--
-- NULL means "never tallied", which is load-bearing: the background lookup
-- only fires for players it has nothing for, so without a way to tell an
-- un-tallied row from a genuinely empty one, every player already on file
-- would keep an empty tally forever. Rows heal as pools get viewed.
ALTER TABLE player_mains ADD COLUMN IF NOT EXISTS character_counts JSONB;

-- Down Migration

-- Only a derived cache of start.gg history — dropping it loses nothing a
-- lookup cannot recompute. The hand-set character_id in the same row, which is
-- the only thing here a TO actually typed, is untouched.
ALTER TABLE player_mains DROP COLUMN IF EXISTS character_counts;
