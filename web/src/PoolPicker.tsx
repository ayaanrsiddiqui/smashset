import { useEffect, useMemo, useRef, useState } from 'react';
import { fetchPoolPreviews, searchEntrants } from './api';
import type { EntrantMatch, PhaseGroupSummary, PoolPreview } from './types';

interface Props {
  eventId: number;
  eventName: string;
  phaseGroups: PhaseGroupSummary[];
  onPicked: (phaseGroupId: number) => void;
  onBack: () => void;
}

export interface Phase {
  id: number;
  name: string;
  numSeeds: number;
  pools: PhaseGroupSummary[];
}

/**
 * Below this, a lookup isn't worth making. Filtering Supernova's 1581 entrants
 * by "a" matches 900 of them, so a short query returns a dropdown that answers
 * nothing while spending a request against start.gg's per-token rate limit.
 * The server refuses these too — this is the reason, not the enforcement.
 */
export const MIN_PLAYER_QUERY = 3;
const LOOKUP_DEBOUNCE_MS = 250;

/**
 * Pools grouped under their phase, in the order start.gg's own bracket page
 * shows them — see PhaseGroupSummary on the server for why that's seed count
 * and not phaseOrder.
 */
export function groupIntoPhases(phaseGroups: PhaseGroupSummary[]): Phase[] {
  const byPhase = new Map<number, Phase>();
  for (const pg of phaseGroups) {
    const phase = byPhase.get(pg.phaseId) ?? { id: pg.phaseId, name: pg.phaseName, numSeeds: pg.phaseNumSeeds, pools: [] };
    phase.pools.push(pg);
    byPhase.set(pg.phaseId, phase);
  }

  const phases = [...byPhase.values()];
  for (const phase of phases) {
    // Numeric collation, because pool "A9" comes before "A10" and a plain
    // string sort puts it after.
    phase.pools.sort((a, b) => a.displayIdentifier.localeCompare(b.displayIdentifier, undefined, { numeric: true }));
  }
  return phases.sort((a, b) => b.numSeeds - a.numSeeds);
}

/**
 * Shown only when an event has more than one pool (see App.tsx). Phases start
 * collapsed: a big event has 64 pools in its first phase alone, and a TO
 * looking for one of them should not have to scroll past the rest of the
 * tournament to find it — or to find the way back.
 *
 * Pool names mean little on their own, so a player lookup answers the question
 * a TO actually has: which pool is this person in? Naming one player narrows
 * every phase to their own pools and marks the phases they never reached.
 */
export function PoolPicker({ eventId, eventName, phaseGroups, onPicked, onBack }: Props) {
  const phases = useMemo(() => groupIntoPhases(phaseGroups), [phaseGroups]);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());

  const [playerQuery, setPlayerQuery] = useState('');
  const [matches, setMatches] = useState<EntrantMatch[] | null>(null);
  const [player, setPlayer] = useState<EntrantMatch | null>(null);
  const [searching, setSearching] = useState(false);
  const [lookupError, setLookupError] = useState<string | null>(null);

  const [previews, setPreviews] = useState<Map<number, PoolPreview>>(new Map());
  const [previewError, setPreviewError] = useState<string | null>(null);
  // Which phases have been asked for. A ref rather than state on purpose: as
  // state it would be a dependency of the effect that writes it, so opening a
  // phase would re-run the effect and its cleanup would cancel the very fetch
  // it had just started, and no names would ever arrive.
  const requestedPhases = useRef<Set<number>>(new Set());
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    const query = playerQuery.trim();
    if (query.length < MIN_PLAYER_QUERY) {
      // Deliberately inert rather than searching-as-you-type from the first
      // keystroke: see MIN_PLAYER_QUERY.
      setMatches(null);
      setPlayer(null);
      setLookupError(null);
      setSearching(false);
      return;
    }

    let cancelled = false;
    setSearching(true);
    const timer = setTimeout(() => {
      searchEntrants(eventId, query)
        .then(({ entrants }) => {
          if (cancelled) return;
          setMatches(entrants);
          // One match is an answer, so show it without making them click.
          setPlayer(entrants.length === 1 ? entrants[0] : null);
          setLookupError(null);
        })
        .catch((err: unknown) => {
          if (cancelled) return;
          setMatches(null);
          setPlayer(null);
          setLookupError(err instanceof Error ? err.message : 'Player lookup failed');
        })
        .finally(() => {
          if (!cancelled) setSearching(false);
        });
    }, LOOKUP_DEBOUNCE_MS);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [playerQuery, eventId]);

  // Naming a player is a question about their whole run, so every phase opens
  // at once rather than making the TO expand five of them.
  useEffect(() => {
    if (player) setExpanded(new Set(phases.map((phase) => phase.id)));
  }, [player, phases]);

  // Pool names mean nothing on their own, so an open phase shows who is in each
  // of its pools. Loaded per phase and only once opened, because a phase can
  // hold 64 pools and the whole event at once would be a far bigger request
  // than the screen needs. Skipped entirely while a player is selected: those
  // rows show that player, and expanding every phase would otherwise fetch the
  // entire event to display names it isn't going to use.
  useEffect(() => {
    if (player) return;
    const missing = phases.filter((phase) => expanded.has(phase.id) && !requestedPhases.current.has(phase.id));
    for (const phase of missing) {
      requestedPhases.current.add(phase.id);
      fetchPoolPreviews(phase.id)
        .then(({ previews: loaded }) => {
          if (!mounted.current) return;
          setPreviews((current) => {
            const next = new Map(current);
            for (const preview of loaded) next.set(preview.phaseGroupId, preview);
            return next;
          });
          setPreviewError(null);
        })
        .catch((err: unknown) => {
          if (!mounted.current) return;
          // Retryable: forget the phase so reopening it asks again.
          requestedPhases.current.delete(phase.id);
          setPreviewError(err instanceof Error ? err.message : 'Could not load who is in each pool');
        });
    }
  }, [expanded, phases, player]);

  function previewFor(pool: PhaseGroupSummary): { names: string; hidden: number } | null {
    const preview = previews.get(pool.id);
    if (!preview || preview.names.length === 0) return null;
    return { names: preview.names.join(' · '), hidden: preview.total - preview.names.length };
  }

  function toggle(phaseId: number) {
    setExpanded((open) => {
      const next = new Set(open);
      if (!next.delete(phaseId)) next.add(phaseId);
      return next;
    });
  }

  /**
   * Which pools a candidate is in, so two players sharing a tag are telling
   * apart. Without it the dropdown renders identical rows and offering a
   * choice is theatre — and a tag being shared is exactly when it appears.
   */
  function poolsOf(match: EntrantMatch): string {
    const identifiers = phaseGroups
      .filter((pg) => match.phaseGroupIds.includes(pg.id))
      .sort((a, b) => b.phaseNumSeeds - a.phaseNumSeeds)
      .map((pg) => pg.displayIdentifier);
    return identifiers.join(' → ');
  }

  function poolsIn(phase: Phase): PhaseGroupSummary[] {
    if (!player) return phase.pools;
    return phase.pools.filter((pool) => player.phaseGroupIds.includes(pool.id));
  }

  return (
    <div className="settings-screen">
      <button className="back-link" onClick={onBack}>
        ← back
      </button>
      <h1>SmashSet</h1>
      <p className="subtitle">"{eventName}" has multiple pools/brackets — pick one to view and manage</p>

      <div className="player-lookup">
        <input
          className="search-box"
          value={playerQuery}
          placeholder="Find a player…"
          onChange={(e) => setPlayerQuery(e.target.value)}
        />
        {lookupError && <p className="error">{lookupError}</p>}
        {previewError && <p className="error">{previewError}</p>}
        {!lookupError && searching && <p className="lookup-note">Searching…</p>}
        {!lookupError && !searching && matches?.length === 0 && (
          <p className="lookup-note">No player matching "{playerQuery.trim()}"</p>
        )}

        {/* Ambiguous: name them all and let the TO say which. */}
        {!player && matches && matches.length > 1 && (
          <ul className="results-list lookup-matches">
            {matches.map((match) => (
              <li key={match.id} onClick={() => setPlayer(match)}>
                <span className="entrant-names">{match.name}</span>
                <span className="round-text">{poolsOf(match) || 'not in a pool yet'}</span>
              </li>
            ))}
          </ul>
        )}

        {player && (
          <p className="lookup-note">
            Showing <strong>{player.name}</strong>'s pools ·{' '}
            <button className="back-link" onClick={() => setPlayerQuery('')}>
              show all
            </button>
          </p>
        )}
      </div>

      <ul className="phase-list">
        {phases.map((phase) => {
          const pools = poolsIn(phase);
          const absent = player !== null && pools.length === 0;
          const open = expanded.has(phase.id);
          return (
            <li key={phase.id}>
              <button
                type="button"
                className={`phase-row${absent ? ' absent' : ''}`}
                aria-expanded={open}
                onClick={() => toggle(phase.id)}
              >
                <span className="phase-caret" aria-hidden="true">
                  {open ? '▾' : '▸'}
                </span>
                <span className="entrant-names">{phase.name}</span>
                <span className="round-text">
                  {absent ? 'did not reach' : pools.length === 1 ? '1 bracket' : `${pools.length} brackets`}
                </span>
              </button>

              {open && pools.length > 0 && (
                <ul className="results-list pool-list">
                  {pools.map((pool) => (
                    <li key={pool.id} onClick={() => onPicked(pool.id)}>
                      <span className="entrant-names">{pool.displayIdentifier}</span>
                      {player ? (
                        <span className="round-text pool-preview">
                          <strong className="matched-player">{player.name}</strong>
                        </span>
                      ) : (
                        <>
                          <span className="round-text pool-preview">
                            {previewFor(pool)?.names ?? pool.bracketType.replaceAll('_', ' ').toLowerCase()}
                          </span>
                          {/* Its own column, so the count survives the name
                              list being truncated — it's the part that says
                              how much the row is not showing. */}
                          {(previewFor(pool)?.hidden ?? 0) > 0 && (
                            <span className="round-text pool-more">+{previewFor(pool)!.hidden} more</span>
                          )}
                        </>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
