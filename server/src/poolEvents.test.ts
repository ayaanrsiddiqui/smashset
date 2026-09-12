import { afterEach, describe, expect, it } from 'vitest';
import {
  hasSeenPool,
  publishPoolChanged,
  recordPoolAccess,
  resetPoolEvents,
  subscribe,
  subscriberCount,
} from './poolEvents.js';

afterEach(() => {
  resetPoolEvents();
});

/** A subscriber that records what it was sent, and can play dead. */
function fake(userId = 1, alive = { value: true }) {
  const received: string[] = [];
  return {
    received,
    alive,
    sub: {
      userId,
      send: (event: string) => {
        if (!alive.value) return false;
        received.push(event);
        return true;
      },
    },
  };
}

describe('pool change channels', () => {
  it('tells everyone watching a pool that it moved', () => {
    const a = fake(1);
    const b = fake(2);
    subscribe('7', a.sub);
    subscribe('7', b.sub);

    publishPoolChanged('7');

    expect(a.received).toEqual(['changed']);
    expect(b.received).toEqual(['changed']);
  });

  it('tells nobody watching a different pool', () => {
    const other = fake();
    subscribe('8', other.sub);

    publishPoolChanged('7');

    expect(other.received).toEqual([]);
  });

  it('stops sending once a subscriber leaves, and forgets the pool', () => {
    const a = fake();
    const unsubscribe = subscribe('7', a.sub);

    unsubscribe();
    publishPoolChanged('7');

    expect(a.received).toEqual([]);
    // An idle server should hold nothing for a pool that finished hours ago.
    expect(subscriberCount('7')).toBe(0);
  });

  it('drops a connection that died without saying so', () => {
    // The close handler does not always fire — a laptop lid closing, a proxy
    // timing out — so a failed write is the other way a subscriber leaves.
    const alive = { value: true };
    const gone = fake(1, alive);
    subscribe('7', gone.sub);
    alive.value = false;

    publishPoolChanged('7');

    expect(subscriberCount('7')).toBe(0);
  });

  it('treats a numeric and a string pool id as the same channel', () => {
    // Set ids and phase group ids round-trip from start.gg as both.
    const a = fake();
    subscribe('7', a.sub);

    publishPoolChanged(7 as unknown as string);

    expect(a.received).toEqual(['changed']);
  });

  it('publishing to a pool nobody watches is harmless', () => {
    expect(() => publishPoolChanged('nobody-here')).not.toThrow();
  });
});

describe('who may be told about a pool', () => {
  it('admits only a user who has already read that pool', () => {
    recordPoolAccess(1, '7');

    // start.gg served pool 7 to user 1's token, so telling them it changed
    // reveals nothing they could not already fetch.
    expect(hasSeenPool(1, '7')).toBe(true);
    // Never fetched — and "pool 9 just changed" is itself something to know
    // about a tournament start.gg might not have shown them.
    expect(hasSeenPool(1, '9')).toBe(false);
    expect(hasSeenPool(2, '7')).toBe(false);
  });

  it('matches a pool id whichever type it arrives as', () => {
    recordPoolAccess(1, 7 as unknown as string);
    expect(hasSeenPool(1, '7')).toBe(true);
  });
});
