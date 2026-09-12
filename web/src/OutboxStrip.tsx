import type { OutboxEntry } from './outbox';

interface Props {
  entries: OutboxEntry[];
  onRetry: (setId: string) => void;
  onDiscard: (setId: string) => void;
}

/**
 * What has been reported but not confirmed, on every screen.
 *
 * Rendered above App's early returns rather than inside the set list, because
 * that list exists on exactly one of several screens — not the report screen,
 * where a TO spends most of their time, and not the sign-in screen, which is
 * the one place a dead session guarantees they are looking. A failure a TO
 * cannot see minutes later is the failure this whole feature exists to fix, so
 * it cannot live somewhere they might not be.
 *
 * Nothing here ever reads as reported. Sending is sending.
 */
export function OutboxStrip({ entries, onRetry, onDiscard }: Props) {
  if (entries.length === 0) return null;
  const sending = entries.filter((entry) => entry.state === 'sending');
  const failed = entries.filter((entry) => entry.state === 'failed');
  // Two or more attempts means the first one did not work, which a TO waiting
  // for a set to clear deserves to know before they walk away from it.
  const struggling = sending.filter((entry) => entry.attempt > 1);

  return (
    <div className="outbox-strip">
      {sending.length > 0 && (
        <div className="outbox-row outbox-sending">
          <span className="outbox-label">
            Sending {sending.length === 1 ? sending[0].label : `${sending.length} reports`}…
          </span>
          {struggling.length > 0 && (
            <span className="outbox-detail">
              {struggling[0].attempt} tries{struggling[0].error ? ` — ${struggling[0].error}` : ''}
            </span>
          )}
        </div>
      )}

      {failed.map((entry) => (
        <div className="outbox-row outbox-failed" key={entry.setId}>
          <span className="outbox-tag">NOT REPORTED</span>
          <span className="outbox-label">{entry.label}</span>
          {entry.error && <span className="outbox-detail">{entry.error}</span>}
          <button type="button" onClick={() => onRetry(entry.setId)}>
            try again
          </button>
          <button type="button" className="outbox-discard" onClick={() => onDiscard(entry.setId)}>
            discard
          </button>
        </div>
      ))}
    </div>
  );
}
