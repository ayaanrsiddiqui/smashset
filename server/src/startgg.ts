const ENDPOINT = 'https://api.start.gg/gql/alpha';

export class StartggError extends Error {
  constructor(message: string, public status?: number, public gqlErrors?: unknown) {
    super(message);
  }
}

export async function gql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
  const apiKey = process.env.STARTGG_API_KEY;
  if (!apiKey) {
    throw new StartggError('STARTGG_API_KEY is not set in .env');
  }

  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ query, variables }),
  });

  const body = (await res.json()) as { data?: T; errors?: unknown };

  if (!res.ok) {
    throw new StartggError(`start.gg API request failed (${res.status})`, res.status, body.errors);
  }
  if (body.errors) {
    throw new StartggError('start.gg API returned errors', res.status, body.errors);
  }
  if (!body.data) {
    throw new StartggError('start.gg API returned no data');
  }
  return body.data;
}

export type ParsedInput = { type: 'event'; slug: string } | { type: 'tournament'; slug: string };

/**
 * Accepts a full start.gg URL, a "tournament/<t-slug>/event/<e-slug>" event
 * slug, or a bare tournament URL/slug (e.g. "fireslam23test", the common
 * case for a tournament with a single event) and figures out which one it
 * is and what to look up.
 */
export function parseStartggInput(input: string): ParsedInput {
  let s = input.trim();
  s = s.replace(/^(https?:\/\/)?(www\.)?start\.gg\//i, '');
  s = s.replace(/^\/+/, '').replace(/\/+$/, '');
  s = s.split('?')[0];

  const eventMatch = s.match(/^tournament\/([^/]+)\/event\/([^/]+)/);
  if (eventMatch) {
    return { type: 'event', slug: `tournament/${eventMatch[1]}/event/${eventMatch[2]}` };
  }

  const tournamentMatch = s.match(/^tournament\/([^/]+)/);
  if (tournamentMatch) {
    return { type: 'tournament', slug: tournamentMatch[1] };
  }

  const bare = s.split('/')[0];
  return { type: 'tournament', slug: bare };
}
