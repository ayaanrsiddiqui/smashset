/**
 * Best-effort telemetry from the TO's browser.
 *
 * Built for one question: what actually happened to a report at a venue, on
 * venue wifi, with nobody standing there to watch. Everything the outbox knows
 * about a failed delivery currently lives in one phone's localStorage, so a
 * field test that goes wrong is indistinguishable from one that went fine.
 *
 * This is not the outbox and must never behave like one. A dropped event costs
 * nothing, while a beacon that queued and retried would compete with the
 * reports it exists to observe for the bandwidth that was already the problem.
 * So: batched, capped, fire-and-forget, and silent on its own failures.
 */

const ENDPOINT = '/api/client-events';
/** Long enough that a burst of failures leaves as one request, not five. */
const FLUSH_DELAY_MS = 2_000;
const MAX_EVENTS_PER_REQUEST = 20;
/**
 * One page load's whole budget. Without it, a render loop that throws every
 * frame would spend a TO's connection on telemetry about itself.
 */
const MAX_EVENTS_PER_PAGE_LOAD = 200;

export type ClientEventFields = Record<string, string | number | boolean | null | undefined>;

/**
 * Groups one page load's events in the log. Not an identity and not stored —
 * it dies with the tab, which is all the correlation a field test needs.
 */
const sessionId = Math.random().toString(36).slice(2, 10);

let pending: Record<string, unknown>[] = [];
let recorded = 0;
let timer: ReturnType<typeof setTimeout> | null = null;

/** Records an event for the next flush. Never throws; callers are error paths. */
export function recordClientEvent(kind: string, fields: ClientEventFields = {}): void {
  if (recorded >= MAX_EVENTS_PER_PAGE_LOAD) return;
  recorded += 1;

  const event: Record<string, unknown> = { kind };
  for (const [key, value] of Object.entries(fields)) {
    if (value !== null && value !== undefined) event[key] = value;
  }
  pending.push(event);

  if (pending.length >= MAX_EVENTS_PER_REQUEST) {
    flushClientEvents();
    return;
  }
  if (timer === null) timer = setTimeout(flushClientEvents, FLUSH_DELAY_MS);
}

export function flushClientEvents(): void {
  if (timer !== null) {
    clearTimeout(timer);
    timer = null;
  }
  if (pending.length === 0) return;

  const events = pending;
  pending = [];

  try {
    void fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, events }),
      // Survives the tab going away mid-flush, which is the flush that matters
      // most — it is carrying whatever happened just before the TO left.
      keepalive: true,
    }).catch(() => {
      // Swallowed deliberately, and this is the one place that is right: an
      // unhandled rejection here reaches the global handler below, which would
      // record it as another event, which would fail the same way. Telemetry
      // must not be able to report on itself.
    });
  } catch {
    // Some browsers throw synchronously from fetch when offline. Same reasoning.
  }
}

/**
 * Crashes the app never got to handle.
 *
 * Installed from main.tsx before render, so a throw during the first paint is
 * still reported — that failure renders a blank screen, which is precisely the
 * one a TO cannot describe over text.
 */
export function installCrashReporting(): void {
  window.addEventListener('error', (event) => {
    recordClientEvent('crash', {
      message: event.message,
      source: event.filename,
      line: event.lineno,
    });
  });

  window.addEventListener('unhandledrejection', (event) => {
    const reason: unknown = event.reason;
    recordClientEvent('unhandled-rejection', {
      message: reason instanceof Error ? reason.message : String(reason),
    });
  });

  // A phone going back in a pocket is the normal end of a session at a venue,
  // and nothing buffered survives it. pagehide rather than unload: iOS Safari
  // does not reliably fire unload at all.
  window.addEventListener('pagehide', flushClientEvents);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushClientEvents();
  });
}

/** Tests only; the module-level buffer outlives an individual test otherwise. */
export function resetClientEvents(): void {
  pending = [];
  recorded = 0;
  if (timer !== null) {
    clearTimeout(timer);
    timer = null;
  }
}
