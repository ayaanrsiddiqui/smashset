import type { AccountDetails, BracketGroup, Character, CurrentUser, EventInfo, OpenSet, PhaseGroupSummary, SetDetail, Stage } from './types';

async function req<T>(url: string, opts?: RequestInit): Promise<T> {
  // Same-origin requests already send cookies by default, but being
  // explicit removes any ambiguity now that the session cookie matters.
  const res = await fetch(url, { ...opts, credentials: 'include' });
  const body = await res.json();
  if (!res.ok) {
    throw new Error(body?.error ?? `Request failed (${res.status})`);
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
