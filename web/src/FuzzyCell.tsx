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
    return (
      <button
        type="button"
        className={`fuzzy-cell ${value ? 'filled' : 'empty'} ${reverse && value?.imageUrl ? 'reverse' : ''} ${multiSelect ? 'queued' : ''}`}
        onClick={(e) => {
          e.stopPropagation();
          onFocusRequest?.();
        }}
      >
        {value?.imageUrl && <img className="char-icon" src={value.imageUrl} alt="" />}
        <span className="fuzzy-cell-label">{value ? value.name : (emptyLabel ?? '—')}</span>
      </button>
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
