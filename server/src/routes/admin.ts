import { Router } from 'express';
import { buildDashboard } from '../adminDashboard.js';
import { readDashboardRows } from '../db/reports.js';

export const adminRouter = Router();

/**
 * Every set smashset has reported, grouped by bracket, with the figures the
 * reporting claims are judged on. See adminDashboard for how each is defined.
 *
 * No try/catch: Express 5 hands a rejected handler to the app's error handler,
 * which answers in JSON — and a database failure on a page only the admin
 * opens is exactly the kind of thing that should surface as an error.
 */
adminRouter.get('/reports', async (_req, res) => {
  const { rows, brackets } = await readDashboardRows();
  res.json(buildDashboard(rows, brackets));
});
