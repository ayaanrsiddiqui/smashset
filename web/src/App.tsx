import { useEffect, useRef, useState } from 'react';
import type React from 'react';
import { Settings } from './Settings';
import { SignIn } from './SignIn';
import { PoolPicker } from './PoolPicker';
import { ReportPanel } from './ReportPanel';
import { HelpModal } from './HelpModal';
import { AccountModal } from './AccountModal';
import { Bracket } from './Bracket';
import { SetPanel } from './SetPanel';
import { MainsPanel } from './MainsPanel';
import {
  startSet,
  poolEventsUrl,
  updatePlayerMain,
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
import { bracketSetById, priorResultFor } from './bracketDisplay';
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
/**
 * Used instead while the pool's change stream is connected, where polling is
 * only a safety net. Reports made through smashset arrive on the stream
 * immediately, and edits made on start.gg directly are caught by the server's
 * one detector per pool — so a client asking for itself is just insurance
 * against a change neither of those noticed. Drops back to POLL_MS the moment
 * the stream goes down, which degrades to exactly today's behaviour.
 */
const POLL_MS_LIVE = 60000;

/**
 * A row in the set panel. The two piles a TO searches — sets waiting to be
 * reported and sets already finished — are different shapes, but normalising
 * them here keeps one highlight index, one keyboard path, and one notion of
 * which set the bracket should centre on.
 */
type PanelRow = { kind: 'open'; set: OpenSet } | { kind: 'completed'; set: BracketSet };

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
  // Whether the pool's change stream is up, and a counter the stream bumps.
  // The counter is a polling dependency, so an event refetches immediately and
  // restarts the clock instead of landing mid-interval.
  const [liveConnected, setLiveConnected] = useState(false);
  const [changeSignal, setChangeSignal] = useState(0);
  // Drives whether the floating set panel is expanded; see SetPanel.
  const [searchFocused, setSearchFocused] = useState(false);
  // Which pile the search is over: sets waiting to be reported, or sets already
  // finished — the "someone says I got their last result wrong" flow. Tab
  // flips it on a keyboard, a horizontal swipe on the panel does on a phone.
  const [mode, setMode] = useState<'open' | 'completed'>('open');
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
  const [showMains, setShowMains] = useState(false);
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

  /**
   * Switching pile invalidates the highlight — index 0 of the new list is a
   * different set, and a highlight carried over would point at a set the TO
   * never looked at.
   */
  function showMode(next: 'open' | 'completed') {
    setMode(next);
    setHighlight(0);
    setRevealed(false);
  }

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
    const interval = setInterval(run, liveConnected ? POLL_MS_LIVE : POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, phaseGroupId, selectedSet, pickingPool, liveConnected, changeSignal]);

  // Subscribed only once the bracket has actually loaded, which is also the
  // server's admission rule: it refuses a pool this TO has not read, and a
  // refusal is not an event stream, so EventSource would fail permanently
  // instead of retrying.
  const poolLoaded = phaseGroupId !== null && bracketGroup?.phaseGroupId === phaseGroupId;
  useEffect(() => {
    if (!user || phaseGroupId === null || !poolLoaded) return;
    const source = new EventSource(poolEventsUrl(phaseGroupId));
    source.onopen = () => setLiveConnected(true);
    source.addEventListener('changed', () => setChangeSignal((n) => n + 1));
    // EventSource reconnects on its own; this only drops polling back to the
    // faster fallback while the stream is down.
    source.onerror = () => setLiveConnected(false);
    return () => {
      source.close();
      setLiveConnected(false);
    };
  }, [user, phaseGroupId, poolLoaded]);

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
    const interval = setInterval(run, liveConnected ? POLL_MS_LIVE : POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, phaseGroupId, selectedSet, pickingPool, liveConnected, changeSignal]);

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
      if (selectedSet || showHelp || showAccount || showMains) return;

      const active = document.activeElement;
      const inField = active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement;

      // Tab swaps which pile is being searched. Shift+Tab is deliberately left
      // alone: swallowing both would mean focus could never leave this screen
      // by keyboard, stranding a keyboard-only TO away from the header buttons
      // — a keyboard trap (WCAG 2.1.2), which Escape does not fix, because it
      // exits completed mode rather than moving focus.
      if (e.key === 'Tab' && !e.shiftKey && !(inField && active !== searchRef.current)) {
        e.preventDefault();
        showMode(mode === 'open' ? 'completed' : 'open');
        return;
      }

      if (e.key === '/' && !inField) {
        e.preventDefault();
        searchRef.current?.focus();
        return;
      }
      if (e.key === 'Escape') {
        // Leaving completed mode comes first, so Escape is always the way back
        // from a Tab rather than wiping the query the TO just typed.
        if (mode === 'completed') {
          showMode('open');
          return;
        }
        setQuery('');
        searchRef.current?.blur();
        return;
      }

      // Digit picks only fire with no field focused, so they never fight with
      // typing into the search box or the Top X input.
      if (!inField && /^[1-9]$/.test(e.key)) {
        e.preventDefault();
        const pick = visibleRows[Number(e.key) - 1];
        if (pick) openRow(pick);
        return;
      }

      // Arrow/Enter list navigation applies in the search box or with nothing
      // focused, but not in another field (e.g. Top X), where they should
      // keep their native meaning (number spinner, no-op enter).
      if (inField && active !== searchRef.current) return;

      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setRevealed(true);
        setHighlight((h) => Math.min(h + 1, visibleRows.length - 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setRevealed(true);
        setHighlight((h) => Math.max(h - 1, 0));
      } else if (e.key === 'Enter') {
        // With more than one result and nothing highlighted yet, a first
        // Enter only reveals the highlight (and blurs, so 1-9 become hotkeys)
        // rather than opening whatever happens to be on top. The guard is
        // about not acting on a choice the TO can't see — so it keys off
        // whether the highlight is showing, which means a query naming one
        // player in completed mode goes straight through.
        if (!showHighlight) {
          e.preventDefault();
          setRevealed(true);
          searchRef.current?.blur();
          return;
        }
        const pick = visibleRows[highlight];
        if (pick) openRow(pick);
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  });

  // Everything the keydown effect closes over has to be declared above the
  // early returns below, or it sits in the temporal dead zone on any screen
  // that returns early and a keypress throws.
  const allBracketSets = bracketGroup?.sets ?? [];
  const bracketById = bracketSetById(allBracketSets);

  const results = fuzzyMatchSets(query, sets, (s) => s.entrants.map((e) => e.name))
    .map((s) => (!s.isStarted && startedIds.has(s.id) ? { ...s, isStarted: true } : s))
    .sort((a, b) => Number(b.isStarted) - Number(a.isStarted));

  // Most recently finished first. A player's own sets are ordered by the
  // bracket anyway, but as soon as a query matches two players their chains
  // interleave and only wall-clock can order them.
  const completedMatches = fuzzyMatchSets(
    query,
    allBracketSets.filter((s) => s.state === 3),
    (s) => s.slots.map((slot) => slot.entrant?.name ?? '')
  )
    .slice()
    .sort((a, b) => (b.completedAt ?? 0) - (a.completedAt ?? 0));

  // Every player whose tag matches, by entrant id — not by name, because two
  // different players can share a tag, and collapsing them would treat them as
  // one and hand the TO someone else's set to correct.
  const trimmedQuery = query.trim().toLowerCase();
  const matchedPlayers = new Map<number, string>();
  if (trimmedQuery) {
    for (const set of completedMatches) {
      for (const slot of set.slots) {
        if (slot.entrant && slot.entrant.name.toLowerCase().includes(trimmedQuery)) {
          matchedPlayers.set(slot.entrant.id, slot.entrant.name.toLowerCase());
        }
      }
    }
  }

  // One tag can contain another — "Chief" is inside "AlphaChief" — and then a
  // substring match names two players no matter how much the TO types, so the
  // shorter tag could never be searched for at all. Typing a tag in full is an
  // unambiguous act, so an exact hit beats the tags merely containing it. Two
  // players sharing that exact tag stays ambiguous, which is the real case.
  const exactlyNamed = [...matchedPlayers].flatMap(([id, name]) => (name === trimmedQuery ? [id] : []));
  const soleEntrantId =
    exactlyNamed.length === 1 ? exactlyNamed[0] : matchedPlayers.size === 1 ? [...matchedPlayers.keys()][0] : null;

  // Naming one player asks for that player's history, so the longer tag's sets
  // drop out rather than sitting in the middle of it.
  const playerHistory =
    soleEntrantId === null
      ? completedMatches
      : completedMatches.filter((set) => set.slots.some((slot) => slot.entrant?.id === soleEntrantId));

  // Collapsed, the panel is a glance-able queue of what can be started right
  // now; expanded, it's the full search. Everything below — keyboard picks
  // included — targets whichever list is actually on screen.
  const readyToStart = results.filter((s) => !s.isStarted && !s.isPreview);
  // Completed mode is always a deliberate search, so the panel stays open.
  const panelExpanded = mode === 'completed' || searchFocused || query.trim().length > 0;

  const visibleRows: PanelRow[] =
    mode === 'completed'
      ? playerHistory.map((set) => ({ kind: 'completed' as const, set }))
      : (panelExpanded ? results : readyToStart).map((set) => ({ kind: 'open' as const, set }));

  // A query naming exactly one player pulls up that player's history, and the
  // top row is their latest set — so highlight it without waiting for an arrow
  // key. Two players matched (say "JL" against two tags) stays ambiguous.
  const soleMatchedPlayer = mode === 'completed' && soleEntrantId !== null;

  // A single match is unambiguous, so it stays highlighted the same way it
  // always has — only an actual choice among several needs `revealed` first.
  const showHighlight = visibleRows.length <= 1 || revealed || soleMatchedPlayer;

  if (user === undefined) return <div className="settings-screen"><h1>SmashSet</h1></div>;
  if (user === null) return <SignIn />;
  if (!event) return <Settings onResolved={handleResolved} />;

  /**
   * Writes the main through, then reflects it locally rather than waiting for
   * the next poll — which is up to 12s away now that the change stream carries
   * the urgent updates, and a main the TO just set should not appear to have
   * been ignored for that long.
   */
  async function handleSetMain(playerId: number, characterId: number | null): Promise<void> {
    if (!event) return;
    await updatePlayerMain(playerId, event.videogame.id, characterId);
    setSets((current) =>
      current.map((set) => ({
        ...set,
        entrants: set.entrants.map((entrant) =>
          entrant.playerId === playerId
            ? { ...entrant, suggestedMain: { characterId, gamesTallied: 0, setsConsidered: 0 } }
            : entrant
        ),
      }))
    );
  }

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
        eventId={event.id}
        eventName={event.name}
        phaseGroups={phaseGroups}
        onPicked={pickPool}
        onBack={phaseGroupId !== null ? () => setPickingPool(false) : backToEventPicker}
      />
    );
  }

  if (phaseGroupId === null) return <div className="settings-screen"><h1>SmashSet</h1></div>;


  function openRow(row: PanelRow) {
    if (row.kind === 'open') selectSet(row.set);
    else selectFromBracket(row.set);
  }

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
      await startSet(s.id, phaseGroupId ?? undefined);
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
          phaseGroupId={phaseGroupId}
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
    <div className="app-shell unified">
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
            onClick={() => setShowMains(true)}
            title="Player mains"
            aria-label="Player mains"
          >
            ☺
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

      <div className="bracket-stage">
        <Bracket
          group={bracketGroup}
          characters={characters}
          onSelectSet={selectFromBracket}
          focusedSetId={showHighlight ? (visibleRows[highlight]?.set.id ?? null) : null}
        />
      </div>

      <SetPanel
        mode={mode}
        expanded={panelExpanded}
        query={query}
        searchRef={searchRef}
        onQueryChange={(value) => {
          setQuery(value);
          setHighlight(0);
          setRevealed(false);
        }}
        onSearchFocus={() => setSearchFocused(true)}
        onSearchBlur={() => setSearchFocused(false)}
        onModeChange={showMode}
        error={loadError ?? bracketLoadError}
        collapsedLabel={readyToStart.length === 1 ? '1 ready to start' : `${readyToStart.length} ready to start`}
      >
        {visibleRows.map((row, i) => {
          const active = showHighlight && i === highlight;
          // Keeps focus in the search box, so the blur that would collapse the
          // panel never fires between pressing and releasing on a row.
          const rowProps = {
            onMouseDown: (e: React.MouseEvent) => e.preventDefault(),
            onMouseEnter: () => {
              setRevealed(true);
              setHighlight(i);
            },
            onClick: () => openRow(row),
          };

          if (row.kind === 'completed') {
            const prior = priorResultFor(row.set);
            return (
              <li key={`done-${row.set.id}`} className={active ? 'active' : ''} {...rowProps}>
                {i < 9 && <span className="result-num">{i + 1}</span>}
                <span className="entrant-names">
                  {prior ? (
                    <>
                      <strong>{prior.winnerName}</strong> def. {prior.loserName}
                      {prior.winnerScore !== null && prior.loserScore !== null
                        ? ` ${prior.winnerScore}–${prior.loserScore}`
                        : ''}
                    </>
                  ) : (
                    row.set.slots.map((slot) => slot.entrant?.name ?? 'TBD').join(' vs ')
                  )}
                </span>
                <span className="round-text">{row.set.fullRoundText} · tap to correct</span>
              </li>
            );
          }

          const s = row.set;
          return (
            <li key={s.id} className={`${active ? 'active' : ''} ${s.isStarted ? 'started' : ''}`} {...rowProps}>
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
          );
        })}
        {visibleRows.length === 0 && (
          <li className="empty">
            {mode === 'completed'
              ? `No completed sets match "${query}"`
              : panelExpanded
                ? `No open sets match "${query}"`
                : 'Nothing ready to start'}
          </li>
        )}
      </SetPanel>

      {toast && <div className={`toast toast-${toast.kind}`}>{toast.message}</div>}
      {showHelp && <HelpModal onClose={() => setShowHelp(false)} />}
      {showMains && phaseGroupId !== null && (
        <MainsPanel
          phaseGroupId={phaseGroupId!}
          characters={characters}
          onClose={() => setShowMains(false)}
          onSave={handleSetMain}
        />
      )}
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
