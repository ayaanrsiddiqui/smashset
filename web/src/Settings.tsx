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

  async function submit() {
    if (!input.trim()) return;
    setLoading(true);
    setError(null);
    try {
      const { event } = await resolveEvent(input);
      onResolved(event);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to resolve event');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="settings-screen">
      <h1>quickset</h1>
      <p className="subtitle">Fast set reporting for start.gg TOs</p>
      <label htmlFor="event-input">Tournament event URL or slug</label>
      <input
        id="event-input"
        autoFocus
        value={input}
        placeholder="https://start.gg/tournament/my-event/event/ultimate-singles"
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
