/**
 * jsdom has no EventSource, so the pool change stream would throw on sight.
 *
 * A controllable stub rather than a no-op: the interesting behaviour is what
 * happens when the stream opens, delivers, or drops, and a stub that only
 * avoided the ReferenceError would leave all of that untested.
 */
export class EventSourceStub {
  static instances: EventSourceStub[] = [];

  readonly url: string;
  readyState = 0;
  closed = false;
  onopen: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  private readonly listeners = new Map<string, Set<(event: Event) => void>>();

  constructor(url: string) {
    this.url = url;
    EventSourceStub.instances.push(this);
  }

  addEventListener(type: string, handler: (event: Event) => void): void {
    const forType = this.listeners.get(type) ?? new Set();
    forType.add(handler);
    this.listeners.set(type, forType);
  }

  removeEventListener(type: string, handler: (event: Event) => void): void {
    this.listeners.get(type)?.delete(handler);
  }

  close(): void {
    this.closed = true;
    this.readyState = 2;
  }

  /** The server's first frame; until this, polling stays on its fast fallback. */
  emitOpen(): void {
    this.readyState = 1;
    this.onopen?.(new Event('open'));
  }

  /** A pool changed — what the server sends after a report lands. */
  emitChanged(): void {
    for (const handler of this.listeners.get('changed') ?? []) handler(new Event('changed'));
  }

  /** A dropped connection. The real EventSource retries on its own. */
  emitError(): void {
    this.onerror?.(new Event('error'));
  }
}

export function installEventSourceStub(): void {
  (globalThis as { EventSource?: unknown }).EventSource = EventSourceStub;
}

/** Call between tests: instances accumulate across renders otherwise. */
export function resetEventSources(): void {
  EventSourceStub.instances = [];
}

/** The stream currently open, or undefined when nothing subscribed. */
export function openedEventSource(): EventSourceStub | undefined {
  return EventSourceStub.instances.filter((source) => !source.closed).at(-1);
}
