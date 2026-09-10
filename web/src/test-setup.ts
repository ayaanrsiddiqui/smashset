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
