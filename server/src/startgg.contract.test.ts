import { beforeAll, describe, expect, it } from 'vitest';
import { COST_MODEL } from './routes/sets.js';
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
const ENABLED = process.env.RUN_CONTRACT_TESTS === '1' && !!process.env.STARTGG_API_KEY;
const ENDPOINT = 'https://api.start.gg/gql/alpha';
// Generous on purpose: a rate-limited attempt waits out the limit (see post()),
// which is far past vitest's 5s default.
const NETWORK_TIMEOUT_MS = 180_000;

// Ayaan's own disposable test tournament — synthetic entrants, safe to read
// and safe to mutate. Resolved by slug rather than by id so the canary
// survives the bracket being rebuilt.
const TOURNAMENT_SLUG = 'fireslam23test';

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
  const { status, raw } = await post(
    `query($slug:String!){tournament(slug:$slug){events{id phaseGroups{id sets(page:1,perPage:1){pageInfo{total}}}}}}`,
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
