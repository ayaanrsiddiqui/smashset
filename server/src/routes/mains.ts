import { Router } from 'express';
import { upsertPlayerMain } from '../db/mains.js';

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
