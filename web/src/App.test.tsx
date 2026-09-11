import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { fetchAccount, fetchBracket, fetchCharacters, fetchPhaseGroups, fetchSetDetail, fetchStages, updateTopXBo5 } from './api';

const fetchMeMock = vi.fn();
const logoutMock = vi.fn();

vi.mock('./api', () => ({
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

  it('sign out calls the API and returns to the Sign In screen', async () => {
    fetchMeMock.mockResolvedValue({ user: { id: 1, displayName: 'FireSlam23' } });
    localStorage.setItem(
      'smashset.event',
      JSON.stringify({
        id: 1,
        name: 'small bracket',
        slug: 'tournament/x/event/small-bracket',
        videogame: { id: 1, name: 'Melee' },
        tournament: { id: 1, name: 'x' },
      })
    );
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
    localStorage.setItem(
      'smashset.event',
      JSON.stringify({
        id: 1,
        name: 'small bracket',
        slug: 'tournament/x/event/small-bracket',
        videogame: { id: 1, name: 'Melee' },
        tournament: { id: 1, name: 'x' },
      })
    );
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
    localStorage.setItem(
      'smashset.event',
      JSON.stringify({
        id: 1,
        name: 'small bracket',
        slug: 'tournament/x/event/small-bracket',
        videogame: { id: 1, name: 'Melee' },
        tournament: { id: 1, name: 'x' },
      })
    );
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

describe('App — completed / not-ready sections', () => {
  const fetchBracketMock = vi.mocked(fetchBracket);
  const fetchAccountMock = vi.mocked(fetchAccount);
  const fetchSetDetailMock = vi.mocked(fetchSetDetail);
  const fetchCharactersMock = vi.mocked(fetchCharacters);
  const fetchStagesMock = vi.mocked(fetchStages);

  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem(
      'smashset.event',
      JSON.stringify({
        id: 1,
        name: 'small bracket',
        slug: 'tournament/x/event/small-bracket',
        videogame: { id: 1, name: 'Melee' },
        tournament: { id: 1, name: 'x' },
      })
    );
    fetchMeMock.mockResolvedValue({ user: { id: 1, displayName: 'FireSlam23' } });
    // The account-modal describe block above resets this mock's
    // implementation (not just its call history) in its own afterEach —
    // it's the same shared vi.fn() instance across the whole file, so it
    // needs a fresh resolution here too, not just in that earlier block.
    // Same reasoning for the three below: this block's own afterEach resets
    // them (since a test later in this same block might need a different
    // value), so each test starts from a known-good default here rather
    // than whatever the previous test in this block left behind.
    fetchAccountMock.mockResolvedValue({ displayName: 'FireSlam23', startggSlug: null, topXBo5: null });
    fetchSetDetailMock.mockResolvedValue({ games: [] });
    fetchCharactersMock.mockResolvedValue({ characters: [] });
    fetchStagesMock.mockResolvedValue({ stages: [] });
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

    render(<App />);

    await userEvent.click(await screen.findByText('Completed (1)'));
    // A custom matcher, not a plain string, because the winner's name sits
    // inside a nested <strong> — getByText's default matching only looks at
    // an element's own direct text-node children, which would otherwise
    // never see the full composed sentence as one string.
    expect(
      screen.getByText((_content, element) => element?.textContent === 'Winner Player def. Loser Player 2–0')
    ).toBeInTheDocument();

    await userEvent.click(screen.getByText('Not ready (1)'));
    expect(screen.getByText('Winner Player vs TBD')).toBeInTheDocument();
  });

  it('renders neither section when there is nothing completed or not-ready', async () => {
    fetchBracketMock.mockResolvedValue({ phaseGroupId: 1, phaseName: 'Bracket', displayIdentifier: '1', bracketType: 'DOUBLE_ELIMINATION', sets: [] });
    render(<App />);

    await screen.findByPlaceholderText(/winner's name/i);
    expect(screen.queryByText(/^Completed/)).not.toBeInTheDocument();
    expect(screen.queryByText(/^Not ready/)).not.toBeInTheDocument();
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

    await userEvent.click(await screen.findByText('Completed (1)'));
    await userEvent.click(
      screen.getByText((_content, element) => element?.textContent === 'Winner Player def. Loser Player 2–0')
    );

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

    await userEvent.click(await screen.findByText('Completed (1)'));
    await userEvent.click(
      screen.getByText((_content, element) => element?.textContent === 'Winner Player def. Loser Player 2–0')
    );

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
    localStorage.setItem(
      'smashset.event',
      JSON.stringify({
        id: 1,
        name: 'Big event',
        slug: 'tournament/x/event/big-event',
        videogame: { id: 1, name: 'Melee' },
        tournament: { id: 1, name: 'x' },
      })
    );
    fetchMeMock.mockResolvedValue({ user: { id: 1, displayName: 'FireSlam23' } });
    fetchPhaseGroupsMock.mockResolvedValue({
      phaseGroups: [
        { id: 10, displayIdentifier: 'A', phaseName: 'Pools', bracketType: 'ROUND_ROBIN' },
        { id: 20, displayIdentifier: 'B', phaseName: 'Pools', bracketType: 'ROUND_ROBIN' },
      ],
    });
    fetchBracketMock.mockResolvedValue({ phaseGroupId: 10, phaseName: 'Pools', displayIdentifier: 'A', bracketType: 'ROUND_ROBIN', sets: [] });
    // Earlier blocks above reset these in their own afterEach (same shared
    // vi.fn() instances across the whole file) — re-establish their
    // defaults here too, same reasoning as everywhere else in this file.
    vi.mocked(fetchAccount).mockResolvedValue({ displayName: 'FireSlam23', startggSlug: null, topXBo5: null });
    vi.mocked(fetchCharacters).mockResolvedValue({ characters: [] });
    vi.mocked(fetchStages).mockResolvedValue({ stages: [] });
    vi.mocked(fetchSetDetail).mockResolvedValue({ games: [] });
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
