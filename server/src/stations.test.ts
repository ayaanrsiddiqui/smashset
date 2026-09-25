import { beforeEach, describe, expect, it, vi } from 'vitest';

const gqlMock = vi.fn();
vi.mock('./startgg.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./startgg.js')>()),
  gql: (...args: unknown[]) => gqlMock(...args),
}));

const { getEventStations, resetStationCache } = await import('./stations.js');

/** What start.gg answers for one page, in the shape the query asks for. */
function page(nodes: { id: number; number: number | null }[]) {
  return { event: { tournament: { stations: { nodes } } } };
}

function station(number: number) {
  return { id: 1000 + number, number };
}

/** Serves `all` in chunks of 50, the page size the walk uses. */
function paged(all: { id: number; number: number | null }[]) {
  return (_token: unknown, _query: string, vars: { page: number }) =>
    Promise.resolve(page(all.slice((vars.page - 1) * 50, vars.page * 50)));
}

describe('getEventStations', () => {
  beforeEach(() => {
    resetStationCache();
    gqlMock.mockReset();
  });

  it('collects every station across pages', async () => {
    // The bug this replaces: reading pageInfo.total and concluding the list was
    // truncated. The walk reads nodes and nothing else.
    const all = Array.from({ length: 76 }, (_, i) => station(i + 1));
    gqlMock.mockImplementation(paged(all));

    const stations = await getEventStations('t', '1');

    expect(stations).toHaveLength(76);
    expect(stations[0].number).toBe(1);
    expect(stations[75].number).toBe(76);
  });

  it('never asks pageInfo for anything, since its totals are wrong', async () => {
    // 42 for a 16-station tournament, 76 for one with 15. Not asking is the
    // only way to be sure nobody starts trusting it again.
    gqlMock.mockImplementation(paged([station(1)]));

    await getEventStations('t', '1');

    expect(gqlMock.mock.calls[0][1]).not.toMatch(/pageInfo|total/);
  });

  it('stops after a short page without asking for another', async () => {
    gqlMock.mockImplementation(paged([station(1), station(2)]));

    await getEventStations('t', '1');

    expect(gqlMock).toHaveBeenCalledOnce();
  });

  it('stops when a page comes back empty', async () => {
    const all = Array.from({ length: 100 }, (_, i) => station(i + 1));
    gqlMock.mockImplementation(paged(all));

    const stations = await getEventStations('t', '1');

    // Two full pages, then one empty page to learn there are no more.
    expect(gqlMock).toHaveBeenCalledTimes(3);
    expect(stations).toHaveLength(100);
  });

  it('gives up rather than spinning when pages never run out', async () => {
    // A paging field that always answers is not hypothetical here: this one
    // reports six pages that do not exist. Spinning would burn an 80/minute
    // budget on one start.
    gqlMock.mockImplementation((_t: unknown, _q: string, vars: { page: number }) =>
      Promise.resolve(page(Array.from({ length: 50 }, (_, i) => station((vars.page - 1) * 50 + i + 1))))
    );

    const stations = await getEventStations('t', '1');

    expect(gqlMock).toHaveBeenCalledTimes(8);
    expect(stations).toHaveLength(400);
  });

  it('drops a station with no number, which a TO could not name anyway', async () => {
    gqlMock.mockImplementation(paged([station(1), { id: 99, number: null }, station(3)]));

    const stations = await getEventStations('t', '1');

    expect(stations.map((s) => s.number)).toEqual([1, 3]);
  });

  it('sorts by number whatever order start.gg returns them in', async () => {
    gqlMock.mockImplementation(paged([station(7), station(2), station(11)]));

    const stations = await getEventStations('t', '1');

    expect(stations.map((s) => s.number)).toEqual([2, 7, 11]);
  });

  it('answers an empty list for a tournament with no stations', async () => {
    gqlMock.mockImplementation(paged([]));

    expect(await getEventStations('t', '1')).toEqual([]);
  });

  it('serves a second start from cache rather than a second round trip', async () => {
    // Every start resolves a number to an id, so without this each one costs an
    // extra upstream call on the action a TO does most.
    gqlMock.mockImplementation(paged([station(1)]));

    await getEventStations('t', '1');
    await getEventStations('t', '1');

    expect(gqlMock).toHaveBeenCalledOnce();
  });

  it('keeps events apart, so one event cannot serve another its stations', async () => {
    gqlMock.mockImplementation(paged([station(1)]));

    await getEventStations('t', '1');
    await getEventStations('t', '2');

    expect(gqlMock).toHaveBeenCalledTimes(2);
  });
});
