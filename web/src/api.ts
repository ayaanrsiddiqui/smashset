import type { AccountDetails, BracketGroup, Character, CurrentUser, EntrantMatch, EventInfo, OpenSet, PhaseGroupSummary, PoolPreview, SetDetail, Stage } from './types';

export class ApiError extends Error {
  // Assigned explicitly rather than as a constructor parameter property: the
  // web build runs with erasableSyntaxOnly, which rejects syntax that needs a
  // runtime transform.
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

// Venue wifi drops connections without closing them, and a fetch with no
// timeout waits forever — the poll that issued it never completes and never
// retries, so the screen just stops updating with nothing to show for it.
// Longer than the server's own 20s upstream timeout, on purpose. If the client
// gave up first, a report that actually succeeded would surface as a failure
// and a TO would report it again.
const REQUEST_TIMEOUT_MS = 25_000;

async function req<T>(url: string, opts?: RequestInit): Promise<T> {
  let res: Response;
  try {
    // Same-origin requests already send cookies by default, but being
    // explicit removes any ambiguity now that the session cookie matters.
    res = await fetch(url, { ...opts, credentials: 'include', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  } catch (err) {
    // Status 0: the request never got an answer at all, so there is no HTTP
    // status to report and nothing here should look like a signed-out 401.
    const timedOut = err instanceof Error && err.name === 'TimeoutError';
    throw new ApiError(
      timedOut ? 'Timed out reaching the server. Check your connection.' : 'Could not reach the server. Check your connection.',
      0
    );
  }
  // Gateway errors and rate-limit pages aren't JSON, so parsing before the
  // status check would throw a parser error and lose the status with it —
  // and the status is what tells a dead session apart from a failed request.
  let body: { error?: string } | null = null;
  let parsed = true;
  try {
    body = (await res.json()) as { error?: string } | null;
  } catch {
    parsed = false;
  }

  if (!res.ok) {
    throw new ApiError(body?.error ?? `Request failed (${res.status})`, res.status);
  }
  // A 200 that isn't JSON is a captive portal or a proxy interstitial, not
  // data. Returning it would hand callers null to destructure.
  if (!parsed) {
    throw new ApiError('Got an unexpected response from the network. Check your connection.', 0);
  }
  return body as T;
}

export function fetchMe(): Promise<{ user: CurrentUser | null }> {
  return req('/api/me');
}

export function logout(): Promise<{ ok: true }> {
  return req('/api/auth/logout', { method: 'POST' });
}

export function fetchAccount(): Promise<AccountDetails> {
  return req('/api/account');
}

export function updateTopXBo5(topXBo5: number | null): Promise<{ topXBo5: number | null }> {
  return req('/api/account/preferences', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ topXBo5 }),
  });
}

export function updatePlayerMain(
  playerId: number,
  videogameId: number,
  characterId: number | null
): Promise<{ characterId: number | null }> {
  return req('/api/mains', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ playerId, videogameId, characterId }),
  });
}

export function resolveEvent(input: string): Promise<{ event?: EventInfo; events?: EventInfo[] }> {
  return req('/api/event/resolve', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ input }),
  });
}

export function fetchPhaseGroups(eventId: number): Promise<{ phaseGroups: PhaseGroupSummary[] }> {
  return req(`/api/sets/${eventId}/phase-groups`);
}

/**
 * Callers must hold to MIN_PLAYER_QUERY; the server rejects anything shorter,
 * because a one- or two-character filter matches most of a big event.
 */
export function searchEntrants(eventId: number, query: string): Promise<{ entrants: EntrantMatch[] }> {
  return req(`/api/sets/${eventId}/entrants?q=${encodeURIComponent(query)}`);
}

/** Who is in each pool of a phase. Loaded per phase, only when one is opened. */
export function fetchPoolPreviews(phaseId: number): Promise<{ previews: PoolPreview[] }> {
  return req(`/api/sets/phase/${phaseId}/pool-preview`);
}

export function fetchOpenSets(phaseGroupId: number): Promise<{ sets: OpenSet[] }> {
  return req(`/api/sets/phase-group/${phaseGroupId}/open-sets`);
}

export function startSet(setId: number | string): Promise<{ ok: true }> {
  return req(`/api/sets/${setId}/start`, { method: 'POST' });
}

export function fetchBracket(phaseGroupId: number): Promise<BracketGroup> {
  return req(`/api/sets/phase-group/${phaseGroupId}/bracket`);
}

export function fetchSetDetail(setId: number | string): Promise<SetDetail> {
  return req(`/api/sets/${setId}/detail`);
}

export function fetchCharacters(videogameId: number): Promise<{ characters: Character[] }> {
  return req(`/api/characters/${videogameId}`);
}

export function fetchStages(videogameId: number): Promise<{ stages: Stage[] }> {
  return req(`/api/stages/${videogameId}`);
}

export interface CharacterSelection {
  gameNum: number;
  winnerCharacterId?: number;
  loserCharacterId?: number;
}

export interface StageSelection {
  gameNum: number;
  stageId: number;
}

export interface ReportPayload {
  setId: number | string;
  winnerEntrantId: number;
  loserEntrantId: number;
  requiredWins: number;
  shorthand: string;
  characters?: CharacterSelection[];
  stages?: StageSelection[];
}

export function reportSet(payload: ReportPayload): Promise<{ result: unknown }> {
  return req('/api/report', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}
