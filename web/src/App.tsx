import { useEffect, useRef, useState } from 'react';
import { Settings } from './Settings';
import { SignIn } from './SignIn';
import { PoolPicker } from './PoolPicker';
import { ReportPanel } from './ReportPanel';
import { HelpModal } from './HelpModal';
import { AccountModal } from './AccountModal';
import { Bracket } from './Bracket';
import {
  startSet,
  fetchBracket,
  fetchCharacters,
  fetchOpenSets,
  fetchPhaseGroups,
  fetchSetDetail,
  fetchStages,
  fetchMe,
  fetchAccount,
  updateTopXBo5,
  logout,
  ApiError,
} from './api';
import { fuzzyMatchSets } from './fuzzy';
import { bracketSetById, isNotReady, priorResultFor, slotLabel } from './bracketDisplay';
import { compareIdentifiers } from './identifierOrder';
import type {
  AccountDetails,
  BracketGroup,
  BracketSet,
  Character,
  CurrentUser,
  EventInfo,
  OpenSet,
  PhaseGroupSummary,
  SetDetail,
  Stage,
  ToastKind,
} from './types';
import './App.css';

const STORAGE_KEY = 'smashset.event';
// Keyed by which event it was chosen for (below), so switching events never
// silently carries over a pool id that doesn't belong to the new one.
const POOL_STORAGE_KEY = 'smashset.phaseGroup';
const POLL_MS = 4000;

export default function App() {
  // undefined = still checking; null = checked, not signed in.
  const [user, setUser] = useState<CurrentUser | null | undefined>(undefined);
  const [event, setEvent] = useState<EventInfo | null>(() => {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as EventInfo) : null;
  });
  // null = not fetched yet for the current event. A TO is normally only
  // ever looking at one pool/bracket at a time (matching how start.gg's own
  // bracket pages work), so everything below is scoped to whichever one
  // this is — nothing is fetched for any other pool unless the TO switches.
  const [phaseGroups, setPhaseGroups] = useState<PhaseGroupSummary[] | null>(null);
  const [phaseGroupId, setPhaseGroupIdState] = useState<number | null>(null);
  // True while actively re-choosing a pool via "switch pool" — distinct from
  // "phaseGroupId is null", which also means "no pool chosen yet" but should
  // fall back to event selection on Back rather than cancel back to a
  // current pool that doesn't exist yet.
  const [pickingPool, setPickingPool] = useState(false);
  const [sets, setSets] = useState<OpenSet[]>([]);
  const [bracketGroup, setBracketGroup] = useState<BracketGroup | null>(null);
  const [view, setView] = useState<'list' | 'bracket'>('list');
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
  // Set only when selectedSet was opened for correction (via
  // selectFromBracket) and start.gg actually had per-game records for it —
  // reset to null on every close, from whichever path (see the ReportPanel
  // render below), so a later plain open-set click never inherits a stale
  // value from a previous correction.
  const [priorDetail, setPriorDetail] = useState<SetDetail | null>(null);
  const [toast, setToast] = useState<{ message: string; kind: ToastKind } | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [bracketLoadError, setBracketLoadError] = useState<string | null>(null);
  const [account, setAccount] = useState<AccountDetails | null>(null);
  const [accountError, setAccountError] = useState(false);
  const [startingIds, setStartingIds] = useState<Set<number | string>>(new Set());
  // Sets we've successfully started this session, kept separately from `sets`
  // so a poll landing before start.gg's own read catches up to the mutation
  // can't flip a just-started set back to not-started and bring the button back.
  const [startedIds, setStartedIds] = useState<Set<number | string>>(new Set());
  const [showHelp, setShowHelp] = useState(false);
  const [showAccount, setShowAccount] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  // Mirrors phaseGroupId for async continuations that need to know whether the
  // TO switched pool while they were awaiting — a ref because a closure
  // captured at click time would still see the old value.
  const poolRef = useRef<number | null>(null);

  useEffect(() => {
    poolRef.current = phaseGroupId;
  }, [phaseGroupId]);

  useEffect(() => {
    fetchMe()
      .then(({ user }) => setUser(user))
      .catch(() => setUser(null));
  }, []);

  useEffect(() => {
    if (!user) return;
    fetchAccount()
      .then(setAccount)
      .catch((err) => {
        if (handledAuthError(err)) return;
        setAccountError(true);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

  function handleResolved(e: EventInfo) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(e));
    setEvent(e);
  }

  function pickPool(id: number) {
    if (event) localStorage.setItem(POOL_STORAGE_KEY, JSON.stringify({ eventId: event.id, phaseGroupId: id }));
    setPhaseGroupIdState(id);
    setPickingPool(false);
    // Drop the pool being switched away from, so its sets aren't briefly
    // listed — and reportable — under the newly chosen one.
    setSets([]);
    setBracketGroup(null);
  }

  // The event picker (Settings) already resolves an event; this resolves
  // which of its pools/brackets to actually work with — skipped entirely
  // (auto-picked) when there's only one, which is the common case.
  useEffect(() => {
    if (!user || !event) return;
    setPhaseGroups(null);
    setPhaseGroupIdState(null);
    fetchPhaseGroups(event.id)
      .then(({ phaseGroups }) => {
        setPhaseGroups(phaseGroups);
        setLoadError(null);
        if (phaseGroups.length === 1) {
          pickPool(phaseGroups[0].id);
          return;
        }
        const raw = localStorage.getItem(POOL_STORAGE_KEY);
        if (!raw) return;
        try {
          const saved = JSON.parse(raw) as { eventId: number; phaseGroupId: number };
          if (saved.eventId === event.id && phaseGroups.some((pg) => pg.id === saved.phaseGroupId)) {
            setPhaseGroupIdState(saved.phaseGroupId);
          }
        } catch {
          // Malformed storage — just leaves phaseGroupId unset, same as if
          // nothing had been saved, so PoolPicker shows as usual.
        }
      })
      .catch((err) => {
        if (handledAuthError(err)) return;
        // An empty list is the one pre-list state that renders something the
        // TO can act on (the message below, plus a way back). Leaving
        // phaseGroups null would strand them on a blank splash screen with
        // the error set but nothing rendering it.
        setLoadError(err instanceof Error ? err.message : 'Failed to load phase groups');
        setPhaseGroups([]);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, event]);

  // The one place a toast gets shown and cleared — every call site below
  // (and ReportPanel, via the onNotify prop) goes through this instead of
  // duplicating its own setTimeout.
  function notify(message: string, kind: ToastKind = 'info') {
    setToast({ message, kind });
    setTimeout(() => setToast(null), 3000);
  }

  // Optimistic: the input reflects the new value immediately, and rolls back
  // with a toast on the rare failure rather than waiting a round trip to
  // update — the same pattern handleStart already uses below.
  async function handleTopXChange(value: number | null) {
    const previous = account?.topXBo5 ?? null;
    setAccount((prev) => (prev ? { ...prev, topXBo5: value } : prev));
    try {
      await updateTopXBo5(value);
    } catch (err) {
      setAccount((prev) => (prev ? { ...prev, topXBo5: previous } : prev));
      if (handledAuthError(err)) return;
      notify(err instanceof Error ? err.message : 'Failed to save preference', 'error');
    }
  }

  // Everything scoped to a signed-in session, cleared together. Leaving the
  // event and pool behind would drop the next person to sign in on this
  // device straight into the previous TO's tournament, and leaving
  // phaseGroupId set would keep both polls running against it.
  // Deliberately does NOT touch localStorage. A session can end without the TO
  // choosing it — an expired cookie mid-tournament — and making them re-find
  // their event after signing back in would be its own small disaster.
  // Forgetting the event is specific to signing out; see handleSignOut.
  function endSession() {
    setUser(null);
    setEvent(null);
    setPhaseGroups(null);
    setPhaseGroupIdState(null);
    setSets([]);
    setBracketGroup(null);
    setSelectedSet(null);
    setAccount(null);
  }

  function handleSignOut() {
    setShowAccount(false);
    // Signing out is a choice, so the remembered event and pool go too —
    // otherwise the next person to sign in on a shared venue device lands
    // straight in the previous TO's tournament.
    localStorage.removeItem(STORAGE_KEY);
    localStorage.removeItem(POOL_STORAGE_KEY);
    // Local state flips first so the UI can't sit on a live-looking session
    // while a slow logout round trip is still in the air.
    endSession();
    logout().catch(() => {});
  }

  // A 401 means the session is gone server-side — expired, revoked, or signed
  // out on another device. Returning to sign-in is the only thing a TO can
  // act on, and it stops the polls that would otherwise retry the same 401
  // every few seconds for as long as the tab stays open.
  function handledAuthError(err: unknown): boolean {
    if (err instanceof ApiError && err.status === 401) {
      endSession();
      return true;
    }
    return false;
  }

  useEffect(() => {
    if (!event) return;
    // On failure these deliberately keep whatever they already hold. Emptying
    // the roster would silently disable character and stage entry for the rest
    // of the event over one blip, with nothing on screen to explain it.
    fetchCharacters(event.videogame.id)
      .then(({ characters }) => setCharacters(characters))
      .catch((err) => {
        if (handledAuthError(err)) return;
        notify('Could not load the character list — character picks may be unavailable.', 'error');
      });
    fetchStages(event.videogame.id)
      .then(({ stages }) => setStages(stages))
      .catch((err) => {
        if (handledAuthError(err)) return;
        notify('Could not load the stage list — stage picks may be unavailable.', 'error');
      });
  }, [event]);

  // `cancelled` covers both halves of the same problem: the interval stops
  // when the effect tears down, and a response already in flight at that
  // moment is dropped instead of writing the old pool's sets over the new
  // pool's — or writing anything at all once the session has ended.
  useEffect(() => {
    if (!user || phaseGroupId === null || selectedSet || pickingPool) return;
    const id = phaseGroupId;
    let cancelled = false;
    // setInterval doesn't wait for the previous tick, so a slow response can
    // land after a faster later one. Only the newest response may write state.
    let seq = 0;
    const run = async () => {
      const mine = ++seq;
      try {
        const { sets } = await fetchOpenSets(id);
        if (cancelled || mine !== seq) return;
        setSets(sets);
        setLoadError(null);
      } catch (err) {
        if (cancelled || mine !== seq || handledAuthError(err)) return;
        setLoadError(err instanceof Error ? err.message : 'Failed to load sets');
      }
    };
    run();
    const interval = setInterval(run, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, phaseGroupId, selectedSet, pickingPool]);

  // Polled separately from the open-sets list (different endpoint, different
  // shape) but on the same cadence — powers the read-only Completed/Not ready
  // sections below, which the fast-path list can't (it excludes both).
  useEffect(() => {
    if (!user || phaseGroupId === null || selectedSet || pickingPool) return;
    const id = phaseGroupId;
    let cancelled = false;
    let seq = 0;
    const run = async () => {
      const mine = ++seq;
      try {
        const group = await fetchBracket(id);
        if (cancelled || mine !== seq) return;
        setBracketGroup(group);
        setBracketLoadError(null);
      } catch (err) {
        if (cancelled || mine !== seq || handledAuthError(err)) return;
        setBracketLoadError(err instanceof Error ? err.message : 'Failed to load completed/not-ready sets');
      }
    };
    run();
    const interval = setInterval(run, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, phaseGroupId, selectedSet, pickingPool]);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      // ReportPanel owns every keypress while a set is open — it has its own
      // window-level listener and its own escape/confirm flow. The help and
      // account modals own their own Escape-to-close and have no other
      // bindings, but still need every OTHER key suppressed here, or e.g. a
      // digit typed while one is open would select a result on the hidden
      // search screen underneath it. The bracket view has no search box or
      // numbered results to target, so these shortcuts are meaningless (and
      // would silently steal focus/keys) while it's showing.
      if (selectedSet || showHelp || showAccount || view === 'bracket') return;

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

  // Declared above the early returns below, because the keydown effect closes
  // over it: on any screen that returned early, `results` was still in the
  // temporal dead zone and an arrow key or digit threw a ReferenceError.
  const results = fuzzyMatchSets(query, sets, (s) => s.entrants.map((e) => e.name))
    .map((s) => (!s.isStarted && startedIds.has(s.id) ? { ...s, isStarted: true } : s))
    .sort((a, b) => Number(b.isStarted) - Number(a.isStarted));

  // A single match is unambiguous, so it stays highlighted the same way it
  // always has — only an actual choice among several needs `revealed` first.
  const showHighlight = results.length <= 1 || revealed;

  if (user === undefined) return <div className="settings-screen"><h1>SmashSet</h1></div>;
  if (user === null) return <SignIn />;
  if (!event) return <Settings onResolved={handleResolved} />;

  function backToEventPicker() {
    localStorage.removeItem(STORAGE_KEY);
    localStorage.removeItem(POOL_STORAGE_KEY);
    setEvent(null);
    // The pool belongs to the event being abandoned. Without clearing it both
    // polls keep running against it from the event picker, and its sets stay
    // rendered — and reportable — under whatever event is chosen next.
    setPhaseGroups(null);
    setPhaseGroupIdState(null);
    setSets([]);
    setBracketGroup(null);
  }

  if (phaseGroups === null) return <div className="settings-screen"><h1>SmashSet</h1></div>;

  if (phaseGroups.length === 0) {
    return (
      <div className="settings-screen">
        <h1>SmashSet</h1>
        <p className="error">{loadError ?? 'This event has no brackets yet.'}</p>
        <button onClick={backToEventPicker}>back</button>
      </div>
    );
  }

  if (pickingPool || (phaseGroups.length > 1 && phaseGroupId === null)) {
    return (
      <PoolPicker
        eventName={event.name}
        phaseGroups={phaseGroups}
        onPicked={pickPool}
        onBack={phaseGroupId !== null ? () => setPickingPool(false) : backToEventPicker}
      />
    );
  }

  if (phaseGroupId === null) return <div className="settings-screen"><h1>SmashSet</h1></div>;

  const allBracketSets = bracketGroup?.sets ?? [];
  const bracketById = bracketSetById(allBracketSets);
  const completedSets = allBracketSets.filter((s) => s.state === 3).sort((a, b) => compareIdentifiers(a.identifier, b.identifier));
  const notReadySets = allBracketSets.filter(isNotReady).sort((a, b) => compareIdentifiers(a.identifier, b.identifier));

  function selectSet(s: OpenSet) {
    setSelectedSet(s);
  }

  // Shared by the bracket tree and the Completed-section rows — both a
  // still-open set and an already-completed one (being reopened for
  // correction) funnel through here. For a completed one, this also fetches
  // its full per-game detail so ReportPanel can open pre-filled with what
  // was actually played; that fetch happens *before* selectSet so it's
  // already in state by the time ReportPanel's useState initializers read
  // it on mount (they only ever consult their initial value once).
  async function selectFromBracket(bs: BracketSet) {
    // The detail fetch below is a round trip during which the TO can switch
    // pool or event. Without this, a slow response would open the report
    // screen for a set belonging to a bracket they already left.
    const openedFor = phaseGroupId;

    if (bs.state === 3) {
      try {
        const detail = await fetchSetDetail(bs.id);
        if (poolRef.current !== openedFor) return;
        setPriorDetail(detail);
      } catch (err) {
        if (poolRef.current !== openedFor || handledAuthError(err)) return;
        // Still opens — just without the pre-fill, same as if start.gg had
        // no game records for this set at all (e.g. a quick-reported one).
        setPriorDetail(null);
      }
    } else {
      setPriorDetail(null);
    }

    // The richer, mains-enriched version of this same set already sitting
    // in `sets` (polled continuously regardless of which view is showing)
    // — completed sets are never in it (fetchOpenSets excludes them), so
    // this only ever actually matches for a still-open set.
    const openSet = sets.find((s) => s.id === bs.id);
    if (openSet) {
      selectSet(openSet);
      return;
    }
    const [a, b] = bs.slots;
    if (!a.entrant || !b.entrant) return;
    selectSet({
      id: bs.id,
      isPreview: false,
      isStarted: bs.state === 2,
      fullRoundText: bs.fullRoundText,
      identifier: bs.identifier,
      lPlacement: bs.lPlacement,
      entrants: [
        { id: a.entrant.id, name: a.entrant.name },
        { id: b.entrant.id, name: b.entrant.name },
      ],
    });
  }

  async function handleStart(s: OpenSet) {
    setStartingIds((prev) => new Set(prev).add(s.id));
    try {
      await startSet(s.id);
      setStartedIds((prev) => new Set(prev).add(s.id));
    } catch (err) {
      if (handledAuthError(err)) return;
      notify(err instanceof Error ? err.message : 'Failed to start set', 'error');
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

  const topX = account?.topXBo5 ?? null;

  if (selectedSet) {
    // The richer bracket-shaped view of whatever's currently selected, if
    // any — present for anything the bracket poll has seen (which includes
    // completed sets; the open-sets poll never does). Powers the
    // already-reported banner and, below, a sensible default winner when
    // there's no search match to go on.
    const selectedBracketSet = bracketById.get(String(selectedSet.id));
    const priorResult = selectedBracketSet ? priorResultFor(selectedBracketSet) : null;

    return (
      <div className="app-shell">
        <ReportPanel
          // Remounts when the set changes so the score/character initializers
          // re-read priorDetail. Without it, clicking a second completed set
          // while the first one's detail fetch is still in flight leaves the
          // panel showing the new set's players pre-filled with the old set's
          // games — one confirm away from reporting the wrong result.
          key={selectedSet.id}
          set={selectedSet}
          // Search-query match wins when there is one (the usual reporting
          // flow); otherwise, correcting an already-decided set should
          // start on the winner it actually has, not an arbitrary side.
          presumedWinnerId={matchedEntrantId(selectedSet) ?? selectedBracketSet?.winnerId ?? null}
          priorResult={priorResult}
          priorDetail={priorDetail}
          characters={characters}
          stages={stages}
          topXBo5={topX}
          videogameId={event.videogame.id}
          onNotify={notify}
          onAuthError={handledAuthError}
          onDone={() => {
            notify(`Reported ${selectedSet.entrants.map((e) => e.name).join(' vs ')}`, 'success');
            // Clearing selectedSet re-arms both poll effects, which refresh
            // immediately — calling them here too just doubled every report's
            // start.gg traffic.
            setSelectedSet(null);
            setPriorDetail(null);
            setQuery('');
          }}
          onCancel={() => {
            setSelectedSet(null);
            setPriorDetail(null);
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
          <button
            type="button"
            className="help-trigger"
            onClick={() => setShowHelp(true)}
            title="Notation guide"
            aria-label="Notation guide"
          >
            ?
          </button>
          <button
            type="button"
            className="help-trigger"
            onClick={() => setShowAccount(true)}
            title="Account"
            aria-label="Account"
          >
            ⚙
          </button>
          {phaseGroups.length > 1 && (
            <button className="settings-link" onClick={() => setPickingPool(true)}>
              switch pool
            </button>
          )}
          <button className="settings-link" onClick={backToEventPicker}>
            switch event
          </button>
        </div>
      </header>

      <div className="segmented-toggle">
        <button type="button" className={view === 'list' ? 'selected' : ''} onClick={() => setView('list')}>
          List
        </button>
        <button type="button" className={view === 'bracket' ? 'selected' : ''} onClick={() => setView('bracket')}>
          Bracket
        </button>
      </div>

      {view === 'list' ? (
        <>
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

          {bracketLoadError && <p className="error">{bracketLoadError}</p>}

          {completedSets.length > 0 && (
            <details className="set-section">
              <summary>Completed ({completedSets.length})</summary>
              <ul className="results-list">
                {completedSets.map((s) => {
                  const [a, b] = s.slots;
                  const winner = a.entrant?.id === s.winnerId ? a : b;
                  const loser = winner === a ? b : a;
                  return (
                    <li key={s.id} onClick={() => selectFromBracket(s)}>
                      <span className="entrant-names">
                        <strong>{winner.entrant?.name}</strong> def. {loser.entrant?.name}
                        {winner.score !== null && loser.score !== null ? ` ${winner.score}–${loser.score}` : ''}
                      </span>
                      <span className="round-text">{s.fullRoundText} · tap to correct</span>
                    </li>
                  );
                })}
              </ul>
            </details>
          )}

          {notReadySets.length > 0 && (
            <details className="set-section">
              <summary>Not ready ({notReadySets.length})</summary>
              <ul className="results-list">
                {notReadySets.map((s) => (
                  <li key={s.id} className="readonly">
                    <span className="entrant-names">
                      {slotLabel(s.slots[0], bracketById)} vs {slotLabel(s.slots[1], bracketById)}
                    </span>
                    <span className="round-text">{s.fullRoundText}</span>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </>
      ) : (
        <>
          {bracketLoadError && <p className="error">{bracketLoadError}</p>}
          <Bracket group={bracketGroup} onSelectSet={selectFromBracket} />
        </>
      )}

      {toast && <div className={`toast toast-${toast.kind}`}>{toast.message}</div>}
      {showHelp && <HelpModal onClose={() => setShowHelp(false)} />}
      {showAccount && (
        <AccountModal
          account={account}
          accountError={accountError}
          onClose={() => setShowAccount(false)}
          onTopXChange={handleTopXChange}
          onSignOut={handleSignOut}
        />
      )}
    </div>
  );
}
