import { useMemo, useState } from 'react';
import type { PhaseGroupSummary } from './types';

interface Props {
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
 */
export function PoolPicker({ eventName, phaseGroups, onPicked, onBack }: Props) {
  const phases = useMemo(() => groupIntoPhases(phaseGroups), [phaseGroups]);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());

  function toggle(phaseId: number) {
    setExpanded((open) => {
      const next = new Set(open);
      if (!next.delete(phaseId)) next.add(phaseId);
      return next;
    });
  }

  return (
    <div className="settings-screen">
      <button className="back-link" onClick={onBack}>
        ← back
      </button>
      <h1>SmashSet</h1>
      <p className="subtitle">"{eventName}" has multiple pools/brackets — pick one to view and manage</p>

      <ul className="phase-list">
        {phases.map((phase) => {
          const open = expanded.has(phase.id);
          return (
            <li key={phase.id}>
              <button type="button" className="phase-row" aria-expanded={open} onClick={() => toggle(phase.id)}>
                <span className="phase-caret" aria-hidden="true">
                  {open ? '▾' : '▸'}
                </span>
                <span className="entrant-names">{phase.name}</span>
                <span className="round-text">
                  {phase.pools.length === 1 ? '1 bracket' : `${phase.pools.length} brackets`}
                </span>
              </button>

              {open && (
                <ul className="results-list pool-list">
                  {phase.pools.map((pool) => (
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
