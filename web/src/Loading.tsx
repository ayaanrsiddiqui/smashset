import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';

/**
 * What a screen shows while it is waiting.
 *
 * Every one of these replaced a state that answered the TO's question wrongly
 * instead of admitting it did not know yet. The bracket said "No bracket data
 * yet" for the 2-3 seconds it takes to arrive; the set list said "Nothing left
 * to report"; the splash screens said nothing at all. At a bracket table those
 * read as facts — "nothing left to report" is a reason to walk away from the
 * table — so a placeholder that lies is worse than a blank screen.
 */

/**
 * How long a wait has to last before it is worth mentioning.
 *
 * An indicator that appears and vanishes inside a few frames reads as a glitch
 * rather than as progress, so a fast answer renders its content with nothing in
 * front of it. Long enough to cover a warm cache and a local round trip, short
 * enough that the seconds a bracket really takes get acknowledged almost at
 * once.
 */
export const LOADING_DELAY_MS = 300;

/** Renders its children only once the wait has lasted long enough to admit to. */
export function Delayed({ children }: { children: ReactNode }) {
  const [due, setDue] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setDue(true), LOADING_DELAY_MS);
    return () => clearTimeout(timer);
  }, []);
  return due ? <>{children}</> : null;
}

/**
 * A line of text with a spinner, for a screen or a modal with nothing on it
 * yet. `role="status"` so a screen reader hears the wait instead of silence.
 */
export function LoadingNote({ children }: { children: ReactNode }) {
  return (
    <Delayed>
      <p className="loading-note" role="status">
        <span className="spinner" aria-hidden="true" />
        {children}
      </p>
    </Delayed>
  );
}

/**
 * Placeholder rows for the set list — rows rather than one spinner, because
 * the panel is already row-shaped, and a list that keeps its height does not
 * shove the bracket behind it around when the real rows land.
 *
 * Hidden from assistive tech: the shapes say nothing a screen reader can use,
 * and the list carries `aria-busy` for that instead.
 */
export function SkeletonRows({ count }: { count: number }) {
  return (
    <Delayed>
      {Array.from({ length: count }, (_, i) => (
        <li key={i} className="skeleton-row" aria-hidden="true">
          <span className="skeleton skeleton-name" />
          <span className="skeleton skeleton-round" />
        </li>
      ))}
    </Delayed>
  );
}
