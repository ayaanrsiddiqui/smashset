import { useCallback, useEffect, useState } from 'react';
import { fetchAdminReports } from './api';
import type { AdminBracket, AdminDashboardData, AdminSet, AdminSummary } from './types';

interface Props {
  onClose: () => void;
}

/** "6.4s", "4m 12s", "1h 3m" — whichever unit a person would say it in. */
export function formatDuration(ms: number | null): string {
  if (ms === null) return '—';
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m ${Math.round((ms % 60_000) / 1000)}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/** "40% (4 of 10)", or a dash when there is nothing to divide by. */
export function formatShare(part: number, whole: number): string {
  if (whole === 0) return '—';
  return `${Math.round((part / whole) * 100)}% (${part} of ${whole})`;
}

function bracketTitle(b: AdminBracket): string {
  const where = [b.eventName, [b.phaseName, b.displayIdentifier].filter(Boolean).join(' ')].filter(Boolean).join(' · ');
  return where || `Unnamed bracket (phase group ${b.phaseGroupId})`;
}

/**
 * A set recovered from logs is only there because the browser's beacon arrived
 * after the report, so a count that includes one is a floor, not a total.
 */
function hasLogSets(b: AdminBracket): boolean {
  return b.sets.some((s) => s.fromLog);
}

/** "Reported 34 of 58 sets" — the number the whole page exists to answer. */
function coverage(b: AdminBracket): string {
  const n = b.summary.reportedSets;
  const atLeast = hasLogSets(b) ? 'at least ' : '';
  if (b.totalSets === null) return `Reported ${atLeast}${n} set${n === 1 ? '' : 's'} · bracket size not counted yet`;
  return `Reported ${atLeast}${n} of ${b.totalSets} sets (${Math.round((n / b.totalSets) * 100)}%)`;
}

function SummaryFigures({ summary }: { summary: AdminSummary }) {
  return (
    <dl className="admin-figures">
      <div>
        <dt>Median time to report</dt>
        <dd>
          {formatDuration(summary.medianOpenToReportMs)}
          {/* A median of three says little, so the count travels with it. */}
          <span className="admin-n"> {summary.timedSets} timed</span>
        </dd>
      </div>
      <div>
        <dt>Median delivery</dt>
        <dd>
          {formatDuration(summary.medianDeliveryMs)}
          <span className="admin-n"> {summary.deliveredSets} timed</span>
        </dd>
      </div>
      <div>
        <dt>Characters, both players</dt>
        <dd>{formatShare(summary.bothCharacters, summary.charactersKnown)}</dd>
      </div>
      <div>
        <dt>Characters, either player</dt>
        <dd>{formatShare(summary.anyCharacters, summary.charactersKnown)}</dd>
      </div>
    </dl>
  );
}

function setLabel(s: AdminSet): string {
  if (s.winnerName && s.loserName) return `${s.winnerName} ${s.winnerScore ?? '?'}–${s.loserScore ?? '?'} ${s.loserName}`;
  // Recorded without names (rows from before they were kept): the id is all there is.
  return `set ${s.setId}`;
}

function characterCell(s: AdminSet): string {
  if (s.winnerCharacterGames === null || s.loserCharacterGames === null || s.games === null) return '—';
  return `W ${s.winnerCharacterGames}/${s.games} · L ${s.loserCharacterGames}/${s.games}`;
}

function SetRows({ sets }: { sets: AdminSet[] }) {
  return (
    // Scrolls sideways on its own on a phone rather than widening the page.
    <div className="admin-table-wrap">
      <table className="admin-sets">
        <thead>
          <tr>
            <th>Set</th>
            <th>Reported</th>
            <th>By</th>
            <th>To report</th>
            <th>Delivery</th>
            <th>Characters</th>
            <th>Notes</th>
          </tr>
        </thead>
        <tbody>
          {sets.map((s) => (
            <tr key={s.setId}>
              <td className="admin-set-label">{setLabel(s)}</td>
              <td>{new Date(s.firstReportedAt).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</td>
              <td>{s.reporter ?? '—'}</td>
              <td>{formatDuration(s.openToReportMs)}</td>
              <td>{formatDuration(s.deliveryMs)}</td>
              <td>{characterCell(s)}</td>
              <td className="admin-notes">
                {s.reports > 1 && <span className="admin-tag">corrected</span>}
                {s.foundOnFile > 0 && <span className="admin-tag">retry found it on start.gg</span>}
                {s.fromLog && <span className="admin-tag">from logs</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function AdminDashboard({ onClose }: Props) {
  const [data, setData] = useState<AdminDashboardData | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    setError(null);
    fetchAdminReports()
      .then(setData)
      .catch((err) => setError(err instanceof Error ? err.message : 'Could not load reported sets.'));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKeyDown);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = prevOverflow;
    };
  }, [onClose]);

  return (
    <div className="help-backdrop" onClick={onClose}>
      <div
        className="help-modal admin-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="admin-modal-title"
        onClick={(e) => e.stopPropagation()}
      >
        <button type="button" className="help-close" onClick={onClose} aria-label="Close">
          ✕
        </button>
        <div className="help-modal-body">
          <h2 id="admin-modal-title">Reported with smashset</h2>

          {/* Shown, never swallowed: a dashboard that fails to load and draws
              nothing reads as "no sets reported", which is a wrong answer. */}
          {error && (
            <div className="admin-error" role="alert">
              <p className="error">{error}</p>
              <button type="button" onClick={load}>
                try again
              </button>
            </div>
          )}
          {!data && !error && <p className="account-loading">Loading…</p>}

          {data && data.brackets.length === 0 && (
            <p className="admin-empty">Nothing reported yet. Sets appear here as start.gg confirms them.</p>
          )}

          {data && data.brackets.length > 0 && (
            <>
              <section className="admin-overall">
                <p className="admin-coverage">
                  {data.brackets.some(hasLogSets) ? 'At least ' : ''}
                  {data.overall.reportedSets} set{data.overall.reportedSets === 1 ? '' : 's'} reported across{' '}
                  {data.brackets.length} bracket{data.brackets.length === 1 ? '' : 's'}
                </p>
                <SummaryFigures summary={data.overall} />
              </section>

              {data.brackets.map((b, i) => (
                // The most recent bracket open, the rest folded: a season of
                // events is too long to read unfolded.
                <details key={b.phaseGroupId} className="admin-bracket" open={i === 0}>
                  <summary>
                    <span className="admin-bracket-title">
                      {b.tournamentName ?? 'Unknown tournament'} · {bracketTitle(b)}
                    </span>
                    <span className="admin-coverage">{coverage(b)}</span>
                  </summary>
                  {b.tournamentSlug && (
                    <a className="admin-startgg-link" href={`https://www.start.gg/${b.tournamentSlug}`} target="_blank" rel="noreferrer">
                      open on start.gg
                    </a>
                  )}
                  <SummaryFigures summary={b.summary} />
                  <SetRows sets={b.sets} />
                </details>
              ))}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
