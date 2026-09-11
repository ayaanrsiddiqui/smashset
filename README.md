# SmashSet

Fast, keyboard-driven set reporting for start.gg tournament organizers.
Search by the winner's tag, type a score shorthand, tag characters and
stages, done — hands never leave the keyboard.

Reporting a set with full game and character data through start.gg's own UI
means switching between the mouse and the keyboard a dozen times; a practised
TO gets it down to roughly 15–20 seconds. SmashSet is built around never
making that switch. In live use it lands around 5–10 seconds a set, which is
about as long as the winner takes to say the score out loud.

## Status

Run at two collegiate locals so far, roughly three hours of live reporting
each, with the search → score → characters → report loop used for real sets
against real brackets. It works, and it is still early: expect rough edges
outside that path, and see the limitations at the bottom.

## Setup

```
npm run install:all
npm run dev
```

This starts the API server on `:3001` and the web app on `:5173` (proxies
`/api/*` to the server). Open `:5173` in a browser tab at the TO desk.

The server reads `STARTGG_API_KEY` from the `.env` file at the repo root —
a start.gg personal access token (Developer Settings → Create new token).

## Using it

Paste a start.gg event URL or slug (`tournament/x/event/y`) once to load the
bracket. Everything after that is keyboard-driven.

The "Top X = Bo5" field in the header sets a tournament-wide cutoff: any set
whose loser would finish at or above that placement auto-selects Bo5, using
start.gg's own placement data for the set (so it holds up across pools,
redemption brackets, or anything else that isn't a plain bracket). Leave it
blank to fall back to the plain Grand-Final-only guess. It's saved per event,
and the `b`/`bo` tool always overrides it for one set.

### Search

- `/` — focus the search box, then type part of the winner's tag.
- If the top result is right, `Enter` reports it straight away. Otherwise
  results are labeled `1`–`9` — press a number to jump straight to one (as
  long as you're not currently typing in a text field), or use the arrow
  keys.
- Clicking a result works too. Whoever matched your search is pre-selected
  as the winner.

### Reporting a set

The main display — every game up to the current Bo format (5 rows for Bo5,
even before you've typed anything) — is focused by default as soon as the
set opens, and any tool below can be refocused at any time by pressing its
letter (as long as you're not mid-type in another field — `Escape` backs out
one level first).

- Game-by-game score, from the winner's perspective, typed directly into the
  main display — there's no separate text box for it. Four interchangeable
  ways to type it, live-filling the rows as you go and graying out whichever
  trailing rows the set didn't need (e.g. row 5 in a 3-1 Bo5):
  - digits: `124` (winner won games 1, 2, 4) or `-3` (winner lost only game 3)
  - letters: `w` / `l` per game, e.g. `wwlw`
  - arrow keys: `↑`/`←` = win, `↓`/`→` = loss
  - `+`, `-`, or `0` alone — a clean sweep sized to the current Bo (`2-0`
    for Bo3, `3-0` for Bo5, ...)
  - `Backspace` corrects a mistake; `g` explicitly refocuses it (e.g. after
    switching to `q` for a quick score and back)
- **`q`** — quick score with no per-game detail, e.g. `3-1`. Use this when
  you only know the final score.
- **`b`** or **`bo`**, then an odd number — set the best-of format (Bo1,
  Bo3, Bo5, Bo7, ...). start.gg doesn't expose this directly, so it's
  guessed: Grand Final → Bo5, else Bo3, unless the "Top X = Bo5" field in
  the header (see below) says otherwise — override it if the guess is wrong.
- **`f`** — flip the winner. The winner is always shown on the left; `f` swaps
  only the two players' *names*. Everything you've already entered — game
  results, characters, stages — stays put in the winner/loser columns it was
  entered into, so a `124` and a Fox pick you typed for the winner now both
  belong to whoever `f` just made the winner. That's the intended correction
  for the common case: you heard the games and characters right, you just had
  the wrong person selected as the winner.
- **`c`** — characters. Then `w` or `l` for a side, then `a` (all games) or
  a game number, then type a character name (fuzzy-matched, same as
  search) and `Enter`. You can jump straight between sides/games without
  re-pressing `c` — e.g. `c w a Sonic Enter l a Fox Enter 3 Samus Enter` sets
  the winner's character for every game, the loser's for every game, then
  overrides just game 3. `m` fills in both players' main character, computed
  automatically in the background from each player's recent start.gg history
  for the current game (falling back to a small hardcoded list in
  `web/src/mains.ts` for players with no computable main yet). Wrong or
  missing data on file for a player can be corrected right above the "All
  games" row — that correction is remembered for every future set they're in,
  not just this report.
- **`s`** — stages. Press a game number, type the stage name, `Enter`.
- **`Enter`** — report the set. The button becomes a ✓ / ✕ confirmation;
  `Enter` again confirms, `Escape` cancels.
- **`Escape`** — leave without submitting. The back link becomes a
  confirmation with a back arrow and "stay"; `Escape` again leaves, any
  other key stays.

## Notes / known limitations

- start.gg's API doesn't expose a set's best-of format directly. The default
  guess is Grand Final → Bo5, else Bo3. The "Top X = Bo5" header field is the
  better lever, since it keys off the placement start.gg computes for the
  set's loser rather than the round's name — override either with `b`/`bo`
  plus an odd number when a bracket doesn't follow the usual pattern.
- Search covers sets that aren't yet completed and have both entrants
  determined — no byes or TBDs. It doesn't auto-call the next set or take
  player self-reported scores yet.
- The bracket view doesn't yet mirror start.gg's bracket structure — sets are
  found by searching, not by browsing a tree.
- Reports go straight to the live bracket with no undo inside SmashSet. A
  mistake is fixed on start.gg like any other misreport. If you're setting it
  up for the first time, point it at a test event and send one report through
  before running a real tournament on it.
