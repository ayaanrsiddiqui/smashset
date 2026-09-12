import { afterAll, describe, expect, it } from 'vitest';
import { pool } from './pool.js';
import { getPlayerMains, upsertPlayerMain } from './mains.js';
import { closeTestPool } from '../test-helpers.js';

// Real start.gg player ids are always positive — negative ids are a
// collision-proof way to mark rows this file created, cleaned up in afterAll.
// (player_id is a plain INTEGER with no natural string-prefix hook like
// users.startgg_user_id has.)
//
// Negative is not enough on its own, though: several files share one database
// and vitest runs them concurrently, so each owns a block. This file owns
// -1..-99; routes/sets.test.ts owns -101, -102 and -300 downward;
// routes/mains.test.ts owns -201. Walking past the end of this block would
// start handing out ids another file is asserting on, while the afterAll below
// — which deletes exactly this range — left those rows behind. Both failures
// would surface in a different file, so it stops loudly here instead.
const FIRST_TEST_ID = -1;
const LAST_TEST_ID = -99;
let nextTestId = FIRST_TEST_ID;
function testPlayerId(): number {
  if (nextTestId < LAST_TEST_ID) {
    throw new Error(
      `db/mains.test.ts owns player ids ${FIRST_TEST_ID}..${LAST_TEST_ID} and has used every one. ` +
        'Widen the block and the afterAll delete together, keeping clear of the blocks the other files own.'
    );
  }
  return nextTestId--;
}

const VIDEOGAME_ID = 1386; // Super Smash Bros. Ultimate

describe('db/mains', () => {
  afterAll(async () => {
    // Scoped to this file's own id block (see testPlayerId): three test files
    // share one database and vitest runs them in parallel, so a blanket delete
    // of every negative player id wipes the others' rows mid-test.
    await pool.query('DELETE FROM player_mains WHERE player_id BETWEEN $1 AND $2', [LAST_TEST_ID, FIRST_TEST_ID]);
    await closeTestPool();
  });

  it('upsertPlayerMain inserts a new row and getPlayerMains reads it back', async () => {
    const playerId = testPlayerId();
    const inserted = await upsertPlayerMain(playerId, VIDEOGAME_ID, 1338, 7, 10);

    expect(inserted).toMatchObject({
      playerId,
      videogameId: VIDEOGAME_ID,
      characterId: 1338,
      gamesTallied: 7,
      setsConsidered: 10,
    });

    const mains = await getPlayerMains([playerId], VIDEOGAME_ID);
    expect(mains.get(playerId)).toMatchObject({ characterId: 1338, gamesTallied: 7, setsConsidered: 10 });
  });

  it('upsertPlayerMain on an existing (player_id, videogame_id) pair overwrites in place rather than duplicating', async () => {
    const playerId = testPlayerId();
    await upsertPlayerMain(playerId, VIDEOGAME_ID, 1338, 3, 5);
    const second = await upsertPlayerMain(playerId, VIDEOGAME_ID, 1326, 8, 10);

    expect(second.characterId).toBe(1326);

    const { rows } = await pool.query('SELECT count(*) FROM player_mains WHERE player_id = $1 AND videogame_id = $2', [
      playerId,
      VIDEOGAME_ID,
    ]);
    expect(Number(rows[0].count)).toBe(1);

    const mains = await getPlayerMains([playerId], VIDEOGAME_ID);
    expect(mains.get(playerId)?.characterId).toBe(1326);
  });

  it('stores and reads back a tombstone row (character_id: null) — the row shape the no-retry-storm design leans on', async () => {
    const playerId = testPlayerId();
    await upsertPlayerMain(playerId, VIDEOGAME_ID, null, 0, 2);

    const mains = await getPlayerMains([playerId], VIDEOGAME_ID);
    const main = mains.get(playerId);
    expect(main).toBeDefined(); // a real cached row, not "not looked up yet"
    expect(main?.characterId).toBeNull();
  });

  it('getPlayerMains batches a lookup across multiple player ids in one call', async () => {
    const playerA = testPlayerId();
    const playerB = testPlayerId();
    const uncached = testPlayerId();
    await upsertPlayerMain(playerA, VIDEOGAME_ID, 1338, 5, 10);
    await upsertPlayerMain(playerB, VIDEOGAME_ID, 1316, 6, 10);

    const mains = await getPlayerMains([playerA, playerB, uncached], VIDEOGAME_ID);

    expect(mains.size).toBe(2);
    expect(mains.get(playerA)?.characterId).toBe(1338);
    expect(mains.get(playerB)?.characterId).toBe(1316);
    expect(mains.has(uncached)).toBe(false);
  });

  it('getPlayerMains returns an empty Map for an empty input without querying', async () => {
    expect(await getPlayerMains([], VIDEOGAME_ID)).toEqual(new Map());
  });

  it('scopes lookups by videogame_id — a main in one game does not leak into another', async () => {
    const playerId = testPlayerId();
    const otherVideogameId = 1;
    await upsertPlayerMain(playerId, VIDEOGAME_ID, 1338, 5, 10);

    const mains = await getPlayerMains([playerId], otherVideogameId);
    expect(mains.has(playerId)).toBe(false);
  });
});
