import { pool } from './pool.js';

export interface PlayerMain {
  playerId: number;
  videogameId: number;
  characterId: number | null;
  gamesTallied: number;
  setsConsidered: number;
  computedAt: Date;
}

interface PlayerMainRow {
  player_id: number;
  videogame_id: number;
  character_id: number | null;
  games_tallied: number;
  sets_considered: number;
  computed_at: Date;
}

function fromRow(row: PlayerMainRow): PlayerMain {
  return {
    playerId: row.player_id,
    videogameId: row.videogame_id,
    characterId: row.character_id,
    gamesTallied: row.games_tallied,
    setsConsidered: row.sets_considered,
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
