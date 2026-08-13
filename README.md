# quickset

Fast set reporting for start.gg tournament organizers. Search by the winning
player's name, type a score shorthand, pick characters, done.

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

1. Paste a start.gg event URL or slug (`tournament/x/event/y`) once to load
   the bracket.
2. Press `/` to focus search, type part of the winner's name, arrow keys +
   Enter to pick the set (or click it). The app pre-selects whoever matched
   your search as the presumed winner — flip it with one click if wrong.
3. Pick Bo1/Bo3/Bo5 if the default guess is wrong (only "Grand Final" in the
   round text defaults to Bo5).
4. Type the score shorthand, from the winner's perspective:
   - `124` — winner won games 1, 2, 4 (lost game 3)
   - `-3` — winner lost only game 3
   Both describe the same 3-1, W‑W‑L‑W result. The live preview under the
   box shows the resulting score and game-by-game sequence as you type.
5. Optionally set each player's character (applies to the whole set) or
   check "character changed mid-set" for a per-game breakdown.
6. Report set. You're dropped back at search with the list refreshed.

## Notes / known limitations

- start.gg's API doesn't expose a set's best-of format directly, so the
  Bo1/Bo3/Bo5 toggle is a heuristic (Grand Final → Bo5, else Bo3) — confirm
  it before typing the shorthand if a bracket doesn't follow that pattern.
- Search only looks at sets whose state isn't "completed" and that have
  both entrants determined (no byes/TBDs) — it does not yet auto-call the
  next set or accept player self-reported scores; those are still on the
  roadmap.
- The `reportBracketSet` mutation shape (particularly the per-game
  `selections` field for characters) was assembled from start.gg's public
  docs, not verified against a live event yet — test a report against a
  disposable/test bracket before relying on it during a real tournament.
