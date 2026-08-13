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
        <h1>quickset</h1>
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
      <h1>quickset</h1>
      <p className="subtitle">Fast set reporting for start.gg TOs</p>
      <label htmlFor="event-input">Tournament or event URL / slug</label>
      <input
        id="event-input"
        autoFocus
        value={input}
        placeholder="https://start.gg/my-tournament"
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') submit();
        }}
      />
      <button onClick={submit} disabled={loading || !input.trim()}>
        {loading ? 'Loading…' : 'Load event'}
      </button>
      {error && <p className="error">{error}</p>}
    </div>
  );
}
