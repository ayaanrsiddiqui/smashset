import { useState } from 'react';
import { resolveEvent } from './api';
import type { EventInfo } from './types';

interface Props {
  onResolved: (event: EventInfo) => void;
}

export function Settings({ onResolved }: Props) {
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [choices, setChoices] = useState<EventInfo[] | null>(null);

  async function submit() {
    if (!input.trim()) return;
    setLoading(true);
    setError(null);
    setChoices(null);
    try {
      const { event, events } = await resolveEvent(input);
      if (event) {
        onResolved(event);
      } else if (events && events.length > 0) {
        setChoices(events);
      } else {
        setError('No events found');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to resolve event');
    } finally {
      setLoading(false);
    }
  }

  if (choices) {
    return (
      <div className="settings-screen">
        <h1>SmashSet</h1>
        <p className="subtitle">"{choices[0].tournament.name}" has multiple events — pick one</p>
        <ul className="results-list">
          {choices.map((e) => (
            <li key={e.id} onClick={() => onResolved(e)}>
              <span className="entrant-names">{e.name}</span>
              <span className="round-text">{e.videogame.name}</span>
            </li>
          ))}
        </ul>
        <button onClick={() => setChoices(null)}>back</button>
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
            if (e.key === 'Enter') submit();
          }}
        />
      </div>
      <button onClick={submit} disabled={loading || !input.trim()}>
        {loading ? 'Loading…' : 'Load event'}
      </button>
      {error && <p className="error">{error}</p>}
    </div>
  );
}
