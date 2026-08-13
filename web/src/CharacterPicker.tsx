import { useMemo, useRef, useState } from 'react';
import type { Character } from './types';
import { fuzzyMatchSets } from './fuzzy';

interface Props {
  label: string;
  characters: Character[];
  value: Character | null;
  onChange: (c: Character | null) => void;
}

export function CharacterPicker({ label, characters, value, onChange }: Props) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const matches = useMemo(
    () => fuzzyMatchSets(query, characters, (c) => [c.name]).slice(0, 8),
    [query, characters]
  );

  function pick(c: Character) {
    onChange(c);
    setQuery('');
    setOpen(false);
  }

  return (
    <div className="char-picker">
      <label>{label}</label>
      <div className="char-picker-box">
        {value && !open && (
          <span className="char-chip">
            {value.name}
            <button
              type="button"
              className="char-chip-clear"
              onClick={() => {
                onChange(null);
                setOpen(true);
                inputRef.current?.focus();
              }}
              aria-label={`Clear ${label}`}
            >
              ×
            </button>
          </span>
        )}
        {(!value || open) && (
          <input
            ref={inputRef}
            value={query}
            placeholder={`Type ${label.toLowerCase()}…`}
            onChange={(e) => {
              setQuery(e.target.value);
              setHighlight(0);
              setOpen(true);
            }}
            onFocus={() => setOpen(true)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setHighlight((h) => Math.min(h + 1, matches.length - 1));
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setHighlight((h) => Math.max(h - 1, 0));
              } else if (e.key === 'Enter') {
                e.preventDefault();
                if (matches[highlight]) pick(matches[highlight]);
              } else if (e.key === 'Escape') {
                setOpen(false);
                setQuery('');
              }
            }}
          />
        )}
      </div>
      {open && matches.length > 0 && (
        <ul className="char-dropdown">
          {matches.map((c, i) => (
            <li
              key={c.id}
              className={i === highlight ? 'active' : ''}
              onMouseDown={() => pick(c)}
              onMouseEnter={() => setHighlight(i)}
            >
              {c.name}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
