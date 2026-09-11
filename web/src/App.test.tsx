import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { fetchAccount, fetchBracket, fetchCharacters, fetchOpenSets, fetchPhaseGroups, fetchSetDetail, fetchStages, updateTopXBo5 } from './api';
import { apiFailure, flushTimers, resetApiDefaults, seedEvent, seedPool } from './test-helpers';
import type { BracketSet } from './types';

const fetchMeMock = vi.fn();
const logoutMock = vi.fn();

// Spreads the real module so ApiError stays a real class — App's 401 handling
// does an instanceof against it, which a stubbed-out module would break.
vi.mock('./api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./api')>()),
  fetchMe: (...args: unknown[]) => fetchMeMock(...args),
  logout: (...args: unknown[]) => logoutMock(...args),
  resolveEvent: vi.fn(),
  // A single phase group by default — every describe block below expects
  // to land straight on the main app, same as before pools existed, so
  // this auto-skips PoolPicker exactly the way a real single-pool event
  // does. Deliberately never reset in any afterEach (see the "completed /
  // not-ready sections" block) — nothing here needs a different value.
  // Inlined (not a top-level const) — vi.mock factories are hoisted above
  // other top-level code, so only vi.fn()/mock-prefixed bindings survive
  // being referenced in here; a plain object const doesn't.
  fetchPhaseGroups: vi.fn().mockResolvedValue({ phaseGroups: [{ id: 1, displayIdentifier: '1', phaseName: 'Bracket', bracketType: 'DOUBLE_ELIMINATION' }] }),
  fetchOpenSets: vi.fn().mockResolvedValue({ sets: [] }),
  fetchBracket: vi.fn().mockResolvedValue({ phaseGroupId: 1, phaseName: 'Bracket', displayIdentifier: '1', bracketType: 'DOUBLE_ELIMINATION', sets: [] }),
  fetchSetDetail: vi.fn().mockResolvedValue({ games: [] }),
  fetchCharacters: vi.fn().mockResolvedValue({ characters: [] }),
  fetchStages: vi.fn().mockResolvedValue({ stages: [] }),
  fetchAccount: vi.fn().mockResolvedValue({ displayName: 'FireSlam23', startggSlug: null, topXBo5: null }),
  updateTopXBo5: vi.fn().mockResolvedValue({ topXBo5: null }),
  startSet: vi.fn(),
}));

// Imported after the mock is registered so App picks up the mocked ./api.
const { default: App } = await import('./App');

/**
 * Waits for a set to appear on the bracket canvas and returns its box.
 *
 * The bracket arrives from its own poll, separate from the one that renders
 * the panel — so the search box existing does not mean the bracket does yet.
 */
function findBracketBox(container: HTMLElement, identifier: string): Promise<HTMLElement> {
  return waitFor(() => bracketBox(container, identifier));
}

/** Finds a set on the bracket canvas by its identifier badge. */
function bracketBox(container: HTMLElement, identifier: string): HTMLElement {
  const badge = Array.from(container.querySelectorAll('.bracket-badge')).find((b) => b.textContent === identifier);
  const box = badge?.closest('.bracket-box');
  if (!box) throw new Error(`no bracket box with identifier "${identifier}"`);
  return box as HTMLElement;
}

describe('App — sign-in gate', () => {
  beforeEach(() => {
    localStorage.clear();
    logoutMock.mockResolvedValue({ ok: true });
  });

  afterEach(() => {
    fetchMeMock.mockReset();
    logoutMock.mockReset();
  });

  it('shows a bare loading state before the /api/me check resolves', () => {
    fetchMeMock.mockReturnValue(new Promise(() => {})); // never resolves during this test
    render(<App />);

    expect(screen.getByRole('heading', { name: 'SmashSet' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /sign in with start\.gg/i })).not.toBeInTheDocument();
    expect(screen.queryByPlaceholderText(/tournament or event/i)).not.toBeInTheDocument();
  });

  it('shows Sign In once /api/me resolves to no user', async () => {
    fetchMeMock.mockResolvedValue({ user: null });
    render(<App />);

    expect(await screen.findByRole('button', { name: /sign in with start\.gg/i })).toBeInTheDocument();
  });

  it('skips Sign In and shows the event picker once /api/me resolves to a real user (no cached event)', async () => {
    fetchMeMock.mockResolvedValue({ user: { id: 1, displayName: 'FireSlam23' } });
    render(<App />);

    expect(await screen.findByPlaceholderText(/start\.gg\/my-tournament/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /sign in with start\.gg/i })).not.toBeInTheDocument();
  });

  it('treats a failed /api/me check the same as "not signed in", not stuck loading forever', async () => {
    fetchMeMock.mockRejectedValue(new Error('network error'));
    render(<App />);

    expect(await screen.findByRole('button', { name: /sign in with start\.gg/i })).toBeInTheDocument();
  });

  it('survives a keypress on a screen that has no set list', async () => {
    // The global keydown handler closes over `results`, which is computed
    // further down the component. On any screen that returns early it used to
    // still be in the temporal dead zone, so an arrow key threw a
    // ReferenceError out of a state updater and took the tree down with it.
    fetchMeMock.mockResolvedValue({ user: null });
    render(<App />);
    await screen.findByRole('button', { name: /sign in with start\.gg/i });

    fireEvent.keyDown(window, { key: 'ArrowDown' });
    fireEvent.keyDown(window, { key: '1' });

    expect(screen.getByRole('button', { name: /sign in with start\.gg/i })).toBeInTheDocument();
  });

  it('sign out calls the API and returns to the Sign In screen', async () => {
    fetchMeMock.mockResolvedValue({ user: { id: 1, displayName: 'FireSlam23' } });
    seedEvent();
    render(<App />);

    // Sign out lives inside the account modal now, alongside the other
    // account-management controls — open it first.
    await userEvent.click(await screen.findByRole('button', { name: 'Account' }));
    const signOutBtn = await screen.findByRole('button', { name: 'sign out' });
    await userEvent.click(signOutBtn);

    expect(logoutMock).toHaveBeenCalledOnce();
    expect(await screen.findByRole('button', { name: /sign in with start\.gg/i })).toBeInTheDocument();
  });
});

describe('App — help modal', () => {
  beforeEach(() => {
    localStorage.clear();
    seedEvent();
    fetchMeMock.mockResolvedValue({ user: { id: 1, displayName: 'FireSlam23' } });
  });

  afterEach(() => {
    fetchMeMock.mockReset();
  });

  it('opens the notation guide from the header and closes it again', async () => {
    render(<App />);

    const trigger = await screen.findByRole('button', { name: 'Notation guide' });
    await userEvent.click(trigger);

    expect(screen.getByRole('dialog', { name: 'SmashSet notation' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'The sweep' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Full reference' })).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('closes on Escape', async () => {
    render(<App />);

    await userEvent.click(await screen.findByRole('button', { name: 'Notation guide' }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();

    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});

describe('App — account modal', () => {
  const fetchAccountMock = vi.mocked(fetchAccount);
  const updateTopXBo5Mock = vi.mocked(updateTopXBo5);

  beforeEach(() => {
    localStorage.clear();
    seedEvent();
    fetchMeMock.mockResolvedValue({ user: { id: 1, displayName: 'FireSlam23' } });
    fetchAccountMock.mockResolvedValue({ displayName: 'FireSlam23', startggSlug: 'user/abc', topXBo5: null });
    updateTopXBo5Mock.mockResolvedValue({ topXBo5: 17 });
  });

  afterEach(() => {
    fetchMeMock.mockReset();
    fetchAccountMock.mockReset();
    updateTopXBo5Mock.mockReset();
  });

  it('shows the signed-in account\'s name, profile link, and preferences, then closes', async () => {
    render(<App />);

    await userEvent.click(await screen.findByRole('button', { name: 'Account' }));

    expect(await screen.findByRole('dialog', { name: 'Account' })).toBeInTheDocument();
    expect(screen.getByText('FireSlam23')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /start\.gg profile/i })).toHaveAttribute(
      'href',
      'https://www.start.gg/user/abc'
    );

    await userEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('saves a changed Top X preference through the API', async () => {
    render(<App />);
    await userEvent.click(await screen.findByRole('button', { name: 'Account' }));

    const input = await screen.findByLabelText(/top/i);
    await userEvent.type(input, '17');

    expect(await screen.findByDisplayValue('17')).toBeInTheDocument();
    expect(updateTopXBo5Mock).toHaveBeenLastCalledWith(17);
  });
});

describe('App — completed and not-ready sets on the bracket', () => {
  const fetchBracketMock = vi.mocked(fetchBracket);
  const fetchAccountMock = vi.mocked(fetchAccount);
  const fetchSetDetailMock = vi.mocked(fetchSetDetail);
  const fetchCharactersMock = vi.mocked(fetchCharacters);
  const fetchStagesMock = vi.mocked(fetchStages);

  beforeEach(() => {
    localStorage.clear();
    seedEvent();
    fetchMeMock.mockResolvedValue({ user: { id: 1, displayName: 'FireSlam23' } });
    resetApiDefaults();
  });

  afterEach(() => {
    fetchMeMock.mockReset();
    fetchBracketMock.mockReset();
    fetchAccountMock.mockReset();
    fetchSetDetailMock.mockReset();
    fetchCharactersMock.mockReset();
    fetchStagesMock.mockReset();
  });

  it('shows a completed set with the winner bolded and the score, and a not-ready set with a resolved placeholder for its empty slot', async () => {
    fetchBracketMock.mockResolvedValue({
      phaseGroupId: 1,
      phaseName: 'Bracket',
      displayIdentifier: '1',
      bracketType: 'DOUBLE_ELIMINATION',
      sets: [
        {
          id: 1,
          identifier: 'A',
          round: 1,
          fullRoundText: 'Winners Round 1',
          state: 3,
          winnerId: 101,
          lPlacement: 9,
          completedAt: null,
          winnerAdvancesToPhase: null,
          loserAdvancesToPhase: null,
          slots: [
            { entrant: { id: 101, name: 'Winner Player' }, score: 2, prereqSetId: null, prereqPlacement: null, progressionOrigin: null },
            { entrant: { id: 102, name: 'Loser Player' }, score: 0, prereqSetId: null, prereqPlacement: null, progressionOrigin: null },
          ],
        },
        {
          id: 2,
          identifier: 'C',
          round: 2,
          fullRoundText: 'Winners Quarter-Final',
          state: 1,
          winnerId: null,
          lPlacement: null,
          completedAt: null,
          winnerAdvancesToPhase: null,
          loserAdvancesToPhase: null,
          slots: [
            { entrant: { id: 101, name: 'Winner Player' }, score: null, prereqSetId: '1', prereqPlacement: 1, progressionOrigin: null },
            // prereqSetId "999" doesn't match any set in this fixture —
            // exercises the "source not found" -> "TBD" fallback.
            { entrant: null, score: null, prereqSetId: '999', prereqPlacement: 1, progressionOrigin: null },
          ],
        },
      ],
    });

    const { container } = render(<App />);
    await screen.findByPlaceholderText(/winner's name/i);

    // Completed: both names, the winner's score marked as won.
    const completed = await findBracketBox(container, 'A');
    expect(completed.textContent).toContain('Winner Player');
    expect(completed.textContent).toContain('Loser Player');
    expect(completed.querySelector('.bracket-score.won')?.textContent).toBe('2');
    expect(completed.querySelector('.bracket-score.lost')?.textContent).toBe('0');

    // Not ready: the empty slot resolves to TBD, since its prereq set (999)
    // isn't in the response.
    const notReady = await findBracketBox(container, 'C');
    expect(notReady.textContent).toContain('Winner Player');
    expect(notReady.textContent).toContain('TBD');
  });

  it('marks the set highlighted in the list on the bracket too', async () => {
    // The point of the unified view: the list and the bracket are two views of
    // one selection, so highlighting in one marks it in the other.
    vi.mocked(fetchOpenSets).mockResolvedValue({
      sets: [
        {
          id: 1,
          isPreview: false,
          isStarted: false,
          fullRoundText: 'Winners Round 1',
          identifier: 'A',
          lPlacement: null,
          entrants: [
            { id: 101, name: 'Winner Player' },
            { id: 102, name: 'Loser Player' },
          ],
        },
      ],
    });
    fetchBracketMock.mockResolvedValue({
      phaseGroupId: 1,
      phaseName: 'Bracket',
      displayIdentifier: '1',
      bracketType: 'DOUBLE_ELIMINATION',
      sets: [
        {
          id: 1,
          identifier: 'A',
          round: 1,
          fullRoundText: 'Winners Round 1',
          state: 1,
          winnerId: null,
          lPlacement: null,
          completedAt: null,
          winnerAdvancesToPhase: null,
          loserAdvancesToPhase: null,
          slots: [
            { entrant: { id: 101, name: 'Winner Player' }, score: null, prereqSetId: null, prereqPlacement: null, progressionOrigin: null },
            { entrant: { id: 102, name: 'Loser Player' }, score: null, prereqSetId: null, prereqPlacement: null, progressionOrigin: null },
          ],
        },
        {
          id: 2,
          identifier: 'B',
          round: 1,
          fullRoundText: 'Winners Round 1',
          state: 1,
          winnerId: null,
          lPlacement: null,
          completedAt: null,
          winnerAdvancesToPhase: null,
          loserAdvancesToPhase: null,
          slots: [
            { entrant: { id: 103, name: 'Other One' }, score: null, prereqSetId: null, prereqPlacement: null, progressionOrigin: null },
            { entrant: { id: 104, name: 'Other Two' }, score: null, prereqSetId: null, prereqPlacement: null, progressionOrigin: null },
          ],
        },
      ],
    });

    const { container } = render(<App />);
    await screen.findByPlaceholderText(/winner's name/i);

    // A single ready-to-start set is unambiguous, so it highlights without
    // anyone pressing anything — and the bracket says which one it is.
    await waitFor(() => expect(bracketBox(container, 'A').className).toContain('focused'));
    expect(bracketBox(container, 'B').className).not.toContain('focused');
  });

  it('says so plainly when the bracket has no sets at all', async () => {
    fetchBracketMock.mockResolvedValue({ phaseGroupId: 1, phaseName: 'Bracket', displayIdentifier: '1', bracketType: 'DOUBLE_ELIMINATION', sets: [] });
    const { container } = render(<App />);

    await screen.findByPlaceholderText(/winner's name/i);
    expect(container.querySelectorAll('.bracket-box')).toHaveLength(0);
    // The panel collapses to its ready-to-start summary rather than vanishing.
    expect(container.querySelector('.set-panel-summary')?.textContent).toMatch(/ready to start/i);
    expect(container.querySelector('.set-panel')?.className).toContain('collapsed');
  });

  it('clicking a completed set opens it for correction, defaulting to its actual winner and showing what was already reported', async () => {
    fetchBracketMock.mockResolvedValue({
      phaseGroupId: 1,
      phaseName: 'Bracket',
      displayIdentifier: '1',
      bracketType: 'DOUBLE_ELIMINATION',
      sets: [
        {
          id: 1,
          identifier: 'A',
          round: 1,
          fullRoundText: 'Winners Round 1',
          state: 3,
          winnerId: 101,
          lPlacement: 9,
          completedAt: null,
          winnerAdvancesToPhase: null,
          loserAdvancesToPhase: null,
          slots: [
            { entrant: { id: 101, name: 'Winner Player' }, score: 2, prereqSetId: null, prereqPlacement: null, progressionOrigin: null },
            { entrant: { id: 102, name: 'Loser Player' }, score: 0, prereqSetId: null, prereqPlacement: null, progressionOrigin: null },
          ],
        },
      ],
    });

    const { container } = render(<App />);
    await screen.findByPlaceholderText(/winner's name/i);

    await userEvent.click(await findBracketBox(container, 'A'));

    // Lands in the same ReportPanel flow the list uses — round label present…
    expect(await screen.findByText('Winners Round 1 · A')).toBeInTheDocument();
    // …with the actual recorded winner presumed (not an arbitrary side)…
    expect(container.querySelector('.winner-side .side-name')?.textContent).toBe('Winner Player');
    // …and the prior result visible so a TO can see what they're overwriting.
    const banner = container.querySelector('.prior-result');
    expect(banner).not.toBeNull();
    expect(banner!.textContent).toContain('Winner Player');
    expect(banner!.textContent).toContain('Loser Player');
    expect(banner!.textContent).toContain('2–0');
  });

  it('pre-fills the score and per-game characters from the actual game records, not a blank form', async () => {
    fetchBracketMock.mockResolvedValue({
      phaseGroupId: 1,
      phaseName: 'Bracket',
      displayIdentifier: '1',
      bracketType: 'DOUBLE_ELIMINATION',
      sets: [
        {
          id: 1,
          identifier: 'A',
          round: 1,
          fullRoundText: 'Winners Round 1',
          state: 3,
          winnerId: 101,
          lPlacement: 9,
          completedAt: null,
          winnerAdvancesToPhase: null,
          loserAdvancesToPhase: null,
          slots: [
            { entrant: { id: 101, name: 'Winner Player' }, score: 2, prereqSetId: null, prereqPlacement: null, progressionOrigin: null },
            { entrant: { id: 102, name: 'Loser Player' }, score: 0, prereqSetId: null, prereqPlacement: null, progressionOrigin: null },
          ],
        },
      ],
    });
    fetchCharactersMock.mockResolvedValue({ characters: [{ id: 1273, name: 'Bowser' }, { id: 1274, name: 'Captain Falcon' }] });
    fetchStagesMock.mockResolvedValue({ stages: [] });
    fetchSetDetailMock.mockResolvedValue({
      games: [
        {
          orderNum: 1,
          winnerEntrantId: 101,
          stageId: null,
          characterIdByEntrantId: { 101: 1273, 102: 1274 },
        },
        { orderNum: 2, winnerEntrantId: 101, stageId: null, characterIdByEntrantId: {} },
      ],
    });

    const { container } = render(<App />);
    await screen.findByPlaceholderText(/winner's name/i);

    await userEvent.click(await findBracketBox(container, 'A'));

    expect(fetchSetDetailMock).toHaveBeenCalledWith(1);
    // The score entry reflects the real 2-game history (both won by the
    // recorded winner), not an empty score waiting to be typed from scratch.
    expect(await screen.findByText('Winner Player 2–0 Loser Player')).toBeInTheDocument();
    // Derived from that same history: a 2-0 set is a Bo3, so Bo3 is already
    // selected rather than whatever guessRequiredWins would've picked blind.
    expect(container.querySelector('.bo-toggle button.selected')?.textContent).toBe('Bo3');
    // Game 1's recorded character pick is already filled in.
    expect(screen.getByText('Bowser')).toBeInTheDocument();
  });
});

describe('App — multiple pools', () => {
  const fetchPhaseGroupsMock = vi.mocked(fetchPhaseGroups);
  const fetchBracketMock = vi.mocked(fetchBracket);

  beforeEach(() => {
    localStorage.clear();
    seedEvent();
    fetchMeMock.mockResolvedValue({ user: { id: 1, displayName: 'FireSlam23' } });
    resetApiDefaults();
    fetchPhaseGroupsMock.mockResolvedValue({
      phaseGroups: [
        { id: 10, displayIdentifier: 'A', phaseName: 'Pools', bracketType: 'ROUND_ROBIN' },
        { id: 20, displayIdentifier: 'B', phaseName: 'Pools', bracketType: 'ROUND_ROBIN' },
      ],
    });
    fetchBracketMock.mockResolvedValue({ phaseGroupId: 10, phaseName: 'Pools', displayIdentifier: 'A', bracketType: 'ROUND_ROBIN', sets: [] });
  });

  afterEach(() => {
    fetchMeMock.mockReset();
    fetchPhaseGroupsMock.mockReset();
    fetchBracketMock.mockReset();
  });

  it('shows a pool picker for an event with more than one pool, and proceeds to the main app once one is picked', async () => {
    render(<App />);

    expect(await screen.findByText(/has multiple pools\/brackets/i)).toBeInTheDocument();
    // Nothing is fetched for any pool until one is actually chosen.
    expect(fetchBracketMock).not.toHaveBeenCalled();

    await userEvent.click(screen.getByText('Pools A'));

    expect(await screen.findByPlaceholderText(/winner's name/i)).toBeInTheDocument();
    expect(fetchBracketMock).toHaveBeenCalledWith(10);
    // Only surfaced at all once there's more than one to switch between.
    expect(screen.getByRole('button', { name: 'switch pool' })).toBeInTheDocument();
  });

  it('lets a TO switch pools later via the header control, and cancels back to the current pool (not event selection) on Back', async () => {
    render(<App />);
    await userEvent.click(await screen.findByText('Pools A'));
    await screen.findByPlaceholderText(/winner's name/i);

    await userEvent.click(screen.getByRole('button', { name: 'switch pool' }));
    expect(await screen.findByText(/has multiple pools\/brackets/i)).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'back' }));
    // Cancelling a re-opened picker returns straight to the app, still on
    // the previously chosen pool — no re-fetch of the phase group list, and
    // the event itself was never touched.
    expect(await screen.findByPlaceholderText(/winner's name/i)).toBeInTheDocument();
    expect(fetchPhaseGroupsMock).toHaveBeenCalledOnce();
  });

  it("drops a slow response from the pool the TO already left", async () => {
    // The dangerous version of this bug: the abandoned pool's sets stay on
    // screen under the new pool's name, and a TO reports one of them.
    const fetchOpenSetsMock = vi.mocked(fetchOpenSets);
    let releasePoolA: (value: { sets: unknown[] }) => void = () => {};
    const poolAHangs = new Promise<{ sets: unknown[] }>((resolve) => {
      releasePoolA = resolve;
    });
    fetchOpenSetsMock.mockImplementation(((id: number) =>
      id === 10 ? poolAHangs : Promise.resolve({ sets: [] })) as never);

    render(<App />);
    await userEvent.click(await screen.findByText('Pools A'));

    // Switch to B while A's request is still in flight.
    await userEvent.click(await screen.findByRole('button', { name: 'switch pool' }));
    await userEvent.click(await screen.findByText('Pools B'));
    await screen.findByPlaceholderText(/winner's name/i);

    // A finally answers, with a set that belongs to the pool we left.
    releasePoolA({
      sets: [
        {
          id: 999,
          isPreview: false,
          isStarted: false,
          fullRoundText: 'Pool A Round 1',
          identifier: 'A',
          lPlacement: null,
          completedAt: null,
          entrants: [
            { id: 1, name: 'Left Behind' },
            { id: 2, name: 'Should Not Show' },
          ],
        },
      ],
    });

    await waitFor(() => expect(screen.queryByText(/Left Behind/)).not.toBeInTheDocument());
    expect(screen.queryByText(/Should Not Show/)).not.toBeInTheDocument();
  });

  it('switching pools re-fetches bracket data scoped to the newly picked pool', async () => {
    render(<App />);
    await userEvent.click(await screen.findByText('Pools A'));
    await screen.findByPlaceholderText(/winner's name/i);

    fetchBracketMock.mockResolvedValue({ phaseGroupId: 20, phaseName: 'Pools', displayIdentifier: 'B', bracketType: 'ROUND_ROBIN', sets: [] });
    await userEvent.click(screen.getByRole('button', { name: 'switch pool' }));
    await userEvent.click(await screen.findByText('Pools B'));

    await screen.findByPlaceholderText(/winner's name/i);
    expect(fetchBracketMock).toHaveBeenLastCalledWith(20);
  });
});

describe('App — session teardown', () => {
  const fetchOpenSetsMock = vi.mocked(fetchOpenSets);
  const fetchBracketMock = vi.mocked(fetchBracket);

  beforeEach(() => {
    localStorage.clear();
    seedEvent();
    seedPool();
    fetchMeMock.mockResolvedValue({ user: { id: 1, displayName: 'FireSlam23' } });
    logoutMock.mockResolvedValue({ ok: true });
    resetApiDefaults();
  });

  afterEach(() => {
    vi.useRealTimers();
    fetchMeMock.mockReset();
    logoutMock.mockReset();
    fetchOpenSetsMock.mockReset();
    fetchBracketMock.mockReset();
  });

  it('stops polling start.gg once the user signs out', async () => {
    // Everything here is driven by advancing fake timers rather than
    // userEvent/waitFor: both of those wait on real timers, which are faked
    // for this test, so they never resolve.
    vi.useFakeTimers();
    render(<App />);
    await flushTimers();

    // Establishes that polling is genuinely running first, so the flat call
    // count after signing out means it stopped rather than never started.
    const before = fetchOpenSetsMock.mock.calls.length;
    expect(before).toBeGreaterThan(0);
    await vi.advanceTimersByTimeAsync(12000);
    expect(fetchOpenSetsMock.mock.calls.length).toBeGreaterThan(before);

    fireEvent.click(screen.getByRole('button', { name: 'Account' }));
    await flushTimers();
    fireEvent.click(screen.getByRole('button', { name: 'sign out' }));
    await flushTimers();
    expect(screen.getByRole('button', { name: /sign in with start\.gg/i })).toBeInTheDocument();

    const openCalls = fetchOpenSetsMock.mock.calls.length;
    const bracketCalls = fetchBracketMock.mock.calls.length;
    await vi.advanceTimersByTimeAsync(20000);

    expect(fetchOpenSetsMock).toHaveBeenCalledTimes(openCalls);
    expect(fetchBracketMock).toHaveBeenCalledTimes(bracketCalls);
  });

  it('forgets the event and pool on sign-out, so the next person does not land in them', async () => {
    const user = userEvent.setup();
    render(<App />);

    await screen.findByPlaceholderText(/winner's name/i);
    await user.click(screen.getByRole('button', { name: 'Account' }));
    await user.click(await screen.findByRole('button', { name: /sign out/i }));
    await screen.findByRole('button', { name: /sign in with start\.gg/i });

    expect(localStorage.getItem('smashset.event')).toBeNull();
    expect(localStorage.getItem('smashset.phaseGroup')).toBeNull();
  });

  it('returns to sign-in when a poll comes back 401 instead of retrying it forever', async () => {
    fetchOpenSetsMock.mockRejectedValue(apiFailure(401, 'Not signed in'));
    render(<App />);

    expect(await screen.findByRole('button', { name: /sign in with start\.gg/i })).toBeInTheDocument();
  });
});

describe('App — unreachable server', () => {
  const fetchOpenSetsMock = vi.mocked(fetchOpenSets);

  beforeEach(() => {
    localStorage.clear();
    seedEvent();
    seedPool();
    fetchMeMock.mockResolvedValue({ user: { id: 1, displayName: 'FireSlam23' } });
    resetApiDefaults();
  });

  afterEach(() => {
    vi.useRealTimers();
    fetchMeMock.mockReset();
    fetchOpenSetsMock.mockReset();
  });

  it('shows a timeout as an error without signing the TO out mid-tournament', async () => {
    fetchOpenSetsMock.mockRejectedValue(apiFailure(0, 'Timed out reaching the server. Check your connection.'));
    render(<App />);

    expect(await screen.findByText(/timed out reaching the server/i)).toBeInTheDocument();
    // Only a 401 ends the session. A flaky connection must not throw a TO
    // back to the sign-in screen in the middle of running a bracket.
    expect(screen.queryByRole('button', { name: /sign in with start\.gg/i })).not.toBeInTheDocument();
    expect(localStorage.getItem('smashset.event')).not.toBeNull();
  });

  it('clears the error once the connection recovers', async () => {
    vi.useFakeTimers();
    fetchOpenSetsMock.mockRejectedValueOnce(apiFailure(0));
    render(<App />);
    await flushTimers();
    expect(screen.getByText(/could not reach the server/i)).toBeInTheDocument();

    // The poll 4s later succeeds — a transient failure must not leave a
    // permanent error banner sitting over a working list.
    await vi.advanceTimersByTimeAsync(4000);
    await flushTimers();

    expect(screen.queryByText(/could not reach the server/i)).not.toBeInTheDocument();
  });
});

describe('App — Tab searches completed sets', () => {
  const fetchBracketMock = vi.mocked(fetchBracket);

  // Names shaped like the real ones: two players share the "JL" prefix, which
  // is what makes the single-player rule non-trivial.
  function completed(id: number, winner: string, loser: string, completedAt: number): BracketSet {
    return {
      id,
      identifier: String.fromCharCode(64 + id),
      round: 1,
      fullRoundText: 'Winners Round 1',
      state: 3,
      winnerId: id * 10,
      lPlacement: null,
      completedAt,
      winnerAdvancesToPhase: null,
      loserAdvancesToPhase: null,
      slots: [
        { entrant: { id: id * 10, name: winner }, score: 2, prereqSetId: null, prereqPlacement: null, progressionOrigin: null },
        { entrant: { id: id * 10 + 1, name: loser }, score: 0, prereqSetId: null, prereqPlacement: null, progressionOrigin: null },
      ],
    };
  }

  beforeEach(() => {
    localStorage.clear();
    seedEvent();
    fetchMeMock.mockResolvedValue({ user: { id: 1, displayName: 'FireSlam23' } });
    resetApiDefaults();
    fetchBracketMock.mockResolvedValue({
      phaseGroupId: 1,
      phaseName: 'Bracket',
      displayIdentifier: '1',
      bracketType: 'DOUBLE_ELIMINATION',
      sets: [
        completed(3, 'JL | Zoruya', 'hwon', 100), // oldest
        completed(1, 'JL | Zoruya', 'goodfellow', 300), // newest
        completed(2, 'JL | FireSlam23', 'Mr. Pi', 200),
      ],
    });
  });

  afterEach(() => {
    fetchMeMock.mockReset();
    fetchBracketMock.mockReset();
  });

  function rowNames(): (string | undefined)[] {
    return [...document.querySelectorAll('.set-panel-list li')].map((li) => li.querySelector('.entrant-names')?.textContent ?? undefined);
  }

  it('lists completed sets newest first, regardless of bracket order', async () => {
    render(<App />);
    await screen.findByPlaceholderText(/winner's name/i);

    fireEvent.keyDown(window, { key: 'Tab' });

    expect(await screen.findByPlaceholderText(/player to correct/i)).toBeInTheDocument();
    // Deliberately not the order they arrived in, nor bracket order.
    await waitFor(() =>
      expect(rowNames()).toEqual([
        'JL | Zoruya def. goodfellow 2–0',
        'JL | FireSlam23 def. Mr. Pi 2–0',
        'JL | Zoruya def. hwon 2–0',
      ])
    );
  });

  it("highlights a player's latest set when the query names exactly one of them", async () => {
    const { container } = render(<App />);
    await screen.findByPlaceholderText(/winner's name/i);

    fireEvent.keyDown(window, { key: 'Tab' });
    const search = await screen.findByPlaceholderText(/player to correct/i);
    fireEvent.change(search, { target: { value: 'Zoruya' } });

    // Two of their sets match, but only one player does — so the most recent
    // is picked without an arrow key, and the bracket says which.
    await waitFor(() => expect(rowNames()).toHaveLength(2));
    expect(document.querySelector('.set-panel-list li.active')?.querySelector('.entrant-names')?.textContent).toBe(
      'JL | Zoruya def. goodfellow 2–0'
    );
    expect((await findBracketBox(container, 'A')).className).toContain('focused');
  });

  it('stays ambiguous when the query matches two players', async () => {
    render(<App />);
    await screen.findByPlaceholderText(/winner's name/i);

    fireEvent.keyDown(window, { key: 'Tab' });
    const search = await screen.findByPlaceholderText(/player to correct/i);
    fireEvent.change(search, { target: { value: 'JL' } });

    await waitFor(() => expect(rowNames()).toHaveLength(3));
    // "JL" is both JL | Zoruya and JL | FireSlam23 — picking one for the TO
    // would be guessing, so nothing is highlighted until they choose.
    expect(document.querySelector('.set-panel-list li.active')).toBeNull();
  });

  it('Escape leaves completed mode without throwing away the query', async () => {
    render(<App />);
    await screen.findByPlaceholderText(/winner's name/i);

    fireEvent.keyDown(window, { key: 'Tab' });
    const search = await screen.findByPlaceholderText(/player to correct/i);
    fireEvent.change(search, { target: { value: 'Zoruya' } });

    fireEvent.keyDown(window, { key: 'Escape' });

    // Back to searching open sets, with what they typed still there — Tab is
    // never a dead end.
    const back = await screen.findByPlaceholderText(/winner's name/i);
    expect((back as HTMLInputElement).value).toBe('Zoruya');
  });

  it('opens a completed set for correction when picked', async () => {
    render(<App />);
    await screen.findByPlaceholderText(/winner's name/i);

    fireEvent.keyDown(window, { key: 'Tab' });
    const search = await screen.findByPlaceholderText(/player to correct/i);
    fireEvent.change(search, { target: { value: 'Zoruya' } });
    await waitFor(() => expect(rowNames()).toHaveLength(2));

    fireEvent.keyDown(window, { key: 'Enter' });

    // The correction flow, pre-filled — same path as clicking it on the bracket.
    expect(await screen.findByText(/Already reported:/)).toBeInTheDocument();
    expect(vi.mocked(fetchSetDetail)).toHaveBeenCalledWith(1);
  });
});
