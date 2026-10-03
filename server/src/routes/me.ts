import { Router } from 'express';
import { resolveSessionUser } from '../middleware/auth.js';
import { isAdmin } from '../middleware/admin.js';

export const meRouter = Router();

// Always 200, never 401 — this is how the frontend probes login state on
// load, not a protected resource.
meRouter.get('/', async (req, res) => {
  const user = await resolveSessionUser(req, res);
  // isAdmin only decides whether the client offers a link. It grants nothing:
  // the admin routes check again for themselves on every request.
  res.json({ user: user ? { id: user.id, displayName: user.displayName, isAdmin: isAdmin(user) } : null });
});
