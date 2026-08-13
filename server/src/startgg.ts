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

/**
 * Accepts a full start.gg URL or a bare "tournament/<t-slug>/event/<e-slug>"
 * slug and normalizes it to the slug form the API expects.
 */
export function normalizeEventSlug(input: string): string {
  let s = input.trim();
  s = s.replace(/^https?:\/\/(www\.)?start\.gg\//i, '');
  s = s.replace(/^\/+/, '').replace(/\/+$/, '');
  // Drop anything after /event/<slug> (e.g. /brackets/..., ?query params)
  const match = s.match(/^(tournament\/[^/]+\/event\/[^/?]+)/);
  if (match) return match[1];
  return s;
}
