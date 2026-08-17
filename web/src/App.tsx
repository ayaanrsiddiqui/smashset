import { useEffect, useRef, useState } from 'react';
import { Settings } from './Settings';
import { ReportPanel } from './ReportPanel';
import { fetchCharacters, fetchOpenSets, fetchStages } from './api';
import { fuzzyMatchSets } from './fuzzy';
import type { Character, EventInfo, OpenSet, Stage } from './types';
import './App.css';

const STORAGE_KEY = 'quickset.event';
const POLL_MS = 4000;

export default function App() {
  const [event, setEvent] = useState<EventInfo | null>(() => {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as EventInfo) : null;
  });
  const [sets, setSets] = useState<OpenSet[]>([]);
  const [characters, setCharacters] = useState<Character[]>([]);
  const [stages, setStages] = useState<Stage[]>([]);
  const [query, setQuery] = useState('');
  const [highlight, setHighlight] = useState(0);
  const [numberPickArmed, setNumberPickArmed] = useState(false);
  const [selectedSet, setSelectedSet] = useState<OpenSet | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  function handleResolved(e: EventInfo) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(e));
    setEvent(e);
  }

  async function refreshSets(eventId: number) {
    try {
      const { sets } = await fetchOpenSets(eventId);
      setSets(sets);
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Failed to load sets');
    }
  }

  useEffect(() => {
    if (!event) return;
    fetchCharacters(event.videogame.id)
      .then(({ characters }) => setCharacters(characters))
      .catch(() => setCharacters([]));
    fetchStages(event.videogame.id)
      .then(({ stages }) => setStages(stages))
      .catch(() => setStages([]));
  }, [event]);

  useEffect(() => {
    if (!event || selectedSet) return;
    refreshSets(event.id);
    const interval = setInterval(() => refreshSets(event.id), POLL_MS);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [event, selectedSet]);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      // ReportPanel owns every keypress while a set is open — it has its own
      // window-level listener and its own escape/confirm flow. Before an event
      // is resolved, `results` below doesn't exist yet, so bail out too.
      if (!event || selectedSet) return;

      const active = document.activeElement;
      const inField = active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement;

      if (e.key === '/' && !inField) {
        e.preventDefault();
        searchRef.current?.focus();
        return;
      }
      if (e.key === 'Escape') {
        setQuery('');
        setNumberPickArmed(false);
        searchRef.current?.blur();
        return;
      }
      if (!inField) return;

      if (e.key === 'Tab') {
        e.preventDefault();
        setNumberPickArmed(true);
        return;
      }
      if (numberPickArmed) {
        setNumberPickArmed(false);
        if (/^[1-9]$/.test(e.key)) {
          e.preventDefault();
          const pick = results[Number(e.key) - 1];
          if (pick) selectSet(pick);
          return;
        }
      }

      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setHighlight((h) => Math.min(h + 1, results.length - 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setHighlight((h) => Math.max(h - 1, 0));
      } else if (e.key === 'Enter') {
        const pick = results[highlight];
        if (pick) selectSet(pick);
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  });

  if (!event) return <Settings onResolved={handleResolved} />;

  const results = fuzzyMatchSets(query, sets, (s) => s.entrants.map((e) => e.name));

  function selectSet(s: OpenSet) {
    setSelectedSet(s);
  }

  function matchedEntrantId(s: OpenSet): number | null {
    if (!query.trim()) return null;
    const q = query.trim().toLowerCase();
    const match = s.entrants.find((e) => e.name.toLowerCase().includes(q));
    return match?.id ?? null;
  }

  if (selectedSet) {
    return (
      <div className="app-shell">
        <ReportPanel
          set={selectedSet}
          presumedWinnerId={matchedEntrantId(selectedSet)}
          characters={characters}
          stages={stages}
          onDone={() => {
            setToast(`Reported ${selectedSet.entrants.map((e) => e.name).join(' vs ')}`);
            setSelectedSet(null);
            setQuery('');
            refreshSets(event.id);
            setTimeout(() => setToast(null), 3000);
          }}
          onCancel={() => {
            setSelectedSet(null);
          }}
        />
      </div>
    );
  }

  return (
    <div className="app-shell">
      <header className="app-header">
        <span className="event-name">{event.name}</span>
        <button
          className="settings-link"
          onClick={() => {
            localStorage.removeItem(STORAGE_KEY);
            setEvent(null);
          }}
        >
          switch event
        </button>
      </header>

      <input
        ref={searchRef}
        className="search-box"
        autoFocus
        value={query}
        placeholder="Winner's name… (press / to focus, tab + 1-9 to pick)"
        onChange={(e) => {
          setQuery(e.target.value);
          setHighlight(0);
          setNumberPickArmed(false);
        }}
      />

      {loadError && <p className="error">{loadError}</p>}

      <ul className={`results-list ${numberPickArmed ? 'number-pick-armed' : ''}`}>
        {results.map((s, i) => (
          <li
            key={s.id}
            className={i === highlight ? 'active' : ''}
            onMouseEnter={() => setHighlight(i)}
            onClick={() => selectSet(s)}
          >
            {i < 9 && <span className="result-num">{i + 1}</span>}
            <span className="entrant-names">{s.entrants.map((e) => e.name).join(' vs ')}</span>
            <span className="round-text">
              {s.fullRoundText}
              {s.isPreview && ' · bracket not started'}
            </span>
          </li>
        ))}
        {results.length === 0 && <li className="empty">No open sets match "{query}"</li>}
      </ul>

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
