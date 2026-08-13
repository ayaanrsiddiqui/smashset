import type { Character, EventInfo, OpenSet } from './types';

async function req<T>(url: string, opts?: RequestInit): Promise<T> {
  const res = await fetch(url, opts);
  const body = await res.json();
  if (!res.ok) {
    throw new Error(body?.error ?? `Request failed (${res.status})`);
  }
  return body as T;
}

export function resolveEvent(input: string): Promise<{ event?: EventInfo; events?: EventInfo[] }> {
  return req('/api/event/resolve', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ input }),
  });
}

export function fetchOpenSets(eventId: number): Promise<{ sets: OpenSet[] }> {
  return req(`/api/sets/${eventId}/open-sets`);
}

export function fetchCharacters(videogameId: number): Promise<{ characters: Character[] }> {
  return req(`/api/characters/${videogameId}`);
}

export interface CharacterSelections {
  mode: 'set' | 'perGame';
  winnerCharacterId?: number;
  loserCharacterId?: number;
  perGame?: { gameNum: number; winnerCharacterId?: number; loserCharacterId?: number }[];
}

export interface ReportPayload {
  setId: number | string;
  winnerEntrantId: number;
  loserEntrantId: number;
  requiredWins: number;
  shorthand: string;
  characters?: CharacterSelections;
}

export function reportSet(payload: ReportPayload): Promise<{ result: unknown }> {
  return req('/api/report', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}
