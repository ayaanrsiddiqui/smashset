const ENDPOINT = 'https://api.start.gg/gql/alpha';

export class StartggError extends Error {
  constructor(message: string, public status?: number, public gqlErrors?: unknown) {
    super(message);
  }
}

// accessToken is always the calling user's own OAuth token — there's no
// shared/global fallback. Every request goes out under whoever is actually
// signed in, since that's the whole point of moving off one shared personal
// API key: the tournament.reporter scope only grants "tournaments the
// current user has access to," which only means anything if the token
// attached here really is theirs.
export async function gql<T>(accessToken: string, query: string, variables: Record<string, unknown>): Promise<T> {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({ query, variables }),
  });

  const body = (await res.json()) as { data?: T; errors?: unknown };

  if (!res.ok) {
    throw new StartggError(`start.gg API request failed (${res.status})`, res.status, body.errors);
  }
  if (body.errors) {
    const messages = Array.isArray(body.errors)
      ? body.errors
          .map((e) => (e && typeof e === 'object' && 'message' in e ? String((e as { message: unknown }).message) : JSON.stringify(e)))
          .join('; ')
      : JSON.stringify(body.errors);
    throw new StartggError(`start.gg API error: ${messages}`, res.status, body.errors);
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
