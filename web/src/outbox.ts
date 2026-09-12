import type { ReportPayload } from './api';

/**
 * Reports a TO has submitted but start.gg has not confirmed.
 *
 * A report used to be awaited inline: the panel sat there for up to 25 seconds
 * on venue wifi (measured against a socket that accepts and never answers),
 * and a failure threw the report away behind a toast. Here it is written down
 * first, the TO gets the screen back immediately, and delivery happens behind
 * them with retries.
 *
 * At-least-once, deliberately. The same report can reach start.gg twice — the
 * first attempt landing and its response dying is indistinguishable from it
 * never landing — so every delivery after the first carries `attempt`, and the
 * server holds those to a stricter rule than a TO standing at the set.
 *
 * Explicitly NOT optimistic: nothing here marks a set reported before start.gg
 * says so. A TO who sees a tick and walks away leaves a set unreported, which
 * is worse than one who sees it still sending.
 */
export interface OutboxEntry {
  /** start.gg set id, as a string. Also the dedupe key: one report per set. */
  setId: string;
  payload: ReportPayload;
  /** "Ada vs mudd" — what the TO needs to recognise it by, minutes later. */
  label: string;
  /** Deliveries made, including the one in flight. 0 before the first. */
  attempt: number;
  /** Epoch ms; delivery waits until then. */
  nextAttemptAt: number;
  // 'sending' still has hope — every failure so far was worth waiting out.
  // 'failed' is a dead end start.gg will not change its mind about, and only
  // the TO can resolve.
  state: 'sending' | 'failed';
  /** The most recent failure, shown while sending and after giving up. */
  error: string | null;
  queuedAt: number;
}

const KEY_PREFIX = 'smashset.outbox.';
const BASE_BACKOFF_MS = 1_000;
/**
 * Capped rather than unbounded, and never given up on: at two attempts a
 * minute the cost of waiting out an hour-long outage is nothing, while an
 * outbox that surrenders loses a score the TO cannot get back.
 */
const MAX_BACKOFF_MS = 30_000;

/**
 * Exponential backoff with jitter. The jitter matters more than usual here:
 * every TO at a venue is behind one access point, so a shared outage releases
 * them all at the same instant and they retry in lockstep without it.
 */
export function backoffFor(attempt: number, jitter: number): number {
  const base = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** Math.max(0, attempt - 1));
  return Math.round(base * (0.5 + jitter * 0.5));
}

// In memory is the source of truth; storage is a mirror. A browser that
// refuses localStorage (private mode, blocked site data) then degrades to an
// outbox that works but does not survive a reload, rather than to no outbox.
const entries = new Map<string, OutboxEntry>();
let loaded = false;
// Single-flight. Reports are cheap but start.gg's limit is per token and
// shared with the polls; delivering one at a time also keeps the order a TO
// reported things in, which is the order they expect them to land.
let draining = false;

/**
 * The queue is the single source of truth and it pushes, rather than letting
 * callers sync from whatever a delivery happened to return.
 *
 * That distinction is not academic: React StrictMode mounts every effect,
 * tears it down and mounts it again, so the delivery that actually lands often
 * belongs to an effect that has already been cleaned up. A strip refreshed
 * only from that delivery's return value went on showing a report that had
 * been delivered — this whole feature inverted.
 */
const listeners = new Set<() => void>();
// useSyncExternalStore compares snapshots by identity, so this has to stay the
// same array until something actually changes or it re-renders forever.
let snapshot: OutboxEntry[] = [];
let snapshotStale = true;

function announce(): void {
  snapshotStale = true;
  for (const listener of listeners) listener();
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function storageKey(setId: string): string {
  return `${KEY_PREFIX}${setId}`;
}

/**
 * One storage key per entry, not one blob for the queue.
 *
 * Two tabs writing a shared blob read-modify-write over each other and silently
 * drop a report. Disjoint keys cannot.
 */
function persist(entry: OutboxEntry): void {
  try {
    localStorage.setItem(storageKey(entry.setId), JSON.stringify(entry));
  } catch {
    // Kept in memory regardless; see the note on `entries`.
  }
}

function unpersist(setId: string): void {
  try {
    localStorage.removeItem(storageKey(setId));
  } catch {
    // Nothing to do — the in-memory drop below is what actually matters.
  }
}

function hydrate(): void {
  if (loaded) return;
  loaded = true;
  snapshotStale = true;
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key === null || !key.startsWith(KEY_PREFIX)) continue;
      const raw = localStorage.getItem(key);
      if (raw === null) continue;
      const parsed = JSON.parse(raw) as OutboxEntry;
      // A half-written or hand-edited entry would otherwise be delivered as a
      // report, which is the one thing this must never do on a guess.
      if (typeof parsed?.setId === 'string' && parsed.payload != null) entries.set(parsed.setId, parsed);
    }
  } catch {
    // An unreadable store starts empty rather than throwing on first render.
  }
}

export function allEntries(): OutboxEntry[] {
  hydrate();
  if (snapshotStale) {
    snapshot = [...entries.values()].sort((a, b) => a.queuedAt - b.queuedAt);
    snapshotStale = false;
  }
  return snapshot;
}

/**
 * Queues a report, replacing any earlier one for the same set.
 *
 * Replacing is the point: a TO who re-reports a set has changed their mind,
 * and delivering both would race the old answer against the new one.
 */
export function enqueue(payload: ReportPayload, label: string, now: number): OutboxEntry {
  hydrate();
  const entry: OutboxEntry = {
    setId: String(payload.setId),
    payload,
    label,
    attempt: 0,
    nextAttemptAt: now,
    state: 'sending',
    error: null,
    queuedAt: now,
  };
  entries.set(entry.setId, entry);
  persist(entry);
  announce();
  return entry;
}

export function remove(setId: string): void {
  hydrate();
  entries.delete(setId);
  unpersist(setId);
  announce();
}

export function update(setId: string, patch: Partial<OutboxEntry>): void {
  hydrate();
  const existing = entries.get(setId);
  if (!existing) return;
  const next = { ...existing, ...patch };
  entries.set(setId, next);
  persist(next);
  announce();
}

/** Signing out on a shared venue device must not hand the next TO a report. */
export function clearOutbox(): void {
  hydrate();
  for (const setId of [...entries.keys()]) remove(setId);
}

/**
 * Tests only: the module-level store outlives an individual test otherwise.
 *
 * Clears the in-flight flag too. A test that leaves a delivery unresolved
 * would otherwise hold the single-flight lock for every test after it, which
 * looks like the outbox silently refusing to deliver anything.
 */
export function resetOutbox(): void {
  entries.clear();
  loaded = false;
  draining = false;
  snapshot = [];
  snapshotStale = true;
}

export interface DeliverResult {
  /** Delivered, or found already on file — either way, done with. */
  ok: boolean;
  /** Set when !ok: whether waiting could plausibly help. */
  retryable?: boolean;
  message?: string;
}

export interface DrainDeps {
  now: number;
  random: () => number;
  send: (payload: ReportPayload, attempt: number) => Promise<DeliverResult>;
  /** Confirmed by start.gg, not merely sent — the only honest success signal. */
  onDelivered: (entry: OutboxEntry) => void;
}

/**
 * Delivers the oldest entry that is due, if any. Returns whether anything
 * changed, so a caller can avoid re-rendering on an idle tick.
 */
export async function drainOnce(deps: DrainDeps): Promise<boolean> {
  hydrate();
  if (draining) return false;
  const due = allEntries().find((entry) => entry.state === 'sending' && entry.nextAttemptAt <= deps.now);
  if (!due) return false;

  draining = true;
  const attempt = due.attempt + 1;
  try {
    const result = await deps.send(due.payload, attempt);
    if (result.ok) {
      remove(due.setId);
      deps.onDelivered(due);
      return true;
    }
    if (result.retryable === false) {
      update(due.setId, { attempt, state: 'failed', error: result.message ?? 'start.gg would not accept this report' });
      return true;
    }
    update(due.setId, {
      attempt,
      nextAttemptAt: deps.now + backoffFor(attempt, deps.random()),
      error: result.message ?? null,
    });
    return true;
  } finally {
    draining = false;
  }
}

/** Puts a dead-lettered report back in the queue, at the TO's request. */
export function retryNow(setId: string, now: number): void {
  update(setId, { state: 'sending', nextAttemptAt: now, error: null });
}
