import { Router } from 'express';
import { resolveSessionUser } from '../middleware/auth.js';

export const meRouter = Router();

// Always 200, never 401 — this is how the frontend probes login state on
// load, not a protected resource.
meRouter.get('/', async (req, res) => {
  const user = await resolveSessionUser(req, res);
  res.json({ user: user ? { id: user.id, displayName: user.displayName } : null });
});
