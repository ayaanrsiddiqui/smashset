const ENDPOINT = 'https://api.start.gg/gql/alpha';
const REQUEST_TIMEOUT_MS = 20_000;

export class StartggError extends Error {
  constructor(message: string, public status?: number, public gqlErrors?: unknown) {
    super(message);
  }
}

// start.gg rejects a request whose response would exceed its object cap, and
// puts the exact count it would have produced in the message ("actual: 1053").
// That number is what makes a failed page recoverable rather than fatal: it
// says precisely how far over budget the request was, so the caller can resize
// and retry instead of guessing.
export class StartggComplexityError extends StartggError {
  constructor(message: string, public actual: number, status?: number, gqlErrors?: unknown) {
    super(message, status, gqlErrors);
  }
}

function complexityErrorFrom(message: string, status: number | undefined, gqlErrors: unknown): StartggComplexityError | null {
  if (!/query complexity/i.test(message)) return null;
  const actual = message.match(/actual:\s*(\d+)/i);
  return actual ? new StartggComplexityError(message, Number(actual[1]), status, gqlErrors) : null;
}

export interface GqlResponse<T> {
  data: T;
  // start.gg reports what the response actually cost. Callers that page
  // through results use it to size later requests from a measurement instead
  // of a hardcoded guess. Null if start.gg omitted it.
  complexity: number | null;
}

// accessToken is always the calling user's own OAuth token — there's no
// shared/global fallback. Every request goes out under whoever is actually
// signed in, since that's the whole point of moving off one shared personal
// API key: the tournament.reporter scope only grants "tournaments the
// current user has access to," which only means anything if the token
// attached here really is theirs.
export async function gqlWithCost<T>(
  accessToken: string,
  query: string,
  variables: Record<string, unknown>
): Promise<GqlResponse<T>> {
  let res: Response;
  try {
    res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    // Without this a hung connection never settles, which is worse here than
    // on the client: mainLookup runs these under a fixed concurrency limit,
    // so a handful of stuck requests hold every slot and no main is ever
    // computed again for the life of the process.
    const timedOut = err instanceof Error && err.name === 'TimeoutError';
    throw new StartggError(timedOut ? 'start.gg did not respond in time.' : 'Could not reach start.gg.');
  }

  // Rate-limit responses and gateway errors come back as HTML or plain text,
  // so parsing as JSON first would turn a useful status into a parser error.
  const raw = await res.text();
  type Body = { data?: T; errors?: unknown; extensions?: { queryComplexity?: number } };
  let body: Body | null;
  try {
    body = JSON.parse(raw) as Body;
  } catch {
    body = null;
  }

  if (!res.ok) {
    if (res.status === 429) {
      throw new StartggError('start.gg is rate limiting us. Give it a moment and try again.', res.status);
    }
    throw new StartggError(`start.gg API request failed (${res.status})`, res.status, body?.errors);
  }
  if (!body) {
    throw new StartggError('start.gg returned a response we could not read.', res.status);
  }
  if (body.errors) {
    const messages = Array.isArray(body.errors)
      ? body.errors
          .map((e) => (e && typeof e === 'object' && 'message' in e ? String((e as { message: unknown }).message) : JSON.stringify(e)))
          .join('; ')
      : JSON.stringify(body.errors);
    throw (
      complexityErrorFrom(messages, res.status, body.errors) ??
      new StartggError(`start.gg API error: ${messages}`, res.status, body.errors)
    );
  }
  if (!body.data) {
    throw new StartggError('start.gg API returned no data');
  }
  return { data: body.data, complexity: body.extensions?.queryComplexity ?? null };
}

export async function gql<T>(accessToken: string, query: string, variables: Record<string, unknown>): Promise<T> {
  return (await gqlWithCost<T>(accessToken, query, variables)).data;
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
