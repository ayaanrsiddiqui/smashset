import { useEffect, useMemo, useRef, useState } from 'react';
import { fuzzyMatchSets } from './fuzzy';

interface Item {
  id: number;
  name: string;
  imageUrl?: string;
}

interface Props {
  items: Item[];
  value: Item | null;
  active: boolean;
  placeholder?: string;
  emptyLabel?: string;
  onCommit: (item: Item) => void;
  onCancel: () => void;
  onFocusRequest?: () => void;
  /** Overrides the default name-only fuzzy match — e.g. alias-aware matching for characters. */
  matchItems?: (query: string, items: Item[]) => Item[];
  /**
   * What clicking the cell outside the icon does.
   *
   * Given one, the cell splits: a small box around the icon opens the picker,
   * and everything else — most of the cell — does this instead. In a game row
   * that is "this player won this game", which is the thing a TO is actually
   * doing, while changing a character is the rare case that no longer needs
   * the whole target.
   *
   * Without one the cell stays a single button that opens the picker, which is
   * all a stage or an all-games cell has to offer.
   */
  onBodyClick?: () => void;
  /** Screen-reader name for the icon box; only read when onBodyClick splits the cell. */
  pickLabel?: string;
  /** Screen-reader name for the body button, e.g. "Game 2: Ada won". */
  bodyLabel?: string;
  /**
   * Whether the top of the list means something before anything is typed, and
   * so is worth committing on Enter.
   *
   * True for characters, which are ordered by what the player actually plays —
   * open the cell, press Enter, their main goes in. False for stages, whose
   * order carries no such claim, where committing the first one would just be
   * picking a stage at random on the TO's behalf.
   */
  commitTopWhenEmpty?: boolean;
  /** Mirrors icon/name so the icon sits on the inner edge (near the opposing column) instead of the outer edge. */
  reverse?: boolean;
  /** Part of a multi-game selection (whether or not this is the one currently showing the input) — dashed outline; the active one also gets a lighter background. */
  multiSelect?: boolean;
  /**
   * Lets a bare 1-9 keystroke reach ReportPanel's game-target picker even
   * while this cell has real DOM focus (the window-level keydown handler
   * skips everything while an <input> is focused, so without this a digit
   * would just get typed into the search query instead). Digits only —
   * letters still type normally, since character names use plenty of those.
   */
  onGameDigit?: (n: number) => void;
}

/**
 * One cell in the characters/stages grid: a resolved chip when inactive, or
 * a live fuzzy-matched text box when `active` (driven by ReportPanel's
 * keyboard mode, not native DOM focus tracking).
 */
export function FuzzyCell({
  items,
  value,
  active,
  placeholder,
  emptyLabel,
  onCommit,
  onCancel,
  onFocusRequest,
  matchItems,
  commitTopWhenEmpty = false,
  onBodyClick,
  pickLabel,
  bodyLabel,
  reverse,
  multiSelect,
  onGameDigit,
}: Props) {
  const [query, setQuery] = useState('');
  const [highlight, setHighlight] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const matches = useMemo(() => {
    const ranked = matchItems ? matchItems(query, items) : fuzzyMatchSets(query, items, (i) => [i.name]);
    return ranked.slice(0, 8);
  }, [query, items, matchItems]);

  useEffect(() => {
    if (active) {
      setQuery('');
      setHighlight(0);
      inputRef.current?.focus();
    }
  }, [active]);

  if (!active) {
    const classes = `fuzzy-cell ${value ? 'filled' : 'empty'} ${reverse && (value?.imageUrl || onBodyClick) ? 'reverse' : ''} ${multiSelect ? 'queued' : ''}`;
    const label = <span className="fuzzy-cell-label">{value ? value.name : (emptyLabel ?? '—')}</span>;

    if (!onBodyClick) {
      return (
        <button
          type="button"
          className={classes}
          onClick={(e) => {
            e.stopPropagation();
            onFocusRequest?.();
          }}
        >
          {value?.imageUrl && <img className="char-icon" src={value.imageUrl} alt="" />}
          {label}
        </button>
      );
    }

    // A div, not a button, because it now holds two of them. It keeps the
    // fuzzy-cell class so every existing rule — the won/queued tints, the
    // row height, reverse — still applies to exactly the same box.
    return (
      <div className={classes}>
        {/* Always rendered, with or without a character. An icon box that
            appeared only once a character was set would leave the empty
            cell — the one that most needs picking — with no way in. */}
        <button
          type="button"
          className="fuzzy-cell-pick"
          aria-label={pickLabel}
          onClick={(e) => {
            e.stopPropagation();
            onFocusRequest?.();
          }}
        >
          {value?.imageUrl ? <img className="char-icon" src={value.imageUrl} alt="" /> : <span className="fuzzy-cell-pick-empty">▾</span>}
        </button>
        {/* Deliberately out of the tab order: it does exactly what the arrow
            beside it does, and a keyboard already has that. This is a touch
            target, so doubling every game row in the tab order would buy a
            keyboard user nothing but more tabbing. */}
        <button
          type="button"
          className="fuzzy-cell-body"
          tabIndex={-1}
          aria-label={bodyLabel}
          onClick={(e) => {
            e.stopPropagation();
            onBodyClick();
          }}
        >
          {label}
        </button>
      </div>
    );
  }

  return (
    <div className={`fuzzy-cell-active ${multiSelect ? 'multi-active' : ''}`} onClick={(e) => e.stopPropagation()}>
      <input
        ref={inputRef}
        value={query}
        placeholder={placeholder}
        onChange={(e) => {
          setQuery(e.target.value);
          setHighlight(0);
        }}
        onKeyDown={(e) => {
          if (onGameDigit && /^[1-9]$/.test(e.key)) {
            e.preventDefault();
            e.stopPropagation();
            onGameDigit(Number(e.key));
            return;
          }
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            e.stopPropagation();
            setHighlight((h) => Math.min(h + 1, matches.length - 1));
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            e.stopPropagation();
            setHighlight((h) => Math.max(h - 1, 0));
          } else if (e.key === 'Enter') {
            e.preventDefault();
            e.stopPropagation();
            const pick = query.trim() || commitTopWhenEmpty ? matches[highlight] : undefined;
            if (pick) onCommit(pick);
            else onCancel();
          } else if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            onCancel();
          }
        }}
      />
      {matches.length > 0 && (
        <ul className="fuzzy-dropdown">
          {matches.map((m, i) => (
            <li
              key={m.id}
              className={i === highlight ? 'active' : ''}
              onMouseDown={() => onCommit(m)}
              onMouseEnter={() => setHighlight(i)}
            >
              {m.imageUrl && <img className="char-icon" src={m.imageUrl} alt="" />}
              {m.name}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
