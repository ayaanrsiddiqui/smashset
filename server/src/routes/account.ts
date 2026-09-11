import { Router } from 'express';
import { getUserById, updateUserTopXBo5 } from '../db/users.js';

export const accountRouter = Router();

accountRouter.get('/', async (req, res) => {
  const user = await getUserById(req.user!.id);
  if (!user) {
    res.status(404).json({ error: 'Account not found' });
    return;
  }
  res.json({
    displayName: user.displayName,
    startggSlug: user.startggSlug,
    topXBo5: user.topXBo5,
  });
});

accountRouter.post('/preferences', async (req, res) => {
  const { topXBo5 } = req.body;
  if (topXBo5 !== null && (typeof topXBo5 !== 'number' || !Number.isInteger(topXBo5) || topXBo5 < 1)) {
    res.status(400).json({ error: 'topXBo5 must be a positive integer or null' });
    return;
  }
  const updated = await updateUserTopXBo5(req.user!.id, topXBo5);
  res.json({ topXBo5: updated?.topXBo5 ?? null });
});
