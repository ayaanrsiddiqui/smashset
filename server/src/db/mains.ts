import { pool } from './pool.js';

export interface PlayerMain {
  playerId: number;
  videogameId: number;
  characterId: number | null;
  gamesTallied: number;
  setsConsidered: number;
  /**
   * Games on each character id, or null for a player never tallied.
   *
   * The null is what makes a lazy backfill possible: the lookup only fires for
   * players it has nothing for, so without it every row written before tallies
   * existed would keep an empty one forever. An empty object is a real answer
   * ("looked, found no character data"); null is the absence of one.
   */
  characterCounts: Record<number, number> | null;
  computedAt: Date;
}

interface PlayerMainRow {
  player_id: number;
  videogame_id: number;
  character_id: number | null;
  games_tallied: number;
  sets_considered: number;
  character_counts: Record<number, number> | null;
  computed_at: Date;
}

function fromRow(row: PlayerMainRow): PlayerMain {
  return {
    playerId: row.player_id,
    videogameId: row.videogame_id,
    characterId: row.character_id,
    gamesTallied: row.games_tallied,
    setsConsidered: row.sets_considered,
    characterCounts: row.character_counts,
    computedAt: row.computed_at,
  };
}

export async function getPlayerMains(playerIds: number[], videogameId: number): Promise<Map<number, PlayerMain>> {
  if (playerIds.length === 0) return new Map();
  const { rows } = await pool.query<PlayerMainRow>(
    'SELECT * FROM player_mains WHERE player_id = ANY($1) AND videogame_id = $2',
    [playerIds, videogameId]
  );
  return new Map(rows.map((row) => [row.player_id, fromRow(row)]));
}

export async function upsertPlayerMain(
  playerId: number,
  videogameId: number,
  characterId: number | null,
  gamesTallied: number,
  setsConsidered: number
): Promise<PlayerMain> {
  const { rows } = await pool.query<PlayerMainRow>(
    `INSERT INTO player_mains (player_id, videogame_id, character_id, games_tallied, sets_considered)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (player_id, videogame_id) DO UPDATE SET
       character_id    = EXCLUDED.character_id,
       games_tallied   = EXCLUDED.games_tallied,
       sets_considered = EXCLUDED.sets_considered,
       computed_at     = now()
     RETURNING *`,
    [playerId, videogameId, characterId, gamesTallied, setsConsidered]
  );
  return fromRow(rows[0]);
}

/**
 * The background lookup's write: fills a gap, never overrules what is already
 * on file.
 *
 * ensureMainComputed only ever fires for a player with no row, so by the time
 * the lookup returns, a row existing at all means somebody wrote one while it
 * was in flight — in practice the TO, who opened the pool, saw "no main on
 * file" and corrected it in the second the lookup took. A plain upsert lands
 * last and silently throws that correction away. DO NOTHING makes the check
 * and the write one atomic statement, rather than a read followed by a write
 * with the same race in the gap between them.
 *
 * Returns whether it actually wrote.
 */
export async function insertComputedPlayerMain(
  playerId: number,
  videogameId: number,
  characterId: number | null,
  gamesTallied: number,
  setsConsidered: number,
  characterCounts: Record<number, number>
): Promise<boolean> {
  const { rowCount } = await pool.query(
    `INSERT INTO player_mains (player_id, videogame_id, character_id, games_tallied, sets_considered, character_counts)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (player_id, videogame_id) DO NOTHING`,
    [playerId, videogameId, characterId, gamesTallied, setsConsidered, JSON.stringify(characterCounts)]
  );
  return (rowCount ?? 0) > 0;
}

/**
 * Records the tally on a row that already exists, without touching the main.
 *
 * Kept separate from the insert above rather than folded into an ON CONFLICT
 * clause, because the two writes answer to different rules: the main must
 * never overwrite what a TO set by hand, while the tally is derived history
 * that no one typed and that the main says nothing about.
 *
 * `IS NULL` makes it fill-once rather than last-write-wins, so two lookups
 * racing cannot half-apply one tally over the other. It is also what stops a
 * player whose main was set by hand being looked up again on every single
 * poll: without a tally landing on that row, nothing would ever mark them
 * done.
 */
export async function fillCharacterCounts(
  playerId: number,
  videogameId: number,
  characterCounts: Record<number, number>
): Promise<boolean> {
  const { rowCount } = await pool.query(
    `UPDATE player_mains SET character_counts = $3
     WHERE player_id = $1 AND videogame_id = $2 AND character_counts IS NULL`,
    [playerId, videogameId, JSON.stringify(characterCounts)]
  );
  return (rowCount ?? 0) > 0;
}
