import { useEffect, useMemo, useState } from 'react';
import { searchEntrants } from './api';
import type { EntrantMatch, PhaseGroupSummary } from './types';

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

  function toggle(phaseId: number) {
    setExpanded((open) => {
      const next = new Set(open);
      if (!next.delete(phaseId)) next.add(phaseId);
      return next;
    });
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
                      <span className="round-text">{pool.bracketType.replaceAll('_', ' ').toLowerCase()}</span>
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
