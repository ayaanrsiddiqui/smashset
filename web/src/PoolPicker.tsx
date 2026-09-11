import type { PhaseGroupSummary } from './types';

interface Props {
  eventName: string;
  phaseGroups: PhaseGroupSummary[];
  onPicked: (phaseGroupId: number) => void;
  onBack: () => void;
}

// Mirrors Settings' own "this tournament has multiple events — pick one"
// screen (same .settings-screen/.results-list markup) — shown only when an
// event actually has more than one phase/pool; a single-pool event skips
// straight past this (see App.tsx).
export function PoolPicker({ eventName, phaseGroups, onPicked, onBack }: Props) {
  return (
    <div className="settings-screen">
      <h1>SmashSet</h1>
      <p className="subtitle">"{eventName}" has multiple pools/brackets — pick one to view and manage</p>
      <ul className="results-list">
        {phaseGroups.map((pg) => (
          <li key={pg.id} onClick={() => onPicked(pg.id)}>
            <span className="entrant-names">
              {pg.phaseName} {pg.displayIdentifier}
            </span>
            <span className="round-text">{pg.bracketType.replaceAll('_', ' ').toLowerCase()}</span>
          </li>
        ))}
      </ul>
      <button onClick={onBack}>back</button>
    </div>
  );
}
