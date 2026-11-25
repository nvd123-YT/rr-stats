# MKWii Network Stats

A static GitHub Pages dashboard for Mario Kart Wii online activity across public community servers. It combines compatible live player/room counts while preserving separate server views and deep per-network statistics wherever those networks publish them.

## Dashboard

- **Cross-server overview:** live Mario Kart Wii players and active rooms across feeds that return a verified, game-specific count. The sum is explicitly labelled as reported clients and may count the same person twice if they are signed in on multiple networks simultaneously.
- **Network comparison:** independent cards for Retro WFC / Retro Rewind, Wiimmfi, and WiiLink WFC, with each feed's status, data coverage, last update and official source link.
- **Retro WFC live rooms:** room IDs, public/private and joinable state, room type, current course, engine class, average VR, open-host details, and each room's player list with VR / BR.
- **Retro WFC population:** live room snapshot, history and all-time / daily peaks. The all-time peak is a historical room-population metric, never added to the current player count.
- **Race archive:** paginated Retro WFC race results with room, race number, timestamp, track, engine class, mode, and the full returned participant order.
- **VR players:** searchable Retro WFC VR leaderboard, rank, 24-hour movement, last seen, and individual player dossiers.
- **VR history:** player history chart and 30-day change feed where public history is available.
- **Race performance:** tracked races, character and vehicle selections, exact combos, win rate, track performance, finish distribution, and kart / bike split.
- **Global meta:** character pick rates, vehicle usage, character + vehicle combo usage, character / vehicle / combo win rates, track frequency, most active players, day-of-week and hourly activity.
- **Time trials:** per-track world records and ranked ghost submissions, 3-lap and fastest-lap boards, 150cc / 200cc, retro / custom, glitch, shroomless, kart and bike filters, record-history timelines, TT player profiles, ghost-file downloads when available, and CSV export.
- **Wiimmfi live activity:** public Mario Kart Wii status records parsed into current online player slots, player names, room IDs, region and coarse play state (race, battle, searching, connecting or online), when the public feed is readable.

## Network coverage

| Network | Live MKWii population | Rooms / players | VR + race history |
|---|---|---|---|
| Retro WFC / Retro Rewind | Yes, current room snapshot | Yes | Yes, full public dataset available from RWFC |
| Wiimmfi | Yes, public machine-readable MKWii status feed | Yes, status records expose online players and room IDs | Not included: the public status feed does not provide a compatible historical VR / race-results database |
| WiiLink WFC | Yes, from its public game-specific API | Yes: live room IDs, type, course, engine class, player names, friend codes, VS ELO and Battle ELO | No persistent historical race-result archive in the public API; ELO is not relabelled as VR |

WiiLink WFC is queried through its public game-filtered GET endpoints: `/api/stats?game=mariokartwii` and `/api/groups?game=mariokartwii`. These endpoints expose game-specific counts, active groups, live rosters and the fields listed above. The backend explicitly enables cross-origin reads for GET requests. Its ELO fields remain labelled VS / Battle ELO and are not merged with Retro WFC VR / BR.

Other WFC revival and private servers can be added once a public, machine-readable Mario Kart Wii status endpoint is available and its scope is verified. Generic network-wide counts are not silently presented as MKWii numbers.

## Data sources

- [Retro WFC](https://rwfc.net/) public API: room status, leaderboard, VR history, race results, player statistics, time-trial records and population peaks.
- [Wiimmfi Mario Kart Wii statistics](https://wiimmfi.de/stats/mkw): official room statistics page.
- [Wiimmfi legacy JSON feed](https://wiimmfi.de/stats/mkwx?m=json): room records with `type=room`, `region`, and `n_players`; this feed may be deprecated and is used as the first machine-readable source when it remains available.
- [Wiimmfi online-status text](https://wiimmfi.de/stats/game/mariokartwii/text): fallback machine-readable status records. The parser uses the documented `ol_status` bit field and `np` console-player count. Automated access may be blocked by Cloudflare.
- [WiiLink WFC online browser](https://wfc.wiilink.ca/online): official online browser.
- [WiiLink WFC public API](https://wfc.wiilink.ca/api/stats?game=mariokartwii) and [live rooms](https://wfc.wiilink.ca/api/groups?game=mariokartwii): public game-specific JSON feeds.

The existing Retro WFC feeds include:
- `/api/roomstatus`, `/api/roomstatus/stats`, `/api/roomstatus/analytics`
- `/api/leaderboard`, `/api/leaderboard/player/{friendCode}`, `/api/leaderboard/player/{friendCode}/history`
- `/api/racestats/global`, `/api/racestats/races`, `/api/racestats/player/{pid}`, and player analytics
- `/api/timetrial/*` public leaderboard, world-record, history and profile feeds

## Accuracy rules

- **Current players** means players in a current room snapshot or a verified current MKWii status feed. It does not mean registered accounts, total historical players or database row counts.
- **All-time peak** is a historical maximum from the network's room snapshots. It is shown separately from current players.
- A dash means no verified value is available; it does not mean zero.
- The combined number sums the current MKWii counts that are available. It is a sum of network-reported player slots, not a deduplicated count of unique humans.
- Race history, VR, finish positions and character/vehicle analytics are only shown where the source publishes those fields. Data from one server is never attributed to another.
- WiiLink VS ELO / Battle ELO and Retro WFC VR / BR are different rating systems and remain separately labelled.
- Browser CORS rules, anti-bot protection or upstream outages can make a feed temporarily unavailable. The dashboard reports that limitation rather than inventing a value.
- The site does not query console credentials, private profile data or player devices.

## Publish with GitHub Pages

Publish the repository root from `main` using GitHub Pages (**Settings → Pages → Deploy from a branch → main → /(root)**).

Expected URL: [https://nvd123-YT.github.io/rr-stats/](https://nvd123-YT.github.io/rr-stats/).

No build step, database, API key, login or user account is required. All browser-side processing is local; the dashboard reads the public feeds directly.

## Attribution

Independent community project. Retro Rewind, Retro WFC, Wiimmfi and WiiLink are third-party services; this repository is not affiliated with Nintendo or any of those teams. Each service retains ownership of its data and branding.
