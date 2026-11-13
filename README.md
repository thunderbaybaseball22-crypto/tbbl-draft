# TBBL Live Draft

A live fantasy-baseball draft site for a 24-team dynasty league. The commissioner runs the draft; each owner logs in with their email and picks when their pick is on the clock.

It is a static website (no server to run) that stores data in Google Firebase's free Spark plan: Authentication (email + password), Firestore (database), Hosting (web address).

## What it does

- Draft order comes from a CSV (round, pick in round, overall, original team, current team). The order is exactly what the file says.
- Players come from a CSV (player name, unique ID, team code; blank team = available).
- Pick clock: 1 hour per pick to start (commissioner can change it). The clock only runs 11:00 AM to 11:00 PM Eastern, every day, and is DST-aware. Outside that window it is paused.
- When a clock runs out the pick is skipped and the next pick goes on the clock. The skipped owner can make that pick any time later.
- Owners can only pick for teams that currently own the pick. Owners keep a private draft list (players and write-ins) with an Auto-draft On/Off switch: when On and their pick comes up, the first available player on the list is drafted. It never picks best-available; if the list runs out the normal clock and skip rules apply.
- Commissioner: start/pause/resume, pick for anyone, undo a pick, trade a pick (original owner is kept, everything is written to an audit log), replace a player on a pick, change the clock length, export CSV.
- Write-in picks for players not in the pool (name + link or note; counts immediately; commissioner confirms, edits or rejects; separate "new players to create" export).
- Player file understands the league's conventions: PUID -1 + AAA is valid, -1/AAA rows merge into a matching real-ID row, MLB / Non-MLB filter. Files can be re-checked and replaced before the draft without redeploying.
- Player stats: import the hitters and pitchers rating files (`TBBLPlayerRatings_*.csv`) and the Players tab shows sortable stat columns with a Hitters / Pitchers switch.
- Board, searchable/sortable/filterable player pool, per-team rosters, pick history, CSV export.

## Folders

| Path | What |
| --- | --- |
| `public/` | The website (this is what gets deployed) |
| `public/js/lib/` | Draft rules, clock, CSV, queue: pure logic with automated tests |
| `public/sample/` | Clearly fake sample CSVs (players, draft order, owners) |
| `public/demo.html` | Offline demo of pick / skip / late pick / trade / undo (no Firebase) |
| `tests/` | Automated tests (`npm test`, needs Node) |
| `firestore.rules`, `firebase.json` | Firebase security rules and hosting settings |
| `docs/` | Guides |
| `tools/` | Script that regenerates the sample CSVs |

## Guides

- [Setup and deploy](docs/SETUP-DEPLOY.md) (one-time)
- [Commissioner guide](docs/COMMISSIONER-GUIDE.md)
- [Owner guide](docs/OWNER-GUIDE.md)
- [Unattended ticker](docs/TICKER.md) (skips and auto-draft with no page open)
- [Demo results](docs/DEMO-RESULTS.md)

## Tests

`npm test` runs the Node built-in test runner over `tests/` (no packages to install). See `docs/DEMO-RESULTS.md` and `.agents/tasks/tbbl-draft/coder-notes.md` for the status of the last run.

## Secrets

Nothing secret is stored in this repo. The Firebase web config you paste into `public/js/firebase-config.js` identifies your project but is not a password (and that file is git-ignored). Never put a service-account key in this folder. Real league files (`PlayerFile.csv`, `OwnerEmails.csv`) are git-ignored; don't commit them.
