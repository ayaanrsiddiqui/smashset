import { Router } from 'express';
import { getPlayerMains, upsertPlayerMain } from '../db/mains.js';

export const mainsRouter = Router();

// A manual TO correction reuses the exact same upsert the background
// auto-lookup writes through (server/src/mainLookup.ts) — same table, same
// shape, and characterId: null is a legitimate value here too (clearing a
// wrong guess rather than replacing it with a different one). gamesTallied
// and setsConsidered are recorded as 0 since no real set history backs a
// manual entry, which doubles as a free, honest "this was set by hand" signal
// if that's ever surfaced in the UI.
mainsRouter.post('/', async (req, res) => {
  const { playerId, videogameId, characterId } = req.body;
  if (!Number.isInteger(playerId) || !Number.isInteger(videogameId)) {
    res.status(400).json({ error: 'playerId and videogameId are required' });
    return;
  }
  if (characterId !== null && !Number.isInteger(characterId)) {
    res.status(400).json({ error: 'characterId must be a number or null' });
    return;
  }
  const main = await upsertPlayerMain(playerId, videogameId, characterId, 0, 0);
  res.json({ characterId: main.characterId });
});

/**
 * What each of these players has actually been playing, for ordering the
 * character dropdowns.
 *
 * Asked for per set rather than carried on open-sets, which is polled every
 * four seconds and would otherwise grow by a whole tally for every entrant in
 * the pool — a payload multiplied several times over, on venue wifi, for
 * something only the two players in the set being reported ever need. The
 * report panel asks once when it opens, while the TO is still typing a score.
 *
 * A missing player in the answer means no tally on file yet, which the client
 * shows as the plain character list rather than as an error: an ordering it
 * does not have is a dropdown that reads exactly as it did before.
 */
mainsRouter.get('/tallies', async (req, res) => {
  const videogameId = Number(req.query.videogameId);
  const playerIds = String(req.query.playerIds ?? '')
    .split(',')
    .map(Number)
    .filter((id) => Number.isInteger(id));

  if (!Number.isInteger(videogameId)) {
    res.status(400).json({ error: 'videogameId is required' });
    return;
  }
  if (playerIds.length === 0) {
    res.json({ tallies: {} });
    return;
  }

  const mains = await getPlayerMains(playerIds, videogameId);
  const tallies: Record<number, Record<number, number>> = {};
  for (const [playerId, main] of mains) {
    if (main.characterCounts) tallies[playerId] = main.characterCounts;
  }
  res.json({ tallies });
});
