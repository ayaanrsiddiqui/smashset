import { useEffect, useMemo, useRef, useState } from 'react';
import { fuzzyMatchSets } from './fuzzy';

interface Item {
  id: number;
  name: string;
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
}

/**
 * One cell in the characters/stages grid: a resolved chip when inactive, or
 * a live fuzzy-matched text box when `active` (driven by ReportPanel's
 * keyboard mode, not native DOM focus tracking).
 */
export function FuzzyCell({ items, value, active, placeholder, emptyLabel, onCommit, onCancel, onFocusRequest }: Props) {
  const [query, setQuery] = useState('');
  const [highlight, setHighlight] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const matches = useMemo(() => fuzzyMatchSets(query, items, (i) => [i.name]).slice(0, 8), [query, items]);

  useEffect(() => {
    if (active) {
      setQuery('');
      setHighlight(0);
      inputRef.current?.focus();
    }
  }, [active]);

  if (!active) {
    return (
      <button type="button" className={`fuzzy-cell ${value ? 'filled' : 'empty'}`} onClick={onFocusRequest}>
        {value ? value.name : (emptyLabel ?? '—')}
      </button>
    );
  }

  return (
    <div className="fuzzy-cell-active">
      <input
        ref={inputRef}
        value={query}
        placeholder={placeholder}
        onChange={(e) => {
          setQuery(e.target.value);
          setHighlight(0);
        }}
        onKeyDown={(e) => {
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
            const pick = query.trim() ? matches[highlight] : undefined;
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
              {m.name}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
