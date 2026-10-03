import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AdminDashboard, formatDuration, formatShare } from './AdminDashboard';
import { fetchAdminReports } from './api';
import type { AdminDashboardData, AdminSummary } from './types';

vi.mock('./api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./api')>()),
  fetchAdminReports: vi.fn(),
}));

const SUMMARY: AdminSummary = {
  reportedSets: 34,
  medianOpenToReportMs: 6400,
  timedSets: 30,
  medianDeliveryMs: 800,
  deliveredSets: 30,
  bothCharacters: 4,
  anyCharacters: 7,
  charactersKnown: 10,
  correctedSets: 2,
  foundOnFile: 1,
};

const DATA: AdminDashboardData = {
  overall: SUMMARY,
  brackets: [
    {
      phaseGroupId: '3476629',
      tournamentName: 'Bring More Setups 218',
      tournamentSlug: 'tournament/bring-more-setups-218',
      eventName: 'BMS Melee Singles',
      phaseName: 'Bracket',
      displayIdentifier: '1',
      totalSets: 58,
      summary: SUMMARY,
      sets: [
        {
          setId: '108437297',
          firstReportedAt: '2026-10-02T23:48:51Z',
          reporter: 'FireSlam23',
          winnerName: 'Ada',
          loserName: 'mudd',
          winnerScore: 2,
          loserScore: 1,
          games: 3,
          winnerCharacterGames: 3,
          loserCharacterGames: 2,
          openToReportMs: 6400,
          deliveryMs: 800,
          reports: 2,
          foundOnFile: 0,
          fromLog: false,
        },
        {
          setId: '108437426',
          firstReportedAt: '2026-10-03T01:24:31Z',
          reporter: null,
          winnerName: null,
          loserName: null,
          winnerScore: null,
          loserScore: null,
          games: null,
          winnerCharacterGames: null,
          loserCharacterGames: null,
          openToReportMs: null,
          deliveryMs: null,
          reports: 1,
          foundOnFile: 0,
          fromLog: true,
        },
      ],
    },
  ],
};

afterEach(() => {
  vi.mocked(fetchAdminReports).mockReset();
});

describe('formatDuration', () => {
  it('says seconds, minutes or hours, whichever a person would', () => {
    expect(formatDuration(6400)).toBe('6.4s');
    expect(formatDuration(252_000)).toBe('4m 12s');
    expect(formatDuration(3_780_000)).toBe('1h 3m');
  });

  it('shows a dash for no figure, never zero', () => {
    // Zero would read as instant, which is the most flattering wrong answer.
    expect(formatDuration(null)).toBe('—');
  });
});

describe('formatShare', () => {
  it('gives the percentage with the counts behind it', () => {
    expect(formatShare(4, 10)).toBe('40% (4 of 10)');
  });

  it('shows a dash when there is nothing to divide by', () => {
    expect(formatShare(0, 0)).toBe('—');
  });
});

describe('AdminDashboard', () => {
  it('says how many of each bracket\'s sets smashset reported', async () => {
    vi.mocked(fetchAdminReports).mockResolvedValue(DATA);
    render(<AdminDashboard onClose={vi.fn()} />);

    expect(await screen.findByText('Reported 34 of 58 sets (59%)')).toBeInTheDocument();
    expect(screen.getByText(/Bring More Setups 218 · BMS Melee Singles · Bracket 1/)).toBeInTheDocument();
  });

  it('shows the medians with how many sets they rest on', async () => {
    vi.mocked(fetchAdminReports).mockResolvedValue(DATA);
    render(<AdminDashboard onClose={vi.fn()} />);

    await screen.findByText('Reported 34 of 58 sets (59%)');
    expect(screen.getAllByText('6.4s').length).toBeGreaterThan(0);
    expect(screen.getAllByText(/30 timed/).length).toBeGreaterThan(0);
    expect(screen.getAllByText('40% (4 of 10)').length).toBeGreaterThan(0);
  });

  it('lists each set by its players and score, and marks a corrected one', async () => {
    vi.mocked(fetchAdminReports).mockResolvedValue(DATA);
    render(<AdminDashboard onClose={vi.fn()} />);

    expect(await screen.findByText('Ada 2–1 mudd')).toBeInTheDocument();
    expect(screen.getByText('W 3/3 · L 2/3')).toBeInTheDocument();
    expect(screen.getByText('corrected')).toBeInTheDocument();
  });

  it('labels a set recovered from the logs, so its blanks read as expected', async () => {
    vi.mocked(fetchAdminReports).mockResolvedValue(DATA);
    render(<AdminDashboard onClose={vi.fn()} />);

    expect(await screen.findByText('set 108437426')).toBeInTheDocument();
    expect(screen.getByText('from logs')).toBeInTheDocument();
  });

  it('admits a bracket it has not counted yet instead of inventing a total', async () => {
    vi.mocked(fetchAdminReports).mockResolvedValue({
      ...DATA,
      brackets: [{ ...DATA.brackets[0], totalSets: null }],
    });
    render(<AdminDashboard onClose={vi.fn()} />);

    expect(await screen.findByText('Reported 34 sets · bracket size not counted yet')).toBeInTheDocument();
  });

  it('shows a failure and a way to retry, never an empty page', async () => {
    // A dashboard that fails and draws nothing reads as "nothing reported",
    // which is a confident wrong answer rather than an error.
    vi.mocked(fetchAdminReports).mockRejectedValueOnce(new Error('Not available.')).mockResolvedValueOnce(DATA);
    render(<AdminDashboard onClose={vi.fn()} />);

    expect(await screen.findByRole('alert')).toHaveTextContent('Not available.');
    expect(screen.queryByText(/Nothing reported yet/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'try again' }));
    expect(await screen.findByText('Reported 34 of 58 sets (59%)')).toBeInTheDocument();
  });

  it('says plainly when nothing has been reported yet', async () => {
    vi.mocked(fetchAdminReports).mockResolvedValue({ overall: { ...SUMMARY, reportedSets: 0 }, brackets: [] });
    render(<AdminDashboard onClose={vi.fn()} />);

    expect(await screen.findByText(/Nothing reported yet/)).toBeInTheDocument();
  });

  it('closes on Escape', async () => {
    vi.mocked(fetchAdminReports).mockResolvedValue(DATA);
    const onClose = vi.fn();
    render(<AdminDashboard onClose={onClose} />);
    await screen.findByText('Reported 34 of 58 sets (59%)');

    fireEvent.keyDown(window, { key: 'Escape' });

    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });
});
