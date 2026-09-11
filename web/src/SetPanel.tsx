import { useRef } from 'react';
import type { ReactNode, RefObject, TouchEvent } from 'react';

/**
 * Below this, a drag is a tap or a vertical scroll that wandered sideways,
 * not a deliberate swipe.
 */
const SWIPE_MIN_PX = 50;

interface Props {
  /** Which pile the search is over — toggled with Tab, or swiped on a phone. */
  mode: 'open' | 'completed';
  /**
   * Expanded shows the full search results; collapsed shows only what a TO
   * needs at a glance between matches. Driven by search focus rather than a
   * button, so the panel gets out of the way without anyone asking it to.
   */
  expanded: boolean;
  query: string;
  searchRef: RefObject<HTMLInputElement | null>;
  onQueryChange: (value: string) => void;
  onSearchFocus: () => void;
  onSearchBlur: () => void;
  onModeChange: (next: 'open' | 'completed') => void;
  /** Shown under the search box — a failed poll shouldn't hide the bracket. */
  error?: string | null;
  /** Describes what the collapsed list is showing, e.g. "3 ready to start". */
  collapsedLabel: string;
  children: ReactNode;
}

/**
 * The set list, floating over the bracket rather than replacing it.
 *
 * Docks to the right edge on a wide screen and to the bottom edge on a narrow
 * one (see App.css) — the same component either way, because a 22% side panel
 * is about 95px on a phone, which is narrower than most entrant names.
 */
export function SetPanel({
  mode,
  expanded,
  query,
  searchRef,
  onQueryChange,
  onSearchFocus,
  onSearchBlur,
  onModeChange,
  error,
  collapsedLabel,
  children,
}: Props) {
  const swipeStart = useRef<{ x: number; y: number } | null>(null);

  function handleTouchStart(e: TouchEvent) {
    // A drag inside the search box is the TO moving the text cursor; stealing
    // it would make the field unusable. More than one finger is a pinch.
    const eligible = e.touches.length === 1 && !(e.target instanceof HTMLInputElement);
    swipeStart.current = eligible ? { x: e.touches[0].clientX, y: e.touches[0].clientY } : null;
  }

  function handleTouchEnd(e: TouchEvent) {
    const start = swipeStart.current;
    swipeStart.current = null;
    if (!start) return;
    // The finger that lifted is in changedTouches; touches is empty by now.
    const end = e.changedTouches[0];
    if (!end) return;
    const dx = end.clientX - start.x;
    const dy = end.clientY - start.y;
    // Horizontal dominance is what separates this from a flick down the
    // results list, which the panel scrolls and must keep scrolling.
    if (Math.abs(dx) < SWIPE_MIN_PX || Math.abs(dx) <= Math.abs(dy)) return;
    // Otherwise the browser synthesises a click on whichever row the finger
    // happened to lift over, opening a set the TO never picked.
    e.preventDefault();
    // Rightward goes back in time to sets already played, leftward returns to
    // what's waiting. Directional rather than a toggle, so swiping the same
    // way twice doesn't bounce the TO back out of the pile they just opened.
    onModeChange(dx > 0 ? 'completed' : 'open');
  }

  return (
    <aside
      className={`set-panel ${expanded ? 'expanded' : 'collapsed'} mode-${mode}`}
      onTouchStart={handleTouchStart}
      onTouchEnd={handleTouchEnd}
      onTouchCancel={() => {
        swipeStart.current = null;
      }}
    >
      <div className="set-panel-header">
        {/* The swipe on its own is invisible, and a phone has no Tab — so the
            two piles are also plain buttons. That doubles as the single-tap
            alternative a path-based gesture owes anyone who can't swipe. */}
        <div className="pile-toggle" role="group" aria-label="Which sets to search">
          {(['open', 'completed'] as const).map((pile) => (
            <button
              key={pile}
              type="button"
              className={mode === pile ? 'selected' : ''}
              aria-pressed={mode === pile}
              // Keeps focus (and the soft keyboard) in the search box, so
              // switching pile mid-query doesn't collapse the panel underneath
              // the TO — same reason the rows do this; see App's list.
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => onModeChange(pile)}
            >
              {pile === 'open' ? 'to report' : 'completed'}
            </button>
          ))}
        </div>
        <input
          ref={searchRef}
          className="search-box"
          value={query}
          placeholder={mode === 'completed' ? 'Player to correct…' : "Winner's name…"}
          onFocus={onSearchFocus}
          // A click on a result blurs the input first, so collapsing here
          // would unmount the row mid-click. The row's own mousedown handler
          // keeps focus instead; see App's onMouseDown on the list.
          onBlur={onSearchBlur}
          onChange={(e) => onQueryChange(e.target.value)}
        />
        {mode === 'completed' ? (
          <span className="set-panel-summary">Completed sets, newest first</span>
        ) : (
          !expanded && <span className="set-panel-summary">{collapsedLabel}</span>
        )}
      </div>

      {error && <p className="error set-panel-error">{error}</p>}

      <ul className="results-list set-panel-list">{children}</ul>
    </aside>
  );
}
