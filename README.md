# Retro Rewind Stats

A static GitHub Pages dashboard for Retro Rewind / Mario Kart Wii network statistics. The site reads the public Retro WFC API directly; it does not invent sample numbers and it does not require a database, API key, backend server, or build step.

## Dashboard

- **Live rooms:** room IDs, public/private and joinable state, room type, current course, engine class, average VR, open-host details, and each room's player list with VR / BR.
- **Network population:** live player and room counts, recent population history, daily peaks where RWFC exposes them.
- **Race archive:** paginated race results with room, race number, timestamp, track, engine class, mode, and the full returned participant order.
- **Player records:** searchable VR leaderboard, rank, 24-hour movement, last seen, and individual player dossiers.
- **VR history:** player history chart and 30-day change feed where the player's public history is available.
- **Race performance:** each player's tracked races, character and vehicle selections, exact combos, win rate, track performance, finish distribution, and kart / bike split.
- **Global meta:** character pick rates, vehicle usage, character + vehicle combo usage, character / vehicle / combo win rates, track frequency, most active players, day-of-week and hourly activity.
- **Time trials:** per-track world records and ranked ghost submissions, 3-lap and fastest-lap boards, 150cc / 200cc, retro / custom, glitch, shroomless, kart and bike filters, record-history timelines, TT player profiles, ghost-file downloads when available, and CSV export.
- **Local watchlist:** save players in this browser, plus CSV export for the race page.

## Data sources

Primary source: [Retro WFC](https://rwfc.net/).

This site uses the documented public RWFC web API, including:

- `/api/roomstatus`, `/api/roomstatus/stats`, `/api/roomstatus/analytics`
- `/api/leaderboard`, `/api/leaderboard/player/{friendCode}`, `/api/leaderboard/player/{friendCode}/history`
- `/api/racestats/global`, `/api/racestats/races`, `/api/racestats/player/{pid}`, and the player's analytics endpoint
- `/api/timetrial/tracks`, `/api/timetrial/leaderboard`, `/api/timetrial/leaderboard/flap`, `/api/timetrial/worldrecords/all`, `/api/timetrial/worldrecord/history`, and `/api/timetrial/profile/{id}`

The official RWFC backend enables cross-origin read access for its production frontend API. The site polls live room data every 20 seconds and refreshes aggregate/race summaries every 60 seconds. Searches and pagination load additional pages on demand.

## Publish with GitHub Pages

GitHub Pages is configured to publish the repository root from `main`. GitHub's Pages build-and-deployment workflow runs automatically when new commits are pushed to that branch. Keep **Settings → Pages → Build and deployment** set to **Deploy from a branch**, branch `main`, folder `/(root)`.

Expected URL: [https://nvd123-YT.github.io/rr-stats/](https://nvd123-YT.github.io/rr-stats/).

## Accuracy and limitations

- The dashboard displays what RWFC's public API returns. It cannot see races, players, private console telemetry, or historical results that RWFC does not publish or retain.
- Live room lists and player counts are snapshots, not a packet-level feed. The displayed refresh cadence is the dashboard's polling cadence, not a guarantee about upstream update latency.
- Race history, character/vehicle usage, and win rates are based on the official RWFC recorded race-result database. A player or race absent from that database cannot be reconstructed by this static site.
- VR and room history depth depends on the history available from RWFC.
- Favorites are stored in the current browser only. There is no account system and no data is uploaded by the watchlist feature.

## Attribution

Retro Rewind Stats is an independent community dashboard. Retro Rewind and Retro WFC are third-party projects/services; this repository is not affiliated with Nintendo or the Retro Rewind team. API data remains attributed to [rwfc.net](https://rwfc.net).

The official website API reference implementation is maintained by [Retro-Rewind-Team/rwfc-web](https://github.com/Retro-Rewind-Team/rwfc-web). This project consumes its public endpoints rather than copying its backend.
