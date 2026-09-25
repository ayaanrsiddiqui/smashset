import { vi } from 'vitest';
import * as api from './api';
import { ApiError } from './api';
import type { PhaseGroupSummary } from './types';

// Only usable from a test file that has already called vi.mock('./api', ...) —
// the vi.mocked() calls below assume the module registry is serving mocks.

export const TEST_EVENT = {
  id: 1,
  name: 'Big event',
  slug: 'tournament/x/event/big-event',
  videogame: { id: 1, name: 'Melee' },
  tournament: { id: 1, name: 'x' },
};

export const SOLE_PHASE_GROUP: PhaseGroupSummary = {
  id: 1,
  displayIdentifier: '1',
  phaseId: 1,
  phaseName: 'Bracket',
  phaseNumSeeds: 16,
  bracketType: 'DOUBLE_ELIMINATION',
};

export const EMPTY_BRACKET = {
  phaseGroupId: 1,
  phaseName: 'Bracket',
  displayIdentifier: '1',
  bracketType: 'DOUBLE_ELIMINATION',
  sets: [],
};

/** Lands the app straight on the main screen instead of the event picker. */
export function seedEvent(event: typeof TEST_EVENT = TEST_EVENT): void {
  localStorage.setItem('smashset.event', JSON.stringify(event));
}

export function seedPool(eventId = TEST_EVENT.id, phaseGroupId = SOLE_PHASE_GROUP.id): void {
  localStorage.setItem('smashset.phaseGroup', JSON.stringify({ eventId, phaseGroupId }));
}

/**
 * Restores every ./api mock to a working default.
 *
 * The mocks are shared vi.fn() instances across the whole file, so any block's
 * afterEach mockReset() strips defaults out from under blocks declared later —
 * a failure that shows up nowhere near its cause. Calling this in each block's
 * beforeEach keeps that in one place instead of re-listing defaults per block.
 */
export function resetApiDefaults(): void {
  vi.mocked(api.fetchPhaseGroups).mockResolvedValue({ phaseGroups: [SOLE_PHASE_GROUP] });
  vi.mocked(api.fetchOpenSets).mockResolvedValue({ sets: [] });
  vi.mocked(api.fetchBracket).mockResolvedValue(EMPTY_BRACKET);
  vi.mocked(api.fetchSetDetail).mockResolvedValue({ games: [] });
  vi.mocked(api.fetchCharacters).mockResolvedValue({ characters: [] });
  vi.mocked(api.fetchStages).mockResolvedValue({ stages: [] });
  vi.mocked(api.fetchStations).mockResolvedValue({ stations: [] });
  vi.mocked(api.fetchAccount).mockResolvedValue({ displayName: 'FireSlam23', startggSlug: null, topXBo5: null });
  vi.mocked(api.updateTopXBo5).mockResolvedValue({ topXBo5: null });
}

/**
 * The failure half of the mock surface. Every default above resolves, so
 * without something like this a test can only ever exercise the happy path —
 * which is why a batch of error-handling bugs shipped behind a green suite.
 *
 * `status` 401 is a dead session, 0 is "never reached the server" (timeout or
 * offline), anything else is a real HTTP error.
 */
export function apiFailure(status: number, message?: string): ApiError {
  return new ApiError(message ?? (status === 0 ? 'Could not reach the server.' : `Request failed (${status})`), status);
}

/**
 * Pumps fake timers far enough for pending promise chains to settle.
 *
 * Under vi.useFakeTimers() neither userEvent nor RTL's waitFor resolves —
 * both wait on real timers that no longer tick — so anything driving a poll
 * has to advance the clock itself. Each step flushes microtasks, which is
 * what lets a multi-hop chain (me -> phase groups -> first poll) complete.
 */
export async function flushTimers(steps = 15): Promise<void> {
  for (let i = 0; i < steps; i++) await vi.advanceTimersByTimeAsync(1);
}
