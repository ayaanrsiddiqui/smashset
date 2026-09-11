import type { ReactNode, RefObject } from 'react';

interface Props {
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
  expanded,
  query,
  searchRef,
  onQueryChange,
  onSearchFocus,
  onSearchBlur,
  error,
  collapsedLabel,
  children,
}: Props) {
  return (
    <aside className={`set-panel ${expanded ? 'expanded' : 'collapsed'}`}>
      <div className="set-panel-header">
        <input
          ref={searchRef}
          className="search-box"
          value={query}
          placeholder="Winner's name…"
          onFocus={onSearchFocus}
          // A click on a result blurs the input first, so collapsing here
          // would unmount the row mid-click. The row's own mousedown handler
          // keeps focus instead; see App's onMouseDown on the list.
          onBlur={onSearchBlur}
          onChange={(e) => onQueryChange(e.target.value)}
        />
        {!expanded && <span className="set-panel-summary">{collapsedLabel}</span>}
      </div>

      {error && <p className="error set-panel-error">{error}</p>}

      <ul className="results-list set-panel-list">{children}</ul>
    </aside>
  );
}
