import { useEffect, useRef, useState } from 'react';
import { Settings } from './Settings';
import { SignIn } from './SignIn';
import { ReportPanel } from './ReportPanel';
import { startSet, fetchCharacters, fetchOpenSets, fetchStages, fetchMe, logout } from './api';
import { fuzzyMatchSets } from './fuzzy';
import type { Character, CurrentUser, EventInfo, OpenSet, Stage } from './types';
import './App.css';

const STORAGE_KEY = 'quickset.event';
const POLL_MS = 4000;

export default function App() {
  // undefined = still checking; null = checked, not signed in.
  const [user, setUser] = useState<CurrentUser | null | undefined>(undefined);
  const [event, setEvent] = useState<EventInfo | null>(() => {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as EventInfo) : null;
  });
  const [sets, setSets] = useState<OpenSet[]>([]);
  const [characters, setCharacters] = useState<Character[]>([]);
  const [stages, setStages] = useState<Stage[]>([]);
  const [query, setQuery] = useState('');
  const [highlight, setHighlight] = useState(0);
  // Whether the highlighted row should actually show as highlighted. Stays
  // false while typing with multiple results — so Enter isn't a trap that
  // reports whatever's on top — until an arrow key or a first Enter reveals
  // it (see the keydown handler below), at which point Enter starts
  // selecting instead of just revealing.
  const [revealed, setRevealed] = useState(false);
  const [selectedSet, setSelectedSet] = useState<OpenSet | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [topX, setTopXState] = useState<number | null>(null);
  const [startingIds, setStartingIds] = useState<Set<number | string>>(new Set());
  // Sets we've successfully started this session, kept separately from `sets`
  // so a poll landing before start.gg's own read catches up to the mutation
  // can't flip a just-started set back to not-started and bring the button back.
  const [startedIds, setStartedIds] = useState<Set<number | string>>(new Set());
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    fetchMe()
      .then(({ user }) => setUser(user))
      .catch(() => setUser(null));
  }, []);

  function handleResolved(e: EventInfo) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(e));
    setEvent(e);
  }

  function setTopX(value: number | null) {
    setTopXState(value);
    if (!event) return;
    const key = `${STORAGE_KEY}.topX.${event.id}`;
    if (value == null) localStorage.removeItem(key);
    else localStorage.setItem(key, String(value));
  }

  useEffect(() => {
    if (!event) return;
    const raw = localStorage.getItem(`${STORAGE_KEY}.topX.${event.id}`);
    setTopXState(raw ? Number(raw) : null);
  }, [event?.id]);

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
      // window-level listener and its own escape/confirm flow.
      if (selectedSet) return;

      const active = document.activeElement;
      const inField = active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement;

      if (e.key === '/' && !inField) {
        e.preventDefault();
        searchRef.current?.focus();
        return;
      }
      if (e.key === 'Escape') {
        setQuery('');
        searchRef.current?.blur();
        return;
      }

      // Digit picks only fire with no field focused, so they never fight with
      // typing into the search box or the Top X input.
      if (!inField && /^[1-9]$/.test(e.key)) {
        e.preventDefault();
        const pick = results[Number(e.key) - 1];
        if (pick) selectSet(pick);
        return;
      }

      // Arrow/Enter list navigation applies in the search box or with nothing
      // focused, but not in another field (e.g. Top X), where they should
      // keep their native meaning (number spinner, no-op enter).
      if (inField && active !== searchRef.current) return;

      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setRevealed(true);
        setHighlight((h) => Math.min(h + 1, results.length - 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setRevealed(true);
        setHighlight((h) => Math.max(h - 1, 0));
      } else if (e.key === 'Enter') {
        // With more than one result, a first Enter just reveals the
        // highlight (and blurs, so 1-9 hotkeys stop typing into the box)
        // instead of instantly reporting whatever's on top. Once revealed —
        // by that Enter or by an arrow key — Enter selects like normal.
        if (!revealed && results.length > 1) {
          e.preventDefault();
          setRevealed(true);
          searchRef.current?.blur();
          return;
        }
        const pick = results[highlight];
        if (pick) selectSet(pick);
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  });

  if (user === undefined) return <div className="settings-screen"><h1>quickset</h1></div>;
  if (user === null) return <SignIn />;
  if (!event) return <Settings onResolved={handleResolved} />;

  const results = fuzzyMatchSets(query, sets, (s) => s.entrants.map((e) => e.name))
    .map((s) => (!s.isStarted && startedIds.has(s.id) ? { ...s, isStarted: true } : s))
    .sort((a, b) => Number(b.isStarted) - Number(a.isStarted));

  // A single match is unambiguous, so it stays highlighted the same way it
  // always has — only an actual choice among several needs `revealed` first.
  const showHighlight = results.length <= 1 || revealed;

  function selectSet(s: OpenSet) {
    setSelectedSet(s);
  }

  async function handleStart(s: OpenSet) {
    setStartingIds((prev) => new Set(prev).add(s.id));
    try {
      await startSet(s.id);
      setStartedIds((prev) => new Set(prev).add(s.id));
    } catch (err) {
      setToast(err instanceof Error ? err.message : 'Failed to start set');
      setTimeout(() => setToast(null), 3000);
    } finally {
      setStartingIds((prev) => {
        const next = new Set(prev);
        next.delete(s.id);
        return next;
      });
    }
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
          topXBo5={topX}
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
        <div className="header-controls">
          <label className="top-x-control" title="Sets at or above this placement auto-select Bo5">
            Top
            <input
              type="number"
              min={1}
              step={1}
              value={topX ?? ''}
              placeholder="—"
              onChange={(e) => setTopX(e.target.value ? Number(e.target.value) : null)}
            />
            = Bo5
          </label>
          <button
            className="settings-link"
            onClick={() => {
              localStorage.removeItem(STORAGE_KEY);
              setEvent(null);
            }}
          >
            switch event
          </button>
          <button
            className="settings-link"
            onClick={() => {
              logout().finally(() => setUser(null));
            }}
          >
            sign out
          </button>
        </div>
      </header>

      <input
        ref={searchRef}
        className="search-box"
        autoFocus
        value={query}
        placeholder="Winner's name… (press / to focus, 1-9 to pick)"
        onChange={(e) => {
          setQuery(e.target.value);
          setHighlight(0);
          setRevealed(false);
        }}
      />

      {loadError && <p className="error">{loadError}</p>}

      <ul className="results-list">
        {results.map((s, i) => (
          <li
            key={s.id}
            className={`${showHighlight && i === highlight ? 'active' : ''} ${s.isStarted ? 'started' : ''}`}
            onMouseEnter={() => {
              setRevealed(true);
              setHighlight(i);
            }}
            onClick={() => selectSet(s)}
          >
            {i < 9 && <span className="result-num">{i + 1}</span>}
            <span className="entrant-names">{s.entrants.map((e) => e.name).join(' vs ')}</span>
            <span className="round-text">
              {s.fullRoundText}
              {s.isPreview && ' · bracket not started'}
              {s.isStarted && ' · started'}
            </span>
            {!s.isPreview && !s.isStarted && (
              <button
                className="start-btn"
                disabled={startingIds.has(s.id)}
                onClick={(e) => {
                  e.stopPropagation();
                  handleStart(s);
                }}
              >
                {startingIds.has(s.id) ? '…' : 'start'}
              </button>
            )}
          </li>
        ))}
        {results.length === 0 && <li className="empty">No open sets match "{query}"</li>}
      </ul>

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
