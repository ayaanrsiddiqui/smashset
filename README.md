# SmashSet

Fast, keyboard-driven set reporting for start.gg tournament organizers.
Sign in with start.gg, search by the winner's tag, type a score shorthand,
tag characters and stages, done — hands never leave the keyboard.

**Live at [smashset.gg](https://smashset.gg).**

Reporting a set with full game and character data through start.gg's own UI
means switching between the mouse and the keyboard a dozen times; a practised
TO gets it down to roughly 15–20 seconds. SmashSet is built around never
making that switch. In live use it lands around 5–10 seconds a set, which is
about as long as the winner takes to say the score out loud.

## Status

Run at two collegiate locals so far, roughly three hours of live reporting
each, with the search → score → characters → report loop used for real sets
against real brackets. Currently being rolled out to other organizers.

It works, and it is still early: expect rough edges outside the main path,
and see the limitations at the bottom.

## How it works

SmashSet reports **as you**, not as a service account. You sign in through
start.gg's own OAuth consent screen, and every mutation goes out on your
access token — so it can only touch sets you could already report by hand.
The app asks for two scopes and no more:

| Scope | Why |
| --- | --- |
| `user.identity` | to know who signed in |
| `tournament.reporter` | to report sets |

Your start.gg tokens are encrypted at rest with AES-256-GCM. Sessions are
256-bit random ids in an `httpOnly`, signed, `sameSite=lax` cookie, with
expiry enforced in SQL rather than in application code.

---

## Using it

Sign in, then paste a start.gg event URL or slug to load a bracket. Any of
these work:

- a full URL — `https://start.gg/tournament/x/event/y`
- an event slug — `tournament/x/event/y`
- a bare tournament slug or short URL — `fireslam23test`

A tournament with several events asks which one. An event with several pools
asks which pool, and the pool picker has a **Find a player…** box that tells
you which pool someone is in. Everything after that is keyboard-driven.

The header has a **?** button for the full notation guide, which includes four
worked examples replayed keystroke by keystroke, and an **account** button for
your preferences.

### Search

- `/` — focus the search box, then type part of the winner's tag.
- If the top result is right, `Enter` reports it straight away. Otherwise
  results are labeled `1`–`9` — press a number to jump straight to one (as
  long as you're not currently typing in a text field).
- `Tab` switches between the open sets and the completed ones, newest first.
  Selecting a completed set reopens it for correction, pre-filled with what
  start.gg has on record.
- Clicking a result works too, as does clicking a set in the bracket. Whoever
  matched your search is pre-selected as the winner.

Queries shorter than three characters are refused rather than run: filtering
a 1,500-entrant event by `a` matches most of it, which is all noise and all
rate limit.

### Reporting a set

The main display — every game up to the current Bo format (5 rows for Bo5,
even before you've typed anything) — is focused by default as soon as the
set opens, and any tool below can be refocused at any time by pressing its
letter (as long as you're not mid-type in another field — `Escape` backs out
one level first).

- Game-by-game score, from the winner's perspective, typed directly into the
  main display — there's no separate text box for it. Four interchangeable
  ways to type it, live-filling the rows as you go and graying out whichever
  trailing rows the set didn't need (e.g. row 5 in a 3–1 Bo5):
  - digits: `124` (winner won games 1, 2, 4) or `-3` (winner lost only game 3)
  - letters: `w` / `l` per game, e.g. `wwlw`
  - arrow keys: `←` = win, `→` = loss (`↑`/`↓` move between rows instead, to
    focus one and correct it)
  - `+`, `-`, or `0` alone — a clean sweep sized to the current Bo (`2-0`
    for Bo3, `3-0` for Bo5, …)
  - `Backspace` corrects a mistake; `g` explicitly refocuses it (e.g. after
    switching to `q` for a quick score and back)
- **`q`** — quick score with no per-game detail, e.g. `3-1`. Use this when
  you only know the final score.
- **`b`** or **`bo`**, then an odd number — set the best-of format (Bo1,
  Bo3, Bo5, Bo7, …). start.gg doesn't expose this directly, so it's guessed;
  override it here when the guess is wrong.
- **`f`** — flip the winner. The winner is always shown on the left; `f` swaps
  only the two players' *names*. Everything you've already entered — game
  results, characters, stages — stays put in the winner/loser columns it was
  entered into, so a `124` and a Fox pick you typed for the winner now both
  belong to whoever `f` just made the winner. That's the intended correction
  for the common case: you heard the games and characters right, you just had
  the wrong person selected as the winner.
- **`c`** — characters. Then `w` or `l` for a side, then `a` (all games) or
  a game number, then type a character name (fuzzy-matched, aliases included
  — `gnw` finds Mr. Game & Watch) and `Enter`. Stack digits to target several
  games at once. You can jump straight between sides and games without
  re-pressing `c` — e.g. `c w a Sonic ⏎ l a Fox ⏎ 3 Samus ⏎` sets the
  winner's character for every game, the loser's for every game, then
  overrides just game 3.
  **`m`** fills in both players' mains (see below).
- **`s`** — stages. Press a game number, type the stage name, `Enter`.
- **`Enter`** — report the set. The button becomes a ✓ / ✕ confirmation;
  `Enter` again confirms, `Escape` cancels. Nothing is sent before that second
  `Enter`, and any other key there cancels, so a stray keystroke can't report
  a set by accident.
- **`Escape`** — leave without submitting. The back link becomes a
  confirmation with a back arrow and "stay"; `Escape` again leaves, any
  other key stays.

### Mains

`m` fills in both players' main characters. A player's main is computed in the
background from their recent start.gg set history for the current game — which
entrant is them is resolved by player id, not by tag, and a tie goes to
whichever character got there through more recent sets, so someone who
switched mains last month resolves to the new one.

If what's on file is wrong or missing, it can be corrected right above the
"All games" row. That correction is remembered for every future set that
player is in, not just this report.

### Bo5 cutoffs

start.gg's API doesn't expose a set's best-of format. The **Top X = Bo5**
preference in the account panel is the good lever: any set whose loser would
finish at or above that placement auto-selects Bo5, using the placement
start.gg computes for that specific set — so it holds up across pools,
redemption brackets, or anything else that isn't a plain bracket. It's saved
to your account and applies to every event you run.

Leave it blank to fall back to the plain Grand-Final-only guess. `b`/`bo`
always overrides both, for one set.

---

## Development

```
npm run install:all
npm run migrate          # apply the schema to your local database
npm run dev
```

`npm run dev` starts the API server on `:3001` and the web app on `:5173`
(which proxies `/api/*` to the server). Open `:5173`.

### Environment

The server reads `.env` at the repo root and refuses to start if any of these
is missing:

| Variable | What it is |
| --- | --- |
| `STARTGG_OAUTH_CLIENT_ID` | from your start.gg OAuth application |
| `STARTGG_OAUTH_CLIENT_SECRET` | same |
| `TOKEN_ENCRYPTION_KEY` | 32 bytes as 64 hex chars — `openssl rand -hex 32` |
| `SESSION_SECRET` | any long random string; signs session cookies |
| `DATABASE_URL` | your **local** Postgres |
| `APP_BASE_URL` | `http://127.0.0.1:3001` in development |

In development, also set `FRONTEND_URL=http://127.0.0.1:5173` — Vite and
Express run on different origins locally, and that's what the OAuth callback
redirects back to. In production the server serves the built front end itself,
so `FRONTEND_URL` is ignored there even if it's set.

start.gg ties an OAuth application to a single redirect URI, so local
development and production need **two separate start.gg applications**. Put the
dev application's credentials in `DEV_STARTGG_OAUTH_CLIENT_ID` and
`DEV_STARTGG_OAUTH_CLIENT_SECRET`; they take precedence whenever
`NODE_ENV !== 'production'`, so both sets can live in one `.env` without
colliding. The callback to register for the dev app is
`http://127.0.0.1:3001/api/auth/callback`.

`DATABASE_URL` should point at a local database. Both the migrate CLI and the
test suite write and delete rows, and both read `DATABASE_URL` by default, so
each refuses a non-local host unless told otherwise — `ALLOW_REMOTE_MIGRATE=1`
for migrations, `ALLOW_REMOTE_TEST_DB=1` for tests. `npm run migrate` also
prints which host it is about to change before changing it.

### Checks

```
npm run verify     # typecheck + tests
npm test           # server and web suites
npm run typecheck
```

The schema is owned by `node-pg-migrate`; migrations live in
`server/migrations/`. The server does **not** migrate at boot — a deploy that
can't migrate should fail before serving traffic rather than start against a
schema it disagrees with. `npm run migrate` applies pending migrations locally;
`npm run migrate:down --prefix server` rolls back one, deliberately one at a
time. Production migrates as Railway's pre-deploy command.

### CI

`.github/workflows/ci.yml` runs on every push and pull request: install,
migrate, typecheck, test against an ephemeral `postgres:16` service container,
then build. The production build runs separately from the typecheck because
Vite's `tsc -b` uses a different config from `tsc --noEmit` and can fail where
the typecheck passed. Railway's "Wait for CI" is on, so a red run doesn't
reach smashset.gg.

`.github/workflows/startgg-canary.yml` is separate and deliberately **not** part
of CI. Every test in the main suite mocks start.gg, so none of them can notice
start.gg changing underneath us — which is exactly the failure that once took
the bracket down. The canary talks to the real API on a daily schedule and
re-checks the assumptions the app is built on: how much each query costs per
row, that an oversized request is still rejected with a parseable object count,
and that a completed set's score string still parses. It alerts rather than
gates, because start.gg being down is not a reason to block a merge. It needs
`STARTGG_API_KEY` as a repository secret — a personal access token, used only
by the canary and not by the app.

### Query cost

start.gg rejects any request whose response would exceed 1,000 objects, and it
charges per object rather than per field — `entrant { id }` and
`entrant { id name }` cost the same, but a nested object is another object.
Page size is therefore the lever, and it is derived from a declared
cost-per-row rather than hardcoded: `fetchSetsPaged` reads the cost start.gg
reports on each response, ratchets its own estimate upward, and on a rejection
parses the actual object count out of the error and resizes itself.

If you add fields to one of the bracket queries, check the constants at the top
of `server/src/routes/sets.ts`. The canary will tell you if they've drifted, but
it tells you the morning after.

---

## Notes / known limitations

- The best-of format is a guess unless you set a Top X cutoff or override with
  `b`/`bo`. See above.
- Search covers sets that aren't yet completed and have both entrants
  determined — no byes or TBDs. It doesn't auto-call the next set or take
  player self-reported scores yet.
- Reports go straight to the live bracket. There's no undo, but a completed
  set can be reopened from the `Tab` pile and re-reported, which is the
  correction path. If you're setting it up for the first time, point it at a
  test event and send one report through before running a real tournament on
  it.
- The bracket loads at most 700 sets for a pool. Larger ones are truncated with
  a warning in the server log.
- Cross-phase bracket wiring (which pool a slot was fed from) is decoration: if
  that query fails, the bracket still renders without it.
