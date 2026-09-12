import { installEventSourceStub } from './test-eventsource';
import '@testing-library/jest-dom/vitest';

// jsdom doesn't implement IntersectionObserver — a no-op stub is enough for
// components (e.g. HelpExample) that just need it to exist and not throw;
// none of the current tests depend on intersection callbacks actually firing.
if (typeof globalThis.IntersectionObserver === 'undefined') {
  class IntersectionObserverStub implements IntersectionObserver {
    readonly root: Element | Document | null = null;
    readonly rootMargin: string = '';
    readonly scrollMargin: string = '';
    readonly thresholds: ReadonlyArray<number> = [];
    observe() {}
    unobserve() {}
    disconnect() {}
    takeRecords(): IntersectionObserverEntry[] {
      return [];
    }
  }
  globalThis.IntersectionObserver = IntersectionObserverStub as unknown as typeof IntersectionObserver;
}

// jsdom doesn't implement matchMedia either. Defaults every query to
// "doesn't match" (e.g. prefers-reduced-motion: reduce is off), which is
// the right default for tests that aren't specifically exercising it.
if (typeof window !== 'undefined' && typeof window.matchMedia === 'undefined') {
  window.matchMedia = (query: string): MediaQueryList =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }) as MediaQueryList;
}

// jsdom has no scrolling at all, so Element.scrollBy is missing. The bracket
// centres the highlighted set with it; a no-op keeps that path runnable in
// tests, which still assert the resulting highlight.
if (typeof Element !== 'undefined' && typeof Element.prototype.scrollBy !== 'function') {
  Element.prototype.scrollBy = function scrollBy() {};
}

// jsdom has no EventSource, which the pool change stream needs. Installed as a
// controllable stub so tests can open, deliver on, and drop the stream rather
// than merely avoid the ReferenceError; see test-eventsource.ts.
installEventSourceStub();
