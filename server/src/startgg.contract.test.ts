import { beforeAll, describe, expect, it } from 'vitest';
import { COST_MODEL } from './routes/sets.js';
import { PULSE } from './poolWatcher.js';
import { parseDisplayScore } from './displayScore.js';
import { resolveShortUrl } from './startgg.js';

// A contract test: it checks assumptions about an external service we do not
// control, rather than our own logic. Every other test in this repo mocks
// start.gg, which means none of them can notice start.gg changing underneath
// us — and that is precisely the failure that took the bracket down: a cost
// model measured correctly once, then silently invalidated when fields were
// added to a query.
//
// Runs only with RUN_CONTRACT_TESTS=1 (see the startgg-canary workflow), so a
// normal `npm test` stays offline, deterministic, and free of rate limits.
// It alerts rather than gates: start.gg being down is not a reason to block a
// merge.
const ASKED_TO_RUN = process.env.RUN_CONTRACT_TESTS === '1';
const ENABLED = ASKED_TO_RUN && !!process.env.STARTGG_API_KEY;
const ENDPOINT = 'https://api.start.gg/gql/alpha';
// Generous on purpose: a rate-limited attempt waits out the limit (see post()),
// which is far past vitest's 5s default.
const NETWORK_TIMEOUT_MS = 180_000;

// Ayaan's own disposable test tournament — synthetic entrants, safe to read
// and safe to mutate. Resolved by slug rather than by id so the canary
// survives the bracket being rebuilt.
const TOURNAMENT_SLUG = 'fireslam23test';

/** Below this many multi-game sets, a per-set character cost means nothing. */
const MIN_SETS_WITH_GAMES = 4;

/** Below this a phase is too small for its per-pool cost to mean anything. */
const MIN_POOLS_TO_MEASURE = 4;

interface Measured {
  complexity: number | null;
  sets: number;
  nodes: {
    id: number | string;
    state?: number;
    displayScore?: string | null;
    winnerProgressionSeed?: unknown;
    slots?: { entrant?: { name: string } | null; seed?: { progressionSource?: unknown } | null }[];
  }[];
  error: string | null;
}

// start.gg allows ~80 requests/minute per token. A canary that cries wolf
// because something else drained the budget is worse than no canary, so a 429
// is waited out rather than reported as a contract break.
async function post(query: string, variables: Record<string, unknown>): Promise<{ status: number; raw: string }> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.STARTGG_API_KEY}` },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(30_000),
    });
    const raw = await res.text();
    if (res.status !== 429 || attempt >= 3) return { status: res.status, raw };
    await new Promise((resolve) => setTimeout(resolve, 20_000 * (attempt + 1)));
  }
}

async function run(query: string, variables: Record<string, unknown>): Promise<Measured> {
  const { status, raw } = await post(query, variables);
  let body: {
    data?: { phaseGroup?: { sets: { nodes: Measured['nodes'] } } | null };
    errors?: { message: string }[];
    extensions?: { queryComplexity?: number };
  };
  try {
    body = JSON.parse(raw);
  } catch {
    throw new Error(`start.gg returned ${status} (non-JSON): ${raw.slice(0, 200)}`);
  }
  const nodes = body.data?.phaseGroup?.sets?.nodes ?? [];
  return {
    complexity: body.extensions?.queryComplexity ?? null,
    sets: nodes.length,
    nodes,
    error: body.errors?.[0]?.message ?? null,
  };
}

async function livePhaseGroupId(): Promise<string> {
  // Ranked by *completed* sets, not total. Ranking by total picked whichever
  // bracket was biggest, and a freshly created 116-entrant event has no
  // finished sets at all — so the score-format check below had nothing to
  // look at and failed on a tournament that was perfectly healthy.
  const { status, raw } = await post(
    `query($slug:String!){tournament(slug:$slug){events{id phaseGroups{id sets(page:1,perPage:1,filters:{state:[3]}){pageInfo{total}}}}}}`,
    { slug: TOURNAMENT_SLUG }
  );
  let body: {
    data?: { tournament?: { events: { phaseGroups: { id: number; sets: { pageInfo: { total: number } } }[] }[] } };
    errors?: { message: string }[];
  };
  try {
    body = JSON.parse(raw);
  } catch {
    throw new Error(`start.gg returned ${status} (non-JSON): ${raw.slice(0, 200)}`);
  }
  if (body.errors?.length) throw new Error(`start.gg error: ${body.errors.map((e) => e.message).join('; ')}`);

  const groups = (body.data?.tournament?.events ?? []).flatMap((e) => e.phaseGroups ?? []);
  const biggest = groups.sort((a, b) => (b.sets?.pageInfo?.total ?? 0) - (a.sets?.pageInfo?.total ?? 0))[0];
  if (!biggest) throw new Error(`no phase groups for "${TOURNAMENT_SLUG}" (HTTP ${status}): ${raw.slice(0, 200)}`);
  return String(biggest.id);
}

/**
 * A phase group in a *later* phase of some recent tournament — one whose slots
 * were filled by an earlier phase, so seed.progressionSource actually resolves.
 *
 * This matters because it is the expensive case: the structure query costs ~8
 * objects per set when those fields are null and ~12 when they are populated,
 * and the local test bracket is single-phase, so measuring only there would
 * check the cheap end and call the model verified.
 */
async function progressionFedPhaseGroupId(): Promise<string | null> {
  const { raw } = await post(
    `query{tournaments(query:{perPage:8,filter:{past:true,videogameIds:[1386]}}){nodes{` +
      `events(filter:{videogameId:[1386]}){phaseGroups{id phase{phaseOrder}}}}}}`,
    {}
  );
  try {
    const body = JSON.parse(raw) as {
      data?: { tournaments?: { nodes: { events?: { phaseGroups?: { id: number; phase?: { phaseOrder?: number } }[] }[] }[] } };
    };
    const events = (body.data?.tournaments?.nodes ?? []).flatMap((t) => t.events ?? []);
    for (const event of events) {
      const groups = event.phaseGroups ?? [];
      const orders = [...new Set(groups.map((g) => g.phase?.phaseOrder).filter((o): o is number => typeof o === 'number'))];
      if (orders.length < 2) continue;
      const latest = Math.max(...orders);
      const fed = groups.find((g) => g.phase?.phaseOrder === latest);
      if (fed) return String(fed.id);
    }
  } catch {
    // Treated the same as finding nothing — see the skip in the test below.
  }
  return null;
}

/**
 * Without this, a run asked to check start.gg with no key simply skipped every
 * describe below and reported success — a canary that is green having looked
 * at nothing, which is worse than a red one because it reads as protection.
 * Being unable to run is a result worth failing on; not being asked to is not.
 */
describe.skipIf(!ASKED_TO_RUN)('start.gg canary preconditions', () => {
  it('has a key to run against, rather than skipping everything and passing', () => {
    expect(
      process.env.STARTGG_API_KEY,
      'RUN_CONTRACT_TESTS=1 but STARTGG_API_KEY is unset, so every contract test below would skip and this run would pass having checked nothing. Set the STARTGG_API_KEY repo secret.'
    ).toBeTruthy();
  });
});

describe.skipIf(!ENABLED)('start.gg contract', () => {
  // Resolved once: each lookup is a request against the same rate limit the
  // tests are measuring.
  let phaseGroupId: string;
  beforeAll(async () => {
    phaseGroupId = await livePhaseGroupId();
  }, 120_000);

  it('still charges no more per set than the cost model assumes', async () => {
    for (const [name, model] of Object.entries({
      live: COST_MODEL.live,
      structure: COST_MODEL.structure,
      openSets: COST_MODEL.openSets,
      cascade: COST_MODEL.cascade,
      // The change detector. Every field is a scalar on the set, so unlike the
      // character and pool-preview models this one is measurable on any pool
      // with sets in it — no need to go hunting for data that happens to exist.
      pulse: PULSE,
    })) {
      const r = await run(model.query, { phaseGroupId, page: 1, perPage: 20 });
      expect(r.error, `${name} query failed: ${r.error}`).toBeNull();
      expect(r.sets, `${name} query returned no sets to measure`).toBeGreaterThan(0);
      expect(r.complexity, `${name} query reported no complexity`).not.toBeNull();

      const perSet = (r.complexity! - model.base) / r.sets;
      // Fails the moment start.gg gets more expensive than the page sizes
      // derived from these numbers — which is the whole point of this file.
      expect(
        perSet,
        `${name}: start.gg now costs ${perSet.toFixed(2)} objects/set, above the assumed ${model.maxPerSet}. ` +
          `Re-derive the cost constants in server/src/routes/sets.ts before this starts rejecting requests.`
      ).toBeLessThanOrEqual(model.maxPerSet);
    }
  }, NETWORK_TIMEOUT_MS);

  it('still charges no more than the model assumes for a phase fed by pools', async () => {
    const fedPhaseGroupId = await progressionFedPhaseGroupId();
    if (!fedPhaseGroupId) {
      console.warn('[contract] found no multi-phase event to measure the expensive structure case against');
      return;
    }

    const r = await run(COST_MODEL.structure.query, { phaseGroupId: fedPhaseGroupId, page: 1, perPage: 20 });
    expect(r.error, `structure query failed: ${r.error}`).toBeNull();
    expect(r.sets).toBeGreaterThan(0);

    const populated = r.nodes.some(
      (n) => n.winnerProgressionSeed != null || (n.slots ?? []).some((slot) => slot.seed?.progressionSource != null)
    );
    if (!populated) {
      // Measuring here would just re-check the cheap case and look like proof.
      console.warn(`[contract] phase group ${fedPhaseGroupId} had no resolved progression; expensive case not measured`);
      return;
    }

    const perSet = (r.complexity! - COST_MODEL.structure.base) / r.sets;
    expect(
      perSet,
      `structure query costs ${perSet.toFixed(2)} objects/set on a progression-fed phase, ` +
        `above the assumed ${COST_MODEL.structure.maxPerSet}. Re-derive STRUCTURE_MAX_COST_PER_SET.`
    ).toBeLessThanOrEqual(COST_MODEL.structure.maxPerSet);
  }, NETWORK_TIMEOUT_MS);

  it('still rejects an oversized request the way the self-healing pager expects', async () => {
    // Deliberately far past the cap. The pager's recovery depends on both the
    // rejection happening and the message carrying the exact object count.
    const r = await run(COST_MODEL.structure.query, { phaseGroupId, page: 1, perPage: 5000 });

    expect(r.error, 'start.gg accepted a request that should exceed its object cap').not.toBeNull();
    expect(r.error).toMatch(/complexity/i);
    expect(
      r.error,
      'the rejection no longer carries "actual: N" — fetchSetsPaged cannot recompute a safe page size without it'
    ).toMatch(/actual:\s*\d+/i);
  }, NETWORK_TIMEOUT_MS);

  it('still reports the object cap we budget against', async () => {
    const r = await run(COST_MODEL.structure.query, { phaseGroupId, page: 1, perPage: 5000 });
    const stated = r.error?.match(/maximum of (\d+) objects/i);
    if (!stated) return; // wording changed; the assertions above already caught what matters
    expect(Number(stated[1]), 'start.gg changed its object cap').toBe(COST_MODEL.cap);
  }, NETWORK_TIMEOUT_MS);

  it('still hides bye sets unless asked, which is why the cascade query asks', async () => {
    // Load-bearing, and invisible if it ever changes: a losers-bracket slot
    // points at a bye set rather than at the winners set whose loser drops
    // into it. If phaseGroup.sets started including byes by default this test
    // would go quiet and nothing would break — but if the filter stopped
    // working, the teardown warning would silently understate what it clears,
    // which is the worst direction for that particular message to be wrong.
    const withByes = await run(COST_MODEL.cascade.query, { phaseGroupId, page: 1, perPage: 80 });
    expect(withByes.error, `cascade query failed: ${withByes.error}`).toBeNull();

    const withoutByes = await run(COST_MODEL.cascade.query.replace(/,\s*filters:\s*\{\s*showByes:\s*true\s*\}/, ''), {
      phaseGroupId,
      page: 1,
      perPage: 80,
    });
    expect(withoutByes.error).toBeNull();

    expect(
      withByes.sets,
      'showByes: true no longer returns more sets than the default — either this bracket has no byes, ' +
        'or start.gg changed the filter. Re-check server/src/resetCascade.ts before trusting the teardown warning.'
    ).toBeGreaterThan(withoutByes.sets);
  }, NETWORK_TIMEOUT_MS);

  it('still formats a completed set score the way the parser expects', async () => {
    const r = await run(COST_MODEL.live.query, { phaseGroupId, page: 1, perPage: 40 });
    expect(r.error).toBeNull();

    const completed = r.nodes.filter((n) => n.state === 3 && n.displayScore && n.displayScore !== 'DQ');
    expect(completed.length, 'no completed sets available to check the score format against').toBeGreaterThan(0);

    for (const set of completed) {
      const [a, b] = set.slots ?? [];
      const scores = parseDisplayScore(set.displayScore, a?.entrant?.name, b?.entrant?.name);
      expect(
        scores.every((s) => s !== null),
        `displayScore ${JSON.stringify(set.displayScore)} no longer parses for entrants ` +
          `${JSON.stringify([a?.entrant?.name, b?.entrant?.name])} — scores would silently disappear from the bracket`
      ).toBe(true);
    }
  }, NETWORK_TIMEOUT_MS);
});

// Short-URL resolution leans on start.gg's website routing rather than its
// API, because the API has no way to resolve one: tournament(slug:) conflates
// canonical slugs with short URLs and returns the canonical match when a
// string is both, and TournamentPageFilter has no slug field to query by.
// That makes the redirect load-bearing, and load-bearing assumptions about
// someone else's service belong in a check that fails when they drift.
/**
 * A phase with real pools in it, from some recent public tournament.
 *
 * Deliberately not the disposable test tournament: every phase there holds a
 * single pool, which measures at 2 objects/pool against a model that assumes
 * 9 — so it passes no matter how far the real cost drifts, which is a check
 * that cannot fail rather than a check that passes.
 */
async function multiPoolPhaseId(): Promise<string | null> {
  const { raw } = await post(
    `query{tournaments(query:{perPage:8,filter:{past:true,videogameIds:[1386]}}){nodes{` + `events(filter:{videogameId:[1386]}){phases{id groupCount}}}}}`,
    {}
  );
  try {
    const body = JSON.parse(raw) as {
      data?: { tournaments?: { nodes: { events?: { phases?: { id: number; groupCount: number }[] }[] }[] } };
    };
    const phases = (body.data?.tournaments?.nodes ?? []).flatMap((t) => (t.events ?? []).flatMap((e) => e.phases ?? []));
    const biggest = phases.filter((p) => (p.groupCount ?? 0) >= MIN_POOLS_TO_MEASURE).sort((a, b) => b.groupCount - a.groupCount)[0];
    return biggest ? String(biggest.id) : null;
  } catch {
    return null;
  }
}

// The pool-preview pager sizes its pages from a per-pool cost measured live on
// 2026-09-11. That number is exactly the kind that expires silently when
// start.gg adds a field, so it is asserted rather than commented.
/**
 * A phase group where sets actually carry character picks.
 *
 * Deliberately not the disposable test tournament: 19 of 20 sets there have no
 * games at all, which measures at ~1 object per set against a model assuming
 * 28 — a check that passes however far the real cost drifts.
 */
async function phaseGroupWithGamesId(): Promise<string | null> {
  const { raw } = await post(
    `query{tournaments(query:{perPage:6,filter:{past:true,videogameIds:[1386]}}){nodes{` +
      `events(filter:{videogameId:[1386]}){phaseGroups{id}}}}}`,
    {}
  );
  let candidates: number[] = [];
  try {
    const body = JSON.parse(raw) as {
      data?: { tournaments?: { nodes: { events?: { phaseGroups?: { id: number }[] }[] }[] } };
    };
    candidates = (body.data?.tournaments?.nodes ?? [])
      .flatMap((t) => t.events ?? [])
      .flatMap((e) => e.phaseGroups ?? [])
      .map((g) => g.id);
  } catch {
    return null;
  }

  for (const id of candidates.slice(0, 12)) {
    const probe = await post(COST_MODEL.setCharacters.query, { phaseGroupId: String(id), page: 1, perPage: 20 });
    try {
      const body = JSON.parse(probe.raw) as { data?: { phaseGroup?: { sets: { nodes: { games: unknown[] | null }[] } } | null } };
      const nodes = body.data?.phaseGroup?.sets?.nodes ?? [];
      // Enough long sets for a per-set average to mean something.
      if (nodes.filter((n) => (n.games ?? []).length >= 2).length >= MIN_SETS_WITH_GAMES) return String(id);
    } catch {
      // Treated the same as a phase group without games.
    }
  }
  return null;
}

// Per-game character picks are fetched once per completed set rather than on a
// clock, but the page size still comes from a measured per-set cost, and that
// measurement expires the moment start.gg charges differently for games.
describe.skipIf(!ENABLED)('start.gg set characters', () => {
  it('still charges no more per set than the cost model assumes', async () => {
    const phaseGroupId = await phaseGroupWithGamesId();
    if (!phaseGroupId) {
      // Measuring a phase with no games would re-check the empty case and look
      // like proof, which is the failure this file exists to prevent.
      console.warn(`[contract] found no phase group with >= ${MIN_SETS_WITH_GAMES} multi-game sets; per-set cost not measured`);
      return;
    }

    const { raw } = await post(COST_MODEL.setCharacters.query, { phaseGroupId, page: 1, perPage: 20 });
    const body = JSON.parse(raw) as {
      data?: { phaseGroup?: { sets: { nodes: unknown[] } } | null };
      errors?: { message: string }[];
      extensions?: { queryComplexity?: number };
    };
    expect(body.errors?.[0]?.message ?? null, 'set characters query failed').toBeNull();

    const sets = body.data?.phaseGroup?.sets?.nodes?.length ?? 0;
    expect(sets, 'set characters query returned no sets to measure').toBeGreaterThan(0);

    const perSet = (body.extensions!.queryComplexity! - COST_MODEL.setCharacters.base) / sets;
    expect(
      perSet,
      `per-game picks now cost ${perSet.toFixed(2)} objects/set, above the assumed ` +
        `${COST_MODEL.setCharacters.maxPerSet}. Re-derive SET_CHARACTERS_MAX_COST_PER_SET in ` +
        `server/src/routes/sets.ts before a long-set phase starts being rejected.`
    ).toBeLessThanOrEqual(COST_MODEL.setCharacters.maxPerSet);
  }, NETWORK_TIMEOUT_MS);
});

describe.skipIf(!ENABLED)('start.gg pool previews', () => {
  it('still charges no more per pool than the cost model assumes', async () => {
    const phaseId = await multiPoolPhaseId();
    if (!phaseId) {
      // Measuring a one-pool phase would re-check the cheap case and look
      // like proof, which is exactly the failure this file exists to prevent.
      console.warn(`[contract] found no phase with >= ${MIN_POOLS_TO_MEASURE} pools; per-pool cost not measured`);
      return;
    }

    const { raw } = await post(COST_MODEL.poolPreview.query, {
      phaseId,
      page: 1,
      perPage: 8,
      names: COST_MODEL.poolPreview.names,
    });
    const body = JSON.parse(raw) as {
      data?: { phase?: { phaseGroups?: { nodes: unknown[] } | null } | null };
      errors?: { message: string }[];
      extensions?: { queryComplexity?: number };
    };
    expect(body.errors?.[0]?.message ?? null, 'pool preview query failed').toBeNull();

    const pools = body.data?.phase?.phaseGroups?.nodes?.length ?? 0;
    expect(pools, 'pool preview query returned no pools to measure').toBeGreaterThan(0);
    expect(body.extensions?.queryComplexity, 'no complexity reported').not.toBeUndefined();

    const perPool = (body.extensions!.queryComplexity! - COST_MODEL.poolPreview.base) / pools;
    expect(
      perPool,
      `a pool preview now costs ${perPool.toFixed(2)} objects, above the assumed ` +
        `${COST_MODEL.poolPreview.maxPerPool}. Re-derive POOL_PREVIEW_COST_PER_POOL in ` +
        `server/src/routes/sets.ts before a phase with many pools starts being rejected.`
    ).toBeLessThanOrEqual(COST_MODEL.poolPreview.maxPerPool);
  }, NETWORK_TIMEOUT_MS);
});

describe.skipIf(!ENABLED)('start.gg reporting permission', () => {
  it('still shows tournament.admins to an admin, which is the whole permission signal', async () => {
    const { raw } = await post(
      `query Admins($slug: String!) {
        unfiltered: tournament(slug: $slug) {
          owner {
            id
          }
          admins {
            id
          }
        }
        filtered: tournament(slug: $slug) {
          admins(roles: ["*"]) {
            id
          }
        }
      }`,
      { slug: TOURNAMENT_SLUG }
    );
    const body = JSON.parse(raw) as {
      data?: {
        unfiltered?: { owner: { id: number } | null; admins: { id: number }[] | null } | null;
        filtered?: { admins: { id: number }[] | null } | null;
      };
    };

    expect(
      body.data?.unfiltered?.admins,
      'start.gg no longer shows tournament.admins to an admin of the tournament. canReport in ' +
        'server/src/routes/sets.ts reads that visibility as the permission itself, so every TO ' +
        'is now stuck on a read-only screen and cannot report at a venue.'
    ).not.toBeNull();

    // The trap, kept executable rather than only warned about in a comment:
    // `roles` filters by literal role name and has no wildcard, so asking for
    // "*" matches nothing and returns [] even to the owner. That is what put
    // every non-owner admin on a read-only screen.
    expect(
      body.data?.filtered?.admins,
      'admins(roles: ["*"]) now returns actual admins. The warning against adding a roles filter ' +
        'back to PHASE_GROUPS_QUERY in server/src/routes/sets.ts is out of date.'
    ).toEqual([]);
  }, NETWORK_TIMEOUT_MS);
});

describe.skipIf(!ENABLED)('start.gg bracket previews', () => {
  /**
   * An unstarted phase group whose previews already know their entrants — i.e.
   * a first phase, seeded from the entrant list rather than fed by another.
   *
   * Keep one unstarted event on the test tournament and this stays a real
   * check; without one it can only warn, because starting a bracket to test
   * starting a bracket consumes the thing being tested.
   */
  async function unstartedFirstPhaseGroup(): Promise<string | null> {
    const { raw } = await post(
      `query Unstarted($slug: String!) {
        tournament(slug: $slug) {
          events { phases { phaseGroups(query: { perPage: 8 }) { nodes { id state } } } }
        }
      }`,
      { slug: TOURNAMENT_SLUG }
    );
    const body = JSON.parse(raw) as {
      data?: { tournament?: { events?: { phases?: { phaseGroups?: { nodes?: { id: number; state: number }[] } }[] }[] } | null };
    };
    for (const event of body.data?.tournament?.events ?? []) {
      for (const phase of event.phases ?? []) {
        for (const group of phase.phaseGroups?.nodes ?? []) {
          if (group.state !== 1) continue;
          const probe = await post(
            `query Probe($id: ID!) { phaseGroup(id: $id) { sets(perPage: 1, page: 1) { nodes { id slots { entrant { id } } } } } }`,
            { id: String(group.id) }
          );
          const parsed = JSON.parse(probe.raw) as {
            data?: { phaseGroup?: { sets?: { nodes?: { id: string | number; slots: { entrant: { id: number } | null }[] }[] } } | null };
          };
          const set = parsed.data?.phaseGroup?.sets?.nodes?.[0];
          if (set && typeof set.id === 'string' && set.slots.every((slot) => slot.entrant != null)) {
            return String(set.id);
          }
        }
      }
    }
    return null;
  }

  it('still ids an unmaterialised set the way the report route parses it', async () => {
    const previewSetId = await unstartedFirstPhaseGroup();
    if (!previewSetId) {
      console.warn(
        `[contract] no unstarted first-phase group on "${TOURNAMENT_SLUG}" to check preview sets against. ` +
          'Create an event there and leave its bracket unstarted to make this a real check.'
      );
      return;
    }

    // report.ts reads the phase group out of this id to find the real set a
    // spent preview became. A format change silently breaks that recovery.
    expect(
      previewSetId,
      `start.gg changed how it ids an unmaterialised set (${previewSetId}). previewPhaseGroupId in ` +
        'server/src/routes/report.ts parses the phase group out of it, and a retry of a preview ' +
        'report cannot find the real set without it.'
    ).toMatch(/^preview_\d+_-?\d+_\d+$/);

    // And it has to be readable by id, because the route reads every set
    // before writing to it.
    const { raw } = await post(`query Preview($setId: ID!) { set(id: $setId) { id state slots { entrant { id } } } }`, {
      setId: previewSetId,
    });
    const body = JSON.parse(raw) as { data?: { set?: { id: string; slots: { entrant: { id: number } | null }[] } | null } };
    expect(
      body.data?.set,
      `start.gg no longer resolves a preview set by id (${previewSetId}), so the report route cannot ` +
        'check one before reporting it and reporting into an unstarted bracket is broken.'
    ).not.toBeNull();
  }, NETWORK_TIMEOUT_MS);
});

describe.skipIf(!ENABLED)('start.gg short URLs', () => {
  it('redirects a short URL to its canonical tournament slug', async () => {
    expect(await resolveShortUrl(TOURNAMENT_SLUG)).toBe('definitely-real-tournament');
  }, NETWORK_TIMEOUT_MS);

  it('still resolves a canonical slug typed without the tournament/ prefix', async () => {
    expect(await resolveShortUrl('definitely-real-tournament')).toBe('definitely-real-tournament');
  }, NETWORK_TIMEOUT_MS);

  it('reports nothing for a slug start.gg does not know', async () => {
    expect(await resolveShortUrl('smashset-canary-not-a-real-slug-38fa1c')).toBeNull();
  }, NETWORK_TIMEOUT_MS);
});

describe.skipIf(!ENABLED)('start.gg OAuth refusals', () => {
  /**
   * The assumption the refresh path is built on, and the one that made a
   * failed refresh look like a successful one for as long as it did: start.gg
   * does not report an OAuth refusal the way HTTP does. A rejected refresh
   * token comes back **200** with the reason as a bare JSON string, and bad
   * client credentials come back 500 the same way — so `res.ok` cannot be used
   * to tell success from failure here, and startggOAuth.ts checks the body's
   * shape instead.
   *
   * What must stay true is only this: a refusal never arrives token-shaped.
   * Deliberately uses a throwaway refresh token, so it spends nothing and
   * needs no OAuth credentials of its own — which is also why it tolerates
   * either status.
   */
  it('never answers a refusal with something shaped like a token', async () => {
    const res = await fetch('https://api.start.gg/oauth/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: process.env.STARTGG_OAUTH_CLIENT_ID ?? 'contract-test-no-such-client',
        client_secret: process.env.STARTGG_OAUTH_CLIENT_SECRET ?? 'contract-test-no-such-secret',
        grant_type: 'refresh_token',
        refresh_token: 'contract-test-not-a-real-refresh-token',
      }),
    });
    const raw = await res.text();

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = raw;
    }
    const tokenShaped =
      typeof parsed === 'object' &&
      parsed !== null &&
      typeof (parsed as { access_token?: unknown }).access_token === 'string';

    expect(
      tokenShaped,
      `start.gg answered a refusal with a token-shaped body (${res.status}): ${raw.slice(0, 200)}. ` +
        'refreshAccessToken in server/src/startggOAuth.ts tells success from failure by that shape.'
    ).toBe(false);
  }, NETWORK_TIMEOUT_MS);
});
