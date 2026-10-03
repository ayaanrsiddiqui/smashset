import type { NextFunction, Request, Response } from 'express';
import type { AuthUser } from './auth.js';

/**
 * Who may see every TO's reporting: start.gg user ids listed, comma-separated,
 * in ADMIN_STARTGG_USER_IDS.
 *
 * Fails closed. Unset, empty, or a typo that matches nobody all mean no admins
 * at all — the page shows which account reported which set at which event, so
 * the wrong default here is the one that exposes it. Read on every call rather
 * than once at boot, so changing the variable cannot leave a stale list behind.
 */
function adminStartggIds(): Set<string> {
  return new Set(
    (process.env.ADMIN_STARTGG_USER_IDS ?? '')
      .split(',')
      .map((id) => id.trim())
      .filter((id) => id.length > 0)
  );
}

export function isAdmin(user: AuthUser): boolean {
  return adminStartggIds().has(user.startggUserId);
}

/** Mounted after requireAuth, which is what puts req.user there. */
export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  if (!req.user || !isAdmin(req.user)) {
    res.status(403).json({ error: 'Not available.' });
    return;
  }
  next();
}
