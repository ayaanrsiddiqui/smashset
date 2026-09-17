import { Router, type Request } from 'express';

/**
 * The browser's own account of what went wrong, for a TO testing at a venue.
 *
 * Deliberately unauthenticated. This is the only channel that can report a
 * session going bad, and behind requireAuth it would fall silent exactly when a
 * TO is signed out mid-tournament — the failure it most needs to catch.
 * Telemetry that depends on the subsystem it observes reports nothing at the
 * only moment it matters.
 *
 * Nothing here is trusted or stored. It is shaped, capped, and written to the
 * log, which on Railway is the whole retrieval mechanism.
 */
export const clientEventsRouter = Router();

/** The client batches, so one request carries a burst rather than one event. */
const MAX_EVENTS_PER_REQUEST = 20;
const MAX_FIELDS_PER_EVENT = 12;
const MAX_FIELD_CHARS = 300;
const MAX_SESSION_ID_CHARS = 40;

/**
 * A public endpoint that writes to the log is a way to fill the log. With one
 * tester this is never reached; it exists so that a runaway client loop costs a
 * dropped batch instead of a Railway bill. Per-process and in memory, which is
 * all a single-instance deploy can use anyway.
 */
const MAX_EVENTS_PER_IP_PER_MINUTE = 120;
const WINDOW_MS = 60_000;

const budgets = new Map<string, { count: number; windowStart: number }>();

function withinBudget(ip: string, count: number, now: number): boolean {
  // Pruned on the way past rather than on a timer: the map only grows while
  // requests are arriving, so that is also the only time it needs clearing.
  for (const [key, budget] of budgets) {
    if (now - budget.windowStart >= WINDOW_MS) budgets.delete(key);
  }

  const budget = budgets.get(ip);
  if (!budget) {
    budgets.set(ip, { count, windowStart: now });
    return count <= MAX_EVENTS_PER_IP_PER_MINUTE;
  }
  budget.count += count;
  return budget.count <= MAX_EVENTS_PER_IP_PER_MINUTE;
}

/** Tests only; the budget map outlives an individual test otherwise. */
export function resetClientEventBudgets(): void {
  budgets.clear();
}

/**
 * Untrusted text on its way into a log line.
 *
 * Collapsing whitespace is the point, not tidiness: a log reader splits on
 * newlines, so without this a client could write a line of its own that reads
 * as the server's output. Anything that isn't a finite scalar is dropped rather
 * than stringified — "[object Object]" in a log is noise that looks like data.
 */
function scalar(value: unknown): string | null {
  if (typeof value === 'string') {
    const cleaned = value.replace(/\s+/g, ' ').trim();
    return cleaned.length > 0 ? cleaned.slice(0, MAX_FIELD_CHARS) : null;
  }
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'boolean') return String(value);
  return null;
}

function logEvent(sessionId: string, event: unknown): void {
  if (typeof event !== 'object' || event === null) return;
  const record = event as Record<string, unknown>;

  const kind = scalar(record.kind);
  if (kind === null) return;

  const fields: string[] = [];
  for (const [key, value] of Object.entries(record)) {
    if (key === 'kind') continue;
    if (fields.length >= MAX_FIELDS_PER_EVENT) break;
    const name = scalar(key);
    const text = scalar(value);
    if (name === null || text === null) continue;
    // Quoted so a value with spaces stays one field when read back.
    fields.push(`${name}=${JSON.stringify(text)}`);
  }

  console.log(`[client] ${sessionId} ${kind}${fields.length > 0 ? ` ${fields.join(' ')}` : ''}`);
}

function clientIp(req: Request): string {
  return req.ip ?? 'unknown';
}

clientEventsRouter.post('/', (req, res) => {
  const body = req.body as { sessionId?: unknown; events?: unknown } | undefined;

  const sessionId = scalar(body?.sessionId)?.slice(0, MAX_SESSION_ID_CHARS) ?? 'anon';
  const events = Array.isArray(body?.events) ? body.events.slice(0, MAX_EVENTS_PER_REQUEST) : [];

  if (events.length > 0 && withinBudget(clientIp(req), events.length, Date.now())) {
    for (const event of events) logEvent(sessionId, event);
  }

  // Always 204, including over budget and on a body that made no sense. An
  // error here would be handled by a client that is already failing, or worse
  // retried — and a beacon that retries competes with the reports it exists to
  // observe for the bandwidth that was the problem in the first place.
  res.status(204).end();
});
