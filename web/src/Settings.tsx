import { useEffect, useState } from 'react';
import { resolveEvent } from './api';
import type { EventInfo } from './types';

interface Props {
  onResolved: (event: EventInfo, input: string) => void;
  /**
   * What was typed to reach the current event, re-resolved on mount so
   * "switch event" lands on that tournament's event list rather than on an
   * empty slug field the TO has to fill in again.
   */
  initialInput?: string;
}

export function Settings({ onResolved, initialInput }: Props) {
  const [input, setInput] = useState(initialInput ?? '');
  const [loading, setLoading] = useState(Boolean(initialInput));
  const [error, setError] = useState<string | null>(null);
  const [choices, setChoices] = useState<EventInfo[] | null>(null);

  /**
   * `autoSelect` is false when re-opening a tournament the TO is already in.
   * Resolving to a single event would otherwise pick it immediately and drop
   * them straight back where they pressed "switch event" from, which is the
   * one place they have just said they do not want to be.
   */
  async function submit(value: string, autoSelect: boolean) {
    if (!value.trim()) return;
    setLoading(true);
    setError(null);
    setChoices(null);
    try {
      const { event, events } = await resolveEvent(value);
      const found = event ? [event] : (events ?? []);
      if (found.length === 0) {
        setError('No events found');
      } else if (autoSelect && found.length === 1) {
        onResolved(found[0], value);
      } else {
        setChoices(found);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to resolve event');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (initialInput) void submit(initialInput, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (choices) {
    return (
      <div className="settings-screen">
        <h1>SmashSet</h1>
        <p className="subtitle">
          {choices.length === 1
            ? `"${choices[0].tournament.name}" — one event`
            : `"${choices[0].tournament.name}" has multiple events — pick one`}
        </p>
        <ul className="results-list">
          {choices.map((e) => (
            <li key={e.id} onClick={() => onResolved(e, input)}>
              <span className="entrant-names">{e.name}</span>
              <span className="round-text">{e.videogame.name}</span>
            </li>
          ))}
        </ul>
        {/* Not "back" any more: from here it is the way to a different
            tournament, which is what "switch event" is usually for. */}
        <button onClick={() => setChoices(null)}>different tournament</button>
      </div>
    );
  }

  return (
    <div className="settings-screen">
      <h1>SmashSet</h1>
      <p className="subtitle">Fast set reporting for start.gg TOs</p>
      <label htmlFor="event-input">Tournament or event</label>
      {/* Shown as a URL because that is what it is resolved as: the server
          asks start.gg what start.gg/<slug> serves before anything else, so
          seeing the prefix makes a bare slug the obvious thing to type. */}
      <div className="url-field">
        <span className="url-prefix" aria-hidden="true">start.gg/</span>
        <input
          id="event-input"
          autoFocus
          value={input}
          placeholder="my-tournament"
          // A pasted full URL is folded down to its path, so the prefix never
          // ends up lying about what the field contains. The server strips the
          // same thing, so this changes appearance, not what gets resolved.
          onChange={(e) => setInput(e.target.value.replace(/^\s*(https?:\/\/)?(www\.)?start\.gg\//i, ''))}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit(input, true);
          }}
        />
      </div>
      <button onClick={() => submit(input, true)} disabled={loading || !input.trim()}>
        {loading ? 'Loading…' : 'Load event'}
      </button>
      {error && <p className="error">{error}</p>}
    </div>
  );
}
