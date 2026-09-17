# smashset

Fast set reporting for start.gg tournament organizers. A TO stands at a venue with a phone, finds
the set that just finished, types a score, moves on. Speed and correctness at a bracket table are
the whole product; anything that slows down "report this set in five seconds" is a regression.

Stack: React + TypeScript (Vite) in `web/`, Express + TypeScript in `server/`, Postgres via `pg`,
vitest both sides. Everything tournament-shaped is proxied from the start.gg GraphQL API using the
signed-in user's own OAuth token. Deployed on Railway; `main` auto-deploys to smashset.gg.

## How I want to work

This project is real, but it's also me deliberately practising professional engineering by doing it
rather than reading about it. So treat process as part of the work, not overhead.

**Hold me to it.** AI-speed development makes it very easy to skip the boring parts, and I will
forget. Don't wait to be asked for tests, verification, or a migration plan — do them by default. If
you're skipping a step on purpose, say which one and why, rather than going quiet.

**Name the practice.** When something is a standard technique — a deploy gate, a canary, a
contract test, a feature flag, staged rollout, a generation guard — say so in a line. I'm trying to
pick up the vocabulary and the reasoning, not just the diff.

**Tell me when I'm wrong,** including when a practice I asked for wouldn't actually help. A ranked
honest recommendation beats a cargo-culted yes. I don't mind slight over-engineering when it buys
real quality, and I'd rather hear the tradeoff than have it decided silently.

Keep the tone light. Rigour in the engineering, not in the prose.

## Verification

**A green suite is not evidence the feature works.** This bit us hard: 43 real bugs shipped behind
146 passing tests, because every mock resolved and no test could express failure. So:

- `npm run verify` at the root runs both typechecks and both suites. Use it before calling something
  done, and `npm run build` on top — vitest transpiles without typechecking, so a type error in a
  test file is invisible to the suite it lives in.
- **Web must typecheck with `tsc -b`, never `tsc --noEmit`.** `web/tsconfig.json` is a solution file
  (`"files": []` plus references), so `tsc --noEmit` on it compiles zero files and exits 0 no matter
  what. That is not a stricter-config difference — it is the check doing nothing at all, which it did
  unnoticed until a test importing `node:fs` sailed through verify and broke the build.
- Server tests need a disposable Postgres — they delete rows, and they used to point at production.
  `.env.test` overrides `DATABASE_URL` for tests only (see `.env.test.example`), and `test-setup.ts`
  refuses to run against a non-local host unless `ALLOW_REMOTE_TEST_DB=1`. Set up with
  `createdb smashset_test` then `npm run migrate`.
- When you add a test for a bug, **check it fails against the broken code first.** A regression test
  that passes either way is worse than none.
- Cover the failure path, not just the happy path. `web/src/test-helpers.ts` exists for this —
  `apiFailure()` for a request that fails, `flushTimers()` for polling under fake timers.
- If behaviour depends on start.gg, verify against the real API, not only mocks. The key is in the
  root `.env` as `STARTGG_API_KEY`. `start.gg/fireslam23test` ("Definitely Real Tournament") is a
  disposable bracket with synthetic entrants — safe to mutate for testing.
- UI changes get checked in a browser before being called done. If that's not possible, say so
  explicitly instead of implying it was tested.

**Measurements against external APIs go stale.** A number derived from a real measurement belongs in
a check that fails when it drifts, not in a comment asserting it's safe — a stale constant with a
confident comment next to it is exactly how the query-complexity outage happened. See
`.github/workflows/startgg-canary.yml`.

## Conventions

- Minimal, targeted changes. No speculative abstraction, no backwards-compat shims, no half-built
  features. Three similar lines beat a premature helper.
- Comments explain **why**, never what. Most code needs none.
- **Fail loudly on impossible states rather than papering over them.** A fallback on something that
  "can't happen" turns a bug into a wrong result instead of a stack trace. Throw or assert instead.
  Real handling belongs at real boundaries — user input, start.gg, the database — and there it must
  be reachable and visible: a failed phase-groups fetch once caught its error, set `loadError`, and
  rendered a screen that didn't display it, stranding the TO on a blank page forever.
- For a TO mid-tournament, **no score is recoverable; a wrong score is not** — they might report it.
  Prefer showing nothing over showing something plausible. That's why `parseDisplayScore` returns
  nulls for a DQ instead of guessing.
- Prefer fixing the root cause over widening a `try`.

## start.gg gotchas

These cost real time to discover; don't re-derive them.

- Query cost is **per object returned**, not per field and not per requested `perPage`.
  `entrant { id }` and `entrant { id name }` cost the same. Scalars on a node are ~free. The cap is
  1000 objects per request, and exceeding it is a hard rejection.
- That's why the bracket fetch is split: a cheap scalar-heavy "live" query that gets polled, and an
  expensive "structure" query for cross-phase wiring on a slow clock.
- `Set.totalGames` is a static per-phase default (often just 5), **not** what a given set actually
  played. Derive Bo-X from the winner's real win count.
- A DQ comes back as the bare string `"DQ"` in `displayScore`, with no names and no numbers.
- Entrant names contain `|`, `.`, `?`, spaces — and often end in digits (`Curve_Ball917`), so never
  parse a score string by splitting on a separator.
- Rate limit is roughly 80 requests/minute **per token**, so server-side polling on one user's token
  doesn't scale to many TOs.
- `tournament.admins` is **null** for a non-admin and a list for an admin — that visibility *is* the
  permission, so read the null-vs-list distinction rather than searching the list for the user.
- `admins(roles: [...])` filters by **literal role name and has no wildcard**. `roles: ["*"]` matches
  nothing and returns `[]` even to the tournament's owner, which is how every non-owner admin ended
  up on a read-only screen. Ask for `admins` bare.

## Git

- Commit and push when a unit of work is done and verified — no need to ask.
- Name files explicitly when staging. Never `git add -A` or `git add .`.
- New commits, never amend or force-push. Never skip hooks.
- `main` auto-deploys to production, and CI gates it. A red build means it doesn't ship.
