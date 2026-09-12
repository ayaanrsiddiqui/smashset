/**
 * Server-sent notifications that a pool changed.
 *
 * A change made through smashset is already known here the instant it happens,
 * so telling every TO watching that pool costs nothing against start.gg's rate
 * limit — where noticing the same change by polling costs one request per TO
 * per cycle. That is the whole point: the app's own writes should not be
 * rediscovered by asking start.gg about them.
 *
 * Events deliberately carry no set data, only the pool that moved. Each client
 * refetches with its own token, so start.gg keeps deciding what that TO is
 * allowed to see — a payload here would make this cache one TO's view of a
 * tournament and hand it to another, which is the leak cacheKey() in
 * routes/sets.ts already exists to prevent.
 */

export interface PoolSubscriber {
  userId: number;
  /** Writes one SSE frame. Returns false once the connection is gone. */
  send: (event: string) => boolean;
}

const channels = new Map<string, Set<PoolSubscriber>>();

/**
 * Pools a user has successfully fetched, which is what admits them to a
 * channel. Even a data-free ping says "this pool just changed", and that is
 * something to know about a tournament start.gg would not have shown them —
 * so subscribing requires having already read the pool with their own token.
 */
const poolsSeenByUser = new Map<number, Set<string>>();

export function recordPoolAccess(userId: number, phaseGroupId: string): void {
  const seen = poolsSeenByUser.get(userId) ?? new Set<string>();
  seen.add(String(phaseGroupId));
  poolsSeenByUser.set(userId, seen);
}

export function hasSeenPool(userId: number, phaseGroupId: string): boolean {
  return poolsSeenByUser.get(userId)?.has(String(phaseGroupId)) ?? false;
}

export function subscribe(phaseGroupId: string, subscriber: PoolSubscriber): () => void {
  const key = String(phaseGroupId);
  const subscribers = channels.get(key) ?? new Set<PoolSubscriber>();
  subscribers.add(subscriber);
  channels.set(key, subscribers);

  return () => {
    subscribers.delete(subscriber);
    // Drop the channel entirely once nobody is listening, so an idle server
    // holds no state for pools that finished hours ago.
    if (subscribers.size === 0) channels.delete(key);
  };
}

/**
 * Tells everyone watching a pool that it moved. Called after a write this
 * server performed, never on a timer — a timer would just be polling again.
 */
export function publishPoolChanged(phaseGroupId: string): void {
  const subscribers = channels.get(String(phaseGroupId));
  if (!subscribers) return;

  for (const subscriber of [...subscribers]) {
    // A write failing means the client went away without the close handler
    // firing; drop it rather than accumulating dead connections.
    if (!subscriber.send('changed')) subscribers.delete(subscriber);
  }
  if (subscribers.size === 0) channels.delete(String(phaseGroupId));
}

/** For tests and for deciding whether a pool is worth polling at all. */
export function subscriberCount(phaseGroupId: string): number {
  return channels.get(String(phaseGroupId))?.size ?? 0;
}

/**
 * Who is currently watching, deduplicated — one TO with two tabs open is one
 * person, and should not take two turns in the detector's token rotation.
 */
export function subscriberUserIds(phaseGroupId: string): number[] {
  const subscribers = channels.get(String(phaseGroupId));
  return subscribers ? [...new Set([...subscribers].map((s) => s.userId))] : [];
}

/** Test-only: channels and access records outlive individual requests. */
export function resetPoolEvents(): void {
  channels.clear();
  poolsSeenByUser.clear();
}
