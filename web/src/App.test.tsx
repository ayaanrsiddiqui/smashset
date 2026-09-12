import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StrictMode } from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { fetchAccount, fetchBracket, fetchCharacters, fetchOpenSets, fetchPhaseGroups, fetchPoolPlayers, fetchSetDetail, fetchStages, reportSet, updatePlayerMain, updateTopXBo5 } from './api';
import { apiFailure, flushTimers, resetApiDefaults, seedEvent, seedPool, TEST_EVENT } from './test-helpers';
import type { BracketSet } from './types';
import { openedEventSource, resetEventSources } from './test-eventsource';
import { enqueue, remove as dropFromOutbox, resetOutbox } from './outbox';

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
  fetchPhaseGroups: vi.fn().mockResolvedValue({ phaseGroups: [{ id: 1, displayIdentifier: '1', phaseName: 'Bracket', bracketType: 'DOUBLE_ELIMINATION' }], canReport: true }),
  fetchOpenSets: vi.fn().mockResolvedValue({ sets: [] }),
  fetchBracket: vi.fn().mockResolvedValue({ phaseGroupId: 1, phaseName: 'Bracket', displayIdentifier: '1', bracketType: 'DOUBLE_ELIMINATION', sets: [] }),
  fetchSetDetail: vi.fn().mockResolvedValue({ games: [] }),
  fetchCharacters: vi.fn().mockResolvedValue({ characters: [] }),
  fetchStages: vi.fn().mockResolvedValue({ stages: [] }),
  fetchAccount: vi.fn().mockResolvedValue({ displayName: 'FireSlam23', startggSlug: null, topXBo5: null }),
  updateTopXBo5: vi.fn().mockResolvedValue({ topXBo5: null }),
  startSet: vi.fn(),
  reportSet: vi.fn().mockResolvedValue({ result: {} }),
  updatePlayerMain: vi.fn().mockResolvedValue({ characterId: null }),
  fetchPoolPlayers: vi.fn().mockResolvedValue({ players: [], videogameId: 1386 }),
  poolEventsUrl: (id: number) => `/api/sets/phase-group/${id}/events`,
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

    expect(await screen.findByLabelText(/tournament or event/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /sign in with start\.gg/i })).not.toBeInTheDocument();
  });

  it('does not claim the TO is signed out when the check simply failed', async () => {
    // This used to fall through to Sign In, to avoid being stuck on a blank
    // splash forever. But /api/me answers 200 with a null user when nobody is
    // signed in (server/src/routes/me.ts), so a rejection here says nothing
    // about the session — and a TO reloading on venue wifi was told they were
    // signed out when they were not. The stuck-forever worry is answered by
    // saying what happened and retrying, not by guessing.
    fetchMeMock.mockRejectedValue(new Error('network error'));
    render(<App />);

    expect(await screen.findByText(/network error/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /sign in with start\.gg/i })).not.toBeInTheDocument();
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
    await userEvent.click(await screen.findByRole('button', { name: /account/i }));
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

    await userEvent.click(await screen.findByRole('button', { name: /account/i }));

    const dialog = await screen.findByRole('dialog', { name: 'Account' });
    // Scoped to the dialog: the header chip shows the same name now.
    expect(within(dialog).getByText('FireSlam23')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /start\.gg profile/i })).toHaveAttribute(
      'href',
      'https://www.start.gg/user/abc'
    );

    await userEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('saves a changed Top X preference through the API', async () => {
    render(<App />);
    await userEvent.click(await screen.findByRole('button', { name: /account/i }));

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
            { entrant: { id: 101, name: 'Winner Player' }, score: 2, characterId: null, prereqSetId: null, prereqPlacement: null, progressionOrigin: null, seedNum: null },
            { entrant: { id: 102, name: 'Loser Player' }, score: 0, characterId: null, prereqSetId: null, prereqPlacement: null, progressionOrigin: null, seedNum: null },
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
            { entrant: { id: 101, name: 'Winner Player' }, score: null, characterId: null, prereqSetId: '1', prereqPlacement: 1, progressionOrigin: null, seedNum: null },
            // prereqSetId "999" doesn't match any set in this fixture —
            // exercises the "source not found" -> "TBD" fallback.
            { entrant: null, score: null, characterId: null, prereqSetId: '999', prereqPlacement: 1, progressionOrigin: null, seedNum: null },
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
            { entrant: { id: 101, name: 'Winner Player' }, score: null, characterId: null, prereqSetId: null, prereqPlacement: null, progressionOrigin: null, seedNum: null },
            { entrant: { id: 102, name: 'Loser Player' }, score: null, characterId: null, prereqSetId: null, prereqPlacement: null, progressionOrigin: null, seedNum: null },
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
            { entrant: { id: 103, name: 'Other One' }, score: null, characterId: null, prereqSetId: null, prereqPlacement: null, progressionOrigin: null, seedNum: null },
            { entrant: { id: 104, name: 'Other Two' }, score: null, characterId: null, prereqSetId: null, prereqPlacement: null, progressionOrigin: null, seedNum: null },
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

  it("shows each player's character on a finished set, and nothing where start.gg has none", async () => {
    fetchCharactersMock.mockResolvedValue({
      characters: [
        { id: 1500, name: 'Fox', imageUrl: 'https://example.test/fox.png' },
        { id: 1501, name: 'Falco' },
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
          state: 3,
          winnerId: 101,
          lPlacement: null,
          completedAt: 100,
          winnerAdvancesToPhase: null,
          loserAdvancesToPhase: null,
          slots: [
            { entrant: { id: 101, name: 'Winner Player' }, score: 2, characterId: 1500, prereqSetId: null, prereqPlacement: null, progressionOrigin: null, seedNum: null },
            // Falco has no image, and this player has no character at all —
            // both are ordinary, since many TOs never report picks.
            { entrant: { id: 102, name: 'Loser Player' }, score: 0, characterId: null, prereqSetId: null, prereqPlacement: null, progressionOrigin: null, seedNum: null },
          ],
        },
      ],
    });
    const { container } = render(<App />);
    await findBracketBox(container, 'A');

    await waitFor(() => expect(container.querySelectorAll('img.bracket-character')).toHaveLength(1));
    expect(container.querySelector('img.bracket-character')).toHaveAttribute('src', 'https://example.test/fox.png');
    // Decoration beside a name that is already read out.
    expect(container.querySelector('img.bracket-character')).toHaveAttribute('alt', '');
  });

  it('shows no character when the id has no image to show', async () => {
    // A character start.gg knows but has no art for would otherwise render a
    // broken image beside the tag.
    fetchCharactersMock.mockResolvedValue({ characters: [{ id: 1501, name: 'Falco' }] });
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
          lPlacement: null,
          completedAt: 100,
          winnerAdvancesToPhase: null,
          loserAdvancesToPhase: null,
          slots: [
            { entrant: { id: 101, name: 'Winner Player' }, score: 2, characterId: 1501, prereqSetId: null, prereqPlacement: null, progressionOrigin: null, seedNum: null },
            { entrant: { id: 102, name: 'Loser Player' }, score: 0, characterId: 1501, prereqSetId: null, prereqPlacement: null, progressionOrigin: null, seedNum: null },
          ],
        },
      ],
    });
    const { container } = render(<App />);
    await findBracketBox(container, 'A');

    expect(container.querySelectorAll('img.bracket-character')).toHaveLength(0);
  });

  it('says so plainly when the bracket has no sets at all', async () => {
    fetchBracketMock.mockResolvedValue({ phaseGroupId: 1, phaseName: 'Bracket', displayIdentifier: '1', bracketType: 'DOUBLE_ELIMINATION', sets: [] });
    const { container } = render(<App />);

    await screen.findByPlaceholderText(/winner's name/i);
    expect(container.querySelectorAll('.bracket-box')).toHaveLength(0);
    // The panel collapses to its summary rather than vanishing.
    expect(container.querySelector('.set-panel-summary')?.textContent).toMatch(/to report/i);
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
            { entrant: { id: 101, name: 'Winner Player' }, score: 2, characterId: null, prereqSetId: null, prereqPlacement: null, progressionOrigin: null, seedNum: null },
            { entrant: { id: 102, name: 'Loser Player' }, score: 0, characterId: null, prereqSetId: null, prereqPlacement: null, progressionOrigin: null, seedNum: null },
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
            { entrant: { id: 101, name: 'Winner Player' }, score: 2, characterId: null, prereqSetId: null, prereqPlacement: null, progressionOrigin: null, seedNum: null },
            { entrant: { id: 102, name: 'Loser Player' }, score: 0, characterId: null, prereqSetId: null, prereqPlacement: null, progressionOrigin: null, seedNum: null },
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
    // Read off the element rather than matched as one text node: the score is
    // rendered in parts now so each side can be coloured separately.
    await waitFor(() =>
      expect(document.querySelector('.score-line')?.textContent?.replace(/\s+/g, ' ').trim()).toBe('2–0')
    );
    // Derived from that same history: a 2-0 set is a Bo3, so Bo3 is already
    // selected rather than whatever guessRequiredWins would've picked blind.
    // The button shows just the number now, with "BO" standing beside the
    // column, so the full format name lives on the label instead.
    expect(container.querySelector('.bo-toggle button.selected')?.getAttribute('aria-label')).toBe('Bo3');
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
        { id: 10, displayIdentifier: 'A', phaseId: 1, phaseName: 'Pools', phaseNumSeeds: 16, bracketType: 'ROUND_ROBIN' },
        { id: 20, displayIdentifier: 'B', phaseId: 1, phaseName: 'Pools', phaseNumSeeds: 16, bracketType: 'ROUND_ROBIN' },
      ],
      canReport: true,
    });
    fetchBracketMock.mockResolvedValue({ phaseGroupId: 10, phaseName: 'Pools', displayIdentifier: 'A', bracketType: 'ROUND_ROBIN', sets: [] });
  });

  afterEach(() => {
    fetchMeMock.mockReset();
    fetchPhaseGroupsMock.mockReset();
    fetchBracketMock.mockReset();
  });

  /** Pools live under their phase now, so picking one means opening it first. */
  async function pickPool(identifier: string) {
    await userEvent.click(await screen.findByRole('button', { name: /Pools/ }));
    await userEvent.click(screen.getByText(identifier));
  }

  it('shows a pool picker for an event with more than one pool, and proceeds to the main app once one is picked', async () => {
    render(<App />);

    expect(await screen.findByText(/has multiple pools\/brackets/i)).toBeInTheDocument();
    // Nothing is fetched for any pool until one is actually chosen.
    expect(fetchBracketMock).not.toHaveBeenCalled();

    await pickPool('A');

    expect(await screen.findByPlaceholderText(/winner's name/i)).toBeInTheDocument();
    expect(fetchBracketMock).toHaveBeenCalledWith(10);
    // Only surfaced at all once there's more than one to switch between.
    expect(screen.getByRole('button', { name: 'switch pool' })).toBeInTheDocument();
  });

  it('lets a TO switch pools later via the header control, and cancels back to the current pool (not event selection) on Back', async () => {
    render(<App />);
    await pickPool('A');
    await screen.findByPlaceholderText(/winner's name/i);

    await userEvent.click(screen.getByRole('button', { name: 'switch pool' }));
    expect(await screen.findByText(/has multiple pools\/brackets/i)).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /back/i }));
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
    await pickPool('A');

    // Switch to B while A's request is still in flight.
    await userEvent.click(await screen.findByRole('button', { name: 'switch pool' }));
    await pickPool('B');
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
    await pickPool('A');
    await screen.findByPlaceholderText(/winner's name/i);

    fetchBracketMock.mockResolvedValue({ phaseGroupId: 20, phaseName: 'Pools', displayIdentifier: 'B', bracketType: 'ROUND_ROBIN', sets: [] });
    await userEvent.click(screen.getByRole('button', { name: 'switch pool' }));
    await pickPool('B');

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

    fireEvent.click(screen.getByRole('button', { name: /account/i }));
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
    await user.click(screen.getByRole('button', { name: /account/i }));
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

describe('App — searching completed sets', () => {
  const fetchBracketMock = vi.mocked(fetchBracket);

  // One entrant id per player, the way start.gg assigns them: the same player
  // in two sets is the same entrant. The fixture used to mint a fresh id per
  // set, which made one player look like several and hid a real bug.
  const entrantIds = new Map<string, number>();
  function entrantId(name: string): number {
    if (!entrantIds.has(name)) entrantIds.set(name, entrantIds.size + 100);
    return entrantIds.get(name)!;
  }

  /** A name, or an explicit entrant when two players share a tag. */
  type Player = string | { name: string; id: number };
  const who = (p: Player) => (typeof p === 'string' ? { name: p, id: entrantId(p) } : p);

  // Names shaped like the real ones: two players share the "JL" prefix, which
  // is what makes the single-player rule non-trivial.
  function completed(id: number, winner: Player, loser: Player, completedAt: number): BracketSet {
    const w = who(winner);
    const l = who(loser);
    return {
      id,
      identifier: String.fromCharCode(64 + id),
      round: 1,
      fullRoundText: 'Winners Round 1',
      state: 3,
      winnerId: w.id,
      lPlacement: null,
      completedAt,
      winnerAdvancesToPhase: null,
      loserAdvancesToPhase: null,
      slots: [
        { entrant: w, score: 2, characterId: null, prereqSetId: null, prereqPlacement: null, progressionOrigin: null, seedNum: null },
        { entrant: l, score: 0, characterId: null, prereqSetId: null, prereqPlacement: null, progressionOrigin: null, seedNum: null },
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

  it('stays ambiguous when two different players share a tag', async () => {
    // Two entrants, same name, different ids — which the HUGE test bracket has
    // 33 pairs of. Counting names instead of players collapses them into one,
    // and Enter would then open the newest set across both, handing the TO
    // somebody else's set to correct.
    fetchBracketMock.mockResolvedValue({
      phaseGroupId: 1,
      phaseName: 'Bracket',
      displayIdentifier: '1',
      bracketType: 'DOUBLE_ELIMINATION',
      sets: [
        completed(1, { name: 'AlphaChief', id: 900 }, 'goodfellow', 300),
        completed(2, { name: 'AlphaChief', id: 901 }, 'Mr. Pi', 200),
      ],
    });
    render(<App />);
    await screen.findByPlaceholderText(/winner's name/i);

    fireEvent.keyDown(window, { key: 'Tab' });
    const search = await screen.findByPlaceholderText(/player to correct/i);
    fireEvent.change(search, { target: { value: 'AlphaChief' } });

    await waitFor(() => expect(rowNames()).toHaveLength(2));
    expect(document.querySelector('.set-panel-list li.active')).toBeNull();
  });

  it('lets a tag be searched even when another tag contains it', async () => {
    // "Chief" is inside "AlphaChief", so a substring match names two players
    // no matter how much is typed — the shorter tag could never be searched
    // for at all. Typing it in full is unambiguous, so it wins.
    fetchBracketMock.mockResolvedValue({
      phaseGroupId: 1,
      phaseName: 'Bracket',
      displayIdentifier: '1',
      bracketType: 'DOUBLE_ELIMINATION',
      sets: [completed(1, 'AlphaChief', 'goodfellow', 300), completed(2, 'Chief', 'Mr. Pi', 200)],
    });
    render(<App />);
    await screen.findByPlaceholderText(/winner's name/i);

    fireEvent.keyDown(window, { key: 'Tab' });
    const search = await screen.findByPlaceholderText(/player to correct/i);
    fireEvent.change(search, { target: { value: 'Chief' } });

    // Their history alone — the longer tag's newer set is not sitting on top
    // of it, and it is highlighted without needing an arrow key.
    await waitFor(() => expect(rowNames()).toEqual(['Chief def. Mr. Pi 2–0']));
    expect(document.querySelector('.set-panel-list li.active')?.querySelector('.entrant-names')?.textContent).toBe(
      'Chief def. Mr. Pi 2–0'
    );
  });

  it('still offers both when the query only partly names one of them', async () => {
    fetchBracketMock.mockResolvedValue({
      phaseGroupId: 1,
      phaseName: 'Bracket',
      displayIdentifier: '1',
      bracketType: 'DOUBLE_ELIMINATION',
      sets: [completed(1, 'AlphaChief', 'goodfellow', 300), completed(2, 'Chief', 'Mr. Pi', 200)],
    });
    render(<App />);
    await screen.findByPlaceholderText(/winner's name/i);

    fireEvent.keyDown(window, { key: 'Tab' });
    const search = await screen.findByPlaceholderText(/player to correct/i);
    fireEvent.change(search, { target: { value: 'hie' } });

    // A partial match names both players, so nothing is picked for the TO.
    await waitFor(() => expect(rowNames()).toHaveLength(2));
    expect(document.querySelector('.set-panel-list li.active')).toBeNull();
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

  // jsdom implements no TouchEvent, so the gesture is assembled by hand.
  // React reads touches/changedTouches straight off the native event.
  function swipe(dx: number, dy: number, from?: Element | null) {
    const target = from ?? document.querySelector('.set-panel')!;
    const start = new Event('touchstart', { bubbles: true, cancelable: true });
    Object.defineProperty(start, 'touches', { value: [{ clientX: 120, clientY: 220 }] });
    fireEvent(target, start);
    const end = new Event('touchend', { bubbles: true, cancelable: true });
    Object.defineProperty(end, 'touches', { value: [] });
    Object.defineProperty(end, 'changedTouches', { value: [{ clientX: 120 + dx, clientY: 220 + dy }] });
    fireEvent(target, end);
  }

  it('swiping the panel right shows completed sets, and again keeps them', async () => {
    render(<App />);
    await screen.findByPlaceholderText(/winner's name/i);

    swipe(90, 0);
    expect(await screen.findByPlaceholderText(/player to correct/i)).toBeInTheDocument();

    // Directional, not a toggle: a second rightward swipe is a no-op rather
    // than a bounce back to open sets.
    swipe(90, 0);
    expect(screen.getByPlaceholderText(/player to correct/i)).toBeInTheDocument();
  });

  it('swiping the panel left goes back to sets waiting to be reported', async () => {
    render(<App />);
    await screen.findByPlaceholderText(/winner's name/i);

    swipe(90, 0);
    await screen.findByPlaceholderText(/player to correct/i);

    swipe(-90, 0);
    expect(await screen.findByPlaceholderText(/winner's name/i)).toBeInTheDocument();
  });

  it('a flick down the results list scrolls it instead of switching pile', async () => {
    render(<App />);
    await screen.findByPlaceholderText(/winner's name/i);

    // Far enough sideways to clear the distance bar, but mostly vertical —
    // this is a TO scrolling the list with an imprecise thumb.
    swipe(60, 120);

    expect(screen.getByPlaceholderText(/winner's name/i)).toBeInTheDocument();
  });

  it('a short drag is a tap, not a swipe', async () => {
    render(<App />);
    await screen.findByPlaceholderText(/winner's name/i);

    swipe(20, 0);

    expect(screen.getByPlaceholderText(/winner's name/i)).toBeInTheDocument();
  });

  it('dragging inside the search box moves the text cursor instead of switching', async () => {
    render(<App />);
    const search = await screen.findByPlaceholderText(/winner's name/i);

    swipe(90, 0, search);

    expect(screen.getByPlaceholderText(/winner's name/i)).toBeInTheDocument();
  });

  it('the pile buttons switch without a gesture, for anyone who cannot swipe', async () => {
    render(<App />);
    await screen.findByPlaceholderText(/winner's name/i);

    const completedBtn = screen.getByRole('button', { name: 'completed' });
    expect(completedBtn).toHaveAttribute('aria-pressed', 'false');

    fireEvent.click(completedBtn);
    expect(await screen.findByPlaceholderText(/player to correct/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'completed' })).toHaveAttribute('aria-pressed', 'true');

    fireEvent.click(screen.getByRole('button', { name: 'to report' }));
    expect(await screen.findByPlaceholderText(/winner's name/i)).toBeInTheDocument();
  });

  it('leaves Shift+Tab alone, so focus can still escape the search screen', async () => {
    render(<App />);
    await screen.findByPlaceholderText(/winner's name/i);

    fireEvent.keyDown(window, { key: 'Tab', shiftKey: true });

    // Plain Tab switches pile; Shift+Tab has to stay native focus navigation,
    // or the header buttons become unreachable by keyboard.
    expect(screen.getByPlaceholderText(/winner's name/i)).toBeInTheDocument();
  });
});


describe('App — live pool updates', () => {
  const fetchOpenSetsMock = vi.mocked(fetchOpenSets);

  beforeEach(() => {
    localStorage.clear();
    seedEvent();
    seedPool();
    fetchMeMock.mockResolvedValue({ user: { id: 1, displayName: 'FireSlam23' } });
    resetApiDefaults();
    resetEventSources();
  });

  afterEach(() => {
    vi.useRealTimers();
    fetchMeMock.mockReset();
  });

  it('does not subscribe until the pool has actually loaded', async () => {
    // The bracket never arrives, so this TO has not demonstrably read the
    // pool. The server refuses a subscription in that state, and a refusal is
    // not an event stream — EventSource fails permanently instead of retrying,
    // so the app must not ask until it knows the read succeeded.
    vi.mocked(fetchBracket).mockReturnValue(new Promise(() => {}));
    render(<App />);

    // Everything else finishes: signed in, pool chosen, open sets loaded.
    await screen.findByPlaceholderText(/winner's name/i);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(openedEventSource()).toBeUndefined();
  });

  it('subscribes once the pool has loaded', async () => {
    render(<App />);
    await screen.findByPlaceholderText(/winner's name/i);

    await waitFor(() => expect(openedEventSource()?.url).toContain('/phase-group/1/events'));
  });

  it('refetches at once when another TO reports into this pool', async () => {
    render(<App />);
    await screen.findByPlaceholderText(/winner's name/i);
    await waitFor(() => expect(openedEventSource()).toBeDefined());
    const before = fetchOpenSetsMock.mock.calls.length;

    act(() => openedEventSource()!.emitChanged());

    // The whole point: the change is already known to the server, so it lands
    // now rather than on whatever was left of the poll interval.
    await waitFor(() => expect(fetchOpenSetsMock.mock.calls.length).toBeGreaterThan(before));
  });

  it('polls less often while the stream is up, and speeds back up if it drops', async () => {
    vi.useFakeTimers();
    render(<App />);
    await flushTimers(40);

    const source = openedEventSource()!;
    act(() => source.emitOpen());
    await flushTimers(5);
    const afterOpen = fetchOpenSetsMock.mock.calls.length;

    // Ten seconds would have been two polls at the fallback rate; while the
    // stream is up the client's own poll is only a safety net.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10000);
    });
    expect(fetchOpenSetsMock.mock.calls.length).toBe(afterOpen);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(55000);
    });
    expect(fetchOpenSetsMock.mock.calls.length).toBeGreaterThan(afterOpen);

    // Losing the stream must not leave the app on the slow clock, since
    // polling is then the only way it hears anything at all.
    act(() => source.emitError());
    await flushTimers(5);
    const afterDrop = fetchOpenSetsMock.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(fetchOpenSetsMock.mock.calls.length).toBeGreaterThan(afterDrop);
  });
});


describe('App — setting a main by hand', () => {
  const updatePlayerMainMock = vi.mocked(updatePlayerMain);

  beforeEach(() => {
    localStorage.clear();
    seedEvent();
    seedPool();
    fetchMeMock.mockResolvedValue({ user: { id: 1, displayName: 'FireSlam23' } });
    resetApiDefaults();
    updatePlayerMainMock.mockReset();
    updatePlayerMainMock.mockResolvedValue({ characterId: 100 });
    vi.mocked(fetchCharacters).mockResolvedValue({ characters: [{ id: 100, name: 'Fox' }] });
    // The panel loads the whole pool itself now, rather than reading whatever
    // happens to have a set still to play.
    vi.mocked(fetchPoolPlayers).mockResolvedValue({
      players: [
        { playerId: 11, name: 'Ada', main: null },
        { playerId: 12, name: 'mudd', main: null },
      ],
      videogameId: TEST_EVENT.videogame.id,
    });
  });

  afterEach(() => {
    fetchMeMock.mockReset();
  });

  it('opens from the header and saves a main against the player', async () => {
    render(<App />);
    await screen.findByPlaceholderText(/winner's name/i);

    fireEvent.click(screen.getByRole('button', { name: 'Player mains' }));
    fireEvent.change(await screen.findByLabelText('Main for Ada'), { target: { value: '100' } });

    // Keyed to the start.gg player, not the entrant, so it is still there at
    // their next tournament.
    await waitFor(() => expect(updatePlayerMainMock).toHaveBeenCalledWith(11, TEST_EVENT.videogame.id, 100));
  });

  it('shows the new main straight away instead of waiting for a poll', async () => {
    render(<App />);
    await screen.findByPlaceholderText(/winner's name/i);
    fireEvent.click(screen.getByRole('button', { name: 'Player mains' }));

    fireEvent.change(await screen.findByLabelText('Main for Ada'), { target: { value: '100' } });

    // Polling is up to 12s away now that the change stream carries the urgent
    // updates; a main the TO just set must not look ignored for that long.
    // The dropdown is where the pick shows — the column beside it only speaks
    // when it has something the dropdown cannot say.
    await waitFor(() => {
      const row = [...document.querySelectorAll('.mains-list li')].find((li) => li.textContent?.includes('Ada'));
      expect((row?.querySelector('select') as HTMLSelectElement | null)?.value).toBe('100');
      expect(row?.querySelector('.mains-current')).toBeNull();
    });
  });
});

/**
 * The whole point of the outbox, end to end.
 *
 * Before it, submit() awaited reportSet inline: the panel froze for up to 25
 * seconds on venue wifi (measured against a socket that accepts and never
 * answers), every key including Escape was swallowed, and a failure threw the
 * report away behind a toast that — because the report screen is its own early
 * return above where the toast rendered — never appeared at all.
 */
describe('App — reporting a set and walking away', () => {
  const OPEN_SET = {
    id: 5001,
    isPreview: false,
    isStarted: false,
    fullRoundText: 'Winners Round 1',
    identifier: 'A',
    lPlacement: null,
    entrants: [
      { id: 6001, name: 'Ada' },
      { id: 6002, name: 'mudd' },
    ],
  };

  beforeEach(() => {
    localStorage.clear();
    resetOutbox();
    seedEvent();
    seedPool();
    resetApiDefaults();
    resetEventSources();
    fetchMeMock.mockResolvedValue({ user: { id: 1, displayName: 'FireSlam23' } });
    vi.mocked(fetchOpenSets).mockResolvedValue({ sets: [OPEN_SET] });
  });

  afterEach(() => {
    vi.mocked(reportSet).mockReset();
    fetchMeMock.mockReset();
    localStorage.clear();
    resetOutbox();
  });

  /** Opens the one set in the list and submits a 2-0 for Ada. */
  async function reportIt() {
    // Matched on the row rather than as one text node: each tag now sits in
    // its own span so a character icon can go beside it.
    await screen.findByText(
      (_content, element) => element?.className === 'entrant-names' && /Ada vs mudd/.test(element.textContent ?? '')
    );
    // Clicked rather than picked with a digit: the digit handler is rebound by
    // an effect after paint, and the row can appear (from a poll resolving
    // outside act) a beat before that effect runs, leaving the keypress to hit
    // a handler that closed over an empty list. The row's own onClick is bound
    // at render, and tapping is what a TO does anyway. Digit selection has its
    // own tests.
    fireEvent.click(document.querySelector('.set-panel-list li')!);
    await screen.findByText(/Winners Round 1 · A/);
    for (const key of ['w', 'w', 'Enter', 'Enter']) fireEvent.keyDown(window, { key });
  }

  it('gives the TO the screen back at once, without claiming anything was reported', async () => {
    vi.mocked(reportSet).mockReturnValue(new Promise(() => {})); // in flight forever
    render(<App />);
    await reportIt();

    // Off the report screen before start.gg has said anything at all.
    expect(await screen.findByText(/Sending Ada vs mudd/)).toBeInTheDocument();
    expect(screen.queryByText(/Winners Round 1 · A/)).not.toBeInTheDocument();
    expect(screen.queryByText(/^Reported /)).not.toBeInTheDocument();
  });

  it('says it was reported only once start.gg confirms', async () => {
    let land: (value: { result: unknown }) => void = () => {};
    vi.mocked(reportSet).mockReturnValue(new Promise((resolve) => (land = resolve)));
    render(<App />);
    await reportIt();
    await screen.findByText(/Sending Ada vs mudd/);
    expect(screen.queryByText(/^Reported /)).not.toBeInTheDocument();

    land({ result: {} });

    expect(await screen.findByText('Reported Ada vs mudd')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText(/Sending Ada vs mudd/)).not.toBeInTheDocument());
  });

  it('leaves a dead end on screen as NOT REPORTED, not as a toast that fades', async () => {
    vi.mocked(reportSet).mockRejectedValue(
      apiFailure(409, 'This set is between different players on start.gg now — reopen it to see who, then report again.')
    );
    render(<App />);
    await reportIt();

    expect(await screen.findByText('NOT REPORTED')).toBeInTheDocument();
    expect(screen.getByText(/between different players/)).toBeInTheDocument();
  });

  it('keeps a failure visible long after any toast would have gone', async () => {
    vi.mocked(reportSet).mockRejectedValue(apiFailure(409, 'start.gg would not take this.'));
    render(<App />);
    await reportIt();
    await screen.findByText('NOT REPORTED');

    // Three times the toast's own lifetime.
    await new Promise((resolve) => setTimeout(resolve, 900));

    expect(screen.getByText('NOT REPORTED')).toBeInTheDocument();
  });

  it('keeps trying when the failure is one that might clear up', async () => {
    // Status 0: the request never reached the server at all. Venue wifi.
    vi.mocked(reportSet).mockRejectedValue(apiFailure(0, 'Could not reach the server.'));
    render(<App />);
    await reportIt();

    await waitFor(() => expect(vi.mocked(reportSet).mock.calls.length).toBeGreaterThan(1), { timeout: 10_000 });
    // Still sending, not given up on: the score is the thing that must not be lost.
    expect(screen.getByText(/Sending Ada vs mudd/)).toBeInTheDocument();
    expect(screen.queryByText('NOT REPORTED')).not.toBeInTheDocument();
  }, 15_000);

  it('counts its deliveries, so the server can tell a retry from a decision', async () => {
    vi.mocked(reportSet).mockRejectedValue(apiFailure(0, 'Could not reach the server.'));
    render(<App />);
    await reportIt();

    await waitFor(() => expect(vi.mocked(reportSet).mock.calls.length).toBeGreaterThan(1), { timeout: 10_000 });
    const attempts = vi.mocked(reportSet).mock.calls.map(([payload]) => payload.attempt);
    expect(attempts.slice(0, 2)).toEqual([1, 2]);
  }, 15_000);

  it('sends a dead-lettered report again when the TO asks', async () => {
    vi.mocked(reportSet).mockRejectedValueOnce(apiFailure(409, 'start.gg would not take this.'));
    render(<App />);
    await reportIt();
    await screen.findByText('NOT REPORTED');

    vi.mocked(reportSet).mockResolvedValue({ result: {} });
    fireEvent.click(screen.getByRole('button', { name: 'try again' }));

    expect(await screen.findByText('Reported Ada vs mudd')).toBeInTheDocument();
  });

  it('lets the TO throw a dead-lettered report away once they have dealt with it', async () => {
    vi.mocked(reportSet).mockRejectedValue(apiFailure(409, 'start.gg would not take this.'));
    render(<App />);
    await reportIt();
    await screen.findByText('NOT REPORTED');

    fireEvent.click(screen.getByRole('button', { name: 'discard' }));

    await waitFor(() => expect(screen.queryByText('NOT REPORTED')).not.toBeInTheDocument());
  });

  it('still has the report after a reload, because the tab is not where it lives', async () => {
    vi.mocked(reportSet).mockRejectedValue(apiFailure(409, 'start.gg would not take this.'));
    const { unmount } = render(<App />);
    await reportIt();
    await screen.findByText('NOT REPORTED');
    unmount();
    resetOutbox(); // a fresh page load against the same browser storage

    vi.mocked(reportSet).mockReturnValue(new Promise(() => {}));
    render(<App />);

    await waitFor(() => expect(screen.getByText('NOT REPORTED')).toBeInTheDocument());
  });
});

describe('App — a queued report that was already in storage at start-up', () => {
  const OPEN_SET = {
    id: 5001,
    isPreview: false,
    isStarted: false,
    fullRoundText: 'Winners Round 1',
    identifier: 'A',
    lPlacement: null,
    entrants: [
      { id: 6001, name: 'Ada' },
      { id: 6002, name: 'mudd' },
    ],
  };

  beforeEach(() => {
    localStorage.clear();
    resetOutbox();
    seedEvent();
    seedPool();
    resetApiDefaults();
    resetEventSources();
    fetchMeMock.mockResolvedValue({ user: { id: 1, displayName: 'FireSlam23' } });
    vi.mocked(fetchOpenSets).mockResolvedValue({ sets: [OPEN_SET] });
  });

  afterEach(() => {
    vi.mocked(reportSet).mockReset();
    fetchMeMock.mockReset();
    localStorage.clear();
    resetOutbox();
  });

  it('reflects the queue itself, not just what its own delivery returned', async () => {
    // Found in a browser, not here: React StrictMode mounts each effect, tears
    // it down and mounts it again, so the delivery started by the first mount
    // belongs to an effect that has already been cleaned up. A strip refreshed
    // only from that delivery's own return value kept showing a report that
    // had landed — this feature inverted, and a TO would report the set twice.
    //
    // So the invariant is that the strip follows the queue, whoever changed
    // it: a torn-down effect, another tab, anything.
    enqueue(
      { setId: 5001, winnerEntrantId: 6001, loserEntrantId: 6002, requiredWins: 2, shorthand: '+' },
      'Ada vs mudd',
      Date.now()
    );
    vi.mocked(reportSet).mockReturnValue(new Promise(() => {})); // never settles, so no drain does this for us

    render(
      <StrictMode>
        <App />
      </StrictMode>
    );
    // Re-queried at assertion time rather than held: under StrictMode React
    // renders twice and discards the first pass, so a node captured by findBy
    // can be the detached one even though the text is on screen.
    await waitFor(() => expect(screen.getByText(/Sending Ada vs mudd/)).toBeInTheDocument());

    act(() => dropFromOutbox('5001'));

    await waitFor(() => expect(screen.queryByText(/Sending Ada vs mudd/)).not.toBeInTheDocument());
  });
});

/**
 * /api/me answers 200 with a null user when nobody is signed in — it is a
 * probe, not a protected resource. So a *failure* there never means "signed
 * out", it means the question could not be asked. Treating the two as one
 * threw a TO with a perfectly good session onto the sign-in screen every time
 * they reloaded on flaky venue wifi.
 */
describe('App — when the session check cannot reach the server', () => {
  beforeEach(() => {
    localStorage.clear();
    resetOutbox();
    seedEvent();
    seedPool();
    resetApiDefaults();
    resetEventSources();
  });

  afterEach(() => {
    vi.useRealTimers();
    fetchMeMock.mockReset();
    localStorage.clear();
    resetOutbox();
  });

  it('does not sign the TO out just because it could not ask', async () => {
    fetchMeMock.mockRejectedValue(apiFailure(0, 'Could not reach the server. Check your connection.'));
    render(<App />);

    expect(await screen.findByText(/could not reach the server/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /sign in with start\.gg/i })).not.toBeInTheDocument();
  });

  it('keeps the remembered event, so signing back in is not required to get it back', async () => {
    fetchMeMock.mockRejectedValue(apiFailure(0));
    render(<App />);
    await screen.findByText(/could not reach the server/i);

    expect(localStorage.getItem('smashset.event')).not.toBeNull();
  });

  it('lets itself back in when the server comes back, without a reload', async () => {
    vi.useFakeTimers();
    fetchMeMock.mockRejectedValueOnce(apiFailure(0));
    fetchMeMock.mockResolvedValue({ user: { id: 1, displayName: 'FireSlam23' } });
    render(<App />);
    await flushTimers();
    expect(screen.getByText(/could not reach the server/i)).toBeInTheDocument();

    await vi.advanceTimersByTimeAsync(3000);
    await flushTimers();

    expect(screen.queryByText(/could not reach the server/i)).not.toBeInTheDocument();
    expect(screen.getByPlaceholderText(/winner's name/i)).toBeInTheDocument();
  });

  it('retries at once when the TO asks, rather than waiting out the clock', async () => {
    fetchMeMock.mockRejectedValueOnce(apiFailure(0));
    fetchMeMock.mockResolvedValue({ user: { id: 1, displayName: 'FireSlam23' } });
    render(<App />);
    await screen.findByText(/could not reach the server/i);

    fireEvent.click(screen.getByRole('button', { name: 'try again' }));

    expect(await screen.findByPlaceholderText(/winner's name/i)).toBeInTheDocument();
  });

  it('still shows sign-in when the server actually says nobody is signed in', async () => {
    // The real signed-out answer is a 200 carrying a null user, and that must
    // keep working exactly as before.
    fetchMeMock.mockResolvedValue({ user: null });
    render(<App />);

    expect(await screen.findByRole('button', { name: /sign in with start\.gg/i })).toBeInTheDocument();
  });

  it('shows queued reports on that screen, since they are why it matters', async () => {
    enqueue(
      { setId: 5001, winnerEntrantId: 6001, loserEntrantId: 6002, requiredWins: 2, shorthand: '+' },
      'Ada vs mudd',
      Date.now()
    );
    fetchMeMock.mockRejectedValue(apiFailure(0));
    render(<App />);

    expect(await screen.findByText(/Sending Ada vs mudd/)).toBeInTheDocument();
  });
});
