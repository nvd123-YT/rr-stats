"use strict";

(() => {
  const WIIMMFI_JSON_URL = "https://wiimmfi.de/stats/mkwx?m=json";
  const WIIMMFI_URL = "https://wiimmfi.de/stats/game/mariokartwii/text";
  const WIIMMFI_PAGE = "https://wiimmfi.de/stats/mkw";
  const WIILINK_URL = "https://wfc.wiilink.ca/online";
  const WIILINK_API = "https://wfc.wiilink.ca/api";
  const REFRESH_MS = 45000;
  const networkState = {
    wiimmfi: { name: "Wiimmfi", onlinePlayers: null, rooms: null, players: [], roomGroups: [], status: "waiting", detail: "Waiting for the public Mario Kart Wii status feed", updatedAt: null },
    wiilink: { name: "WiiLink WFC", onlinePlayers: null, activePlayers: null, rooms: null, roomGroups: [], status: "waiting", detail: "Checking the public Mario Kart Wii API", updatedAt: null },
    lastAttempt: null,
    busy: false
  };

  const appState = () => typeof state !== "undefined" ? state : {};
  const finite = value => value !== null && value !== undefined && value !== "" && Number.isFinite(Number(value));
  const number = value => finite(value) ? Number(value) : null;
  const fmt = value => finite(value) ? Number(value).toLocaleString() : "—";
  const esc = value => String(value == null ? "" : value).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const localTime = value => value ? new Date(value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "—";

  async function fetchText(url, timeoutMs) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs || 12000);
    try {
      const response = await fetch(url, {
        method: "GET",
        mode: "cors",
        cache: "no-store",
        headers: { "Accept": "text/plain, text/html, application/json;q=0.9, */*;q=0.8" },
        signal: controller.signal
      });
      if (!response.ok) throw new Error("HTTP " + response.status);
      return await response.text();
    } finally {
      clearTimeout(timeout);
    }
  }

  function decodeBase64(value) {
    if (!value) return "";
    try {
      let encoded = value.trim().replace(/\*/g, "=").replace(/\./g, "+").replace(/-/g, "/");
      encoded += "=".repeat((4 - encoded.length % 4) % 4);
      const binary = atob(encoded);
      const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
      return new TextDecoder().decode(bytes).replace(/\0/g, "").trim();
    } catch (_) {
      return "";
    }
  }

  function parseWiimmfiText(raw) {
    const text = String(raw || "");
    const blocks = text.split(/(?:^|\r?\n)\s*wiimmfi\s*=\s*status\s*/i).slice(1);
    const playersByPid = new Map();
    const roomGroups = new Map();

    for (const block of blocks) {
      const fields = {};
      for (const line of block.split(/\r?\n/)) {
        const match = line.match(/^\s*([a-z0-9_]+)\s*=\s*(.*?)\s*$/i);
        if (match) fields[match[1].toLowerCase()] = match[2].trim();
      }
      const pid = fields.pid || "unknown-" + playersByPid.size;
      const statusBits = number(fields.ol_status != null ? fields.ol_status : fields.ol_stat);
      if (statusBits === null || (statusBits & 1) !== 1 || playersByPid.has(pid)) continue;

      const requestedSlots = Math.max(1, Math.min(2, number(fields.np) || 1));
      const names = [decodeBase64(fields.name1), decodeBase64(fields.name2)];
      const onlinePlayers = [];
      for (let slot = 0; slot < requestedSlots; slot++) {
        const name = names[slot] || (slot === 1 && names[0] ? names[0] + " (2P)" : "Player " + pid);
        onlinePlayers.push({
          name,
          pid,
          room: fields.room || "",
          region: fields.region || "",
          slot: slot + 1,
          statusBits,
          mode: statusBits & 0x0080 ? "Battle" : statusBits & 0x0040 ? "Race" : statusBits & 0x1000 ? "Searching" : statusBits & 0x2000 ? "Connecting" : "Online"
        });
      }
      playersByPid.set(pid, onlinePlayers);

      const roomId = fields.room || "";
      if (roomId && roomId !== "0") {
        if (!roomGroups.has(roomId)) roomGroups.set(roomId, []);
        roomGroups.get(roomId).push(...onlinePlayers);
      }
    }

    const players = Array.from(playersByPid.values()).flat();
    const rooms = Array.from(roomGroups.entries()).map(([id, roomPlayers]) => ({ id, players: roomPlayers }));
    const hasStatusFeed = blocks.length > 0;
    const explicitEmpty = /no\s+(?:players|racers|users)\s+online|nobody\s+online/i.test(text);

    return {
      onlinePlayers: hasStatusFeed || explicitEmpty ? players.length : null,
      rooms: hasStatusFeed ? rooms.length : explicitEmpty ? 0 : null,
      players,
      roomGroups: rooms,
      method: "Mario Kart Wii online-status records"
    };
  }

  function parseWiimmfiJson(payload) {
    if (!Array.isArray(payload)) return null;
    const rooms = payload.filter(record => record && String(record.type).toLowerCase() === "room");
    if (!rooms.length && payload.length) return null;

    const byRegion = new Map();
    const roomRows = rooms.map((record, index) => {
      const players = number(record.n_players);
      const region = record.region == null ? "Unknown" : String(record.region);
      const roomId = record.room_id != null ? record.room_id
        : record.room != null ? record.room
        : record.id != null ? record.id : null;
      if (players !== null) byRegion.set(region, (byRegion.get(region) || 0) + players);
      return { id: roomId == null ? "" : String(roomId), region, players: players === null ? 0 : players };
    });

    const totalPlayers = roomRows.reduce((sum, room) => sum + room.players, 0);
    const regions = Array.from(byRegion.entries())
      .map(([id, players]) => ({ id, players }))
      .sort((a, b) => b.players - a.players);

    return {
      onlinePlayers: totalPlayers,
      rooms: roomRows.length,
      players: [],
      roomGroups: roomRows,
      regions,
      method: "Wiimmfi legacy mkwx JSON room records",
      source: "legacy-json"
    };
  }

  async function refreshWiimmfi() {
    let jsonError = null;
    try {
      const raw = await fetchText(WIIMMFI_JSON_URL, 12000);
      const parsed = parseWiimmfiJson(JSON.parse(raw));
      if (parsed) {
        networkState.wiimmfi = {
          name: "Wiimmfi",
          onlinePlayers: parsed.onlinePlayers,
          rooms: parsed.rooms,
          players: parsed.players,
          roomGroups: parsed.roomGroups,
          regions: parsed.regions,
          status: "live",
          detail: "Live Mario Kart Wii room totals from Wiimmfi's legacy JSON feed (may be deprecated)",
          source: parsed.source,
          updatedAt: new Date().toISOString()
        };
        return;
      }
      jsonError = "The JSON endpoint returned an unrecognized structure";
    } catch (error) {
      jsonError = String(error && error.message || error);
    }

    // Fallback: newer text statistics endpoint. Some automated/browser clients receive
    // Cloudflare protection here, so failure must stay visible rather than becoming zero.
    try {
      const text = await fetchText(WIIMMFI_URL, 12000);
      const parsed = parseWiimmfiText(text);
      if (parsed.onlinePlayers !== null) {
        networkState.wiimmfi = {
          name: "Wiimmfi",
          onlinePlayers: parsed.onlinePlayers,
          rooms: parsed.rooms,
          players: parsed.players,
          roomGroups: parsed.roomGroups,
          regions: [],
          status: "live",
          detail: "Live count decoded from the Wiimmfi Mario Kart Wii status text feed",
          source: "status-text",
          updatedAt: new Date().toISOString()
        };
        return;
      }
      networkState.wiimmfi = {
        name: "Wiimmfi", onlinePlayers: null, rooms: null, players: [], roomGroups: [], regions: [],
        status: "partial",
        detail: "JSON and text feeds responded but neither exposed a verifiable MKWii count",
        error: jsonError,
        updatedAt: new Date().toISOString()
      };
    } catch (error) {
      networkState.wiimmfi = {
        name: "Wiimmfi", onlinePlayers: null, rooms: null, players: [], roomGroups: [], regions: [],
        status: "unavailable",
        detail: "Browser could not read Wiimmfi feeds (CORS, Cloudflare, network restriction, or retired legacy endpoint)",
        error: String(error && error.message || error) + " · JSON: " + jsonError,
        updatedAt: new Date().toISOString()
      };
    }
  }

  function parseWiiLinkSnapshot(statsPayload, groupPayload) {
    if (!statsPayload || typeof statsPayload !== "object" || !Array.isArray(groupPayload)) return null;

    const gameStats = statsPayload.mariokartwii || {};
    const validStats = statsPayload.global && typeof statsPayload.global === "object";
    if (!validStats) return null;

    const rooms = groupPayload
      .filter(group => group && (!group.game || String(group.game).toLowerCase() === "mariokartwii"))
      .map((group, index) => {
        const playerMap = group.players && typeof group.players === "object" ? group.players : {};
        const players = Object.values(playerMap).map(player => ({
          name: player.name || "Unknown player",
          pid: player.pid || "",
          friendCode: player.fc || "",
          versusElo: number(player.ev),
          battleElo: number(player.eb),
          consolePlayers: Math.max(1, number(player.count) || 1),
          suspended: String(player.suspend || "0") !== "0"
        }));
        return {
          id: String(group.id || "Room " + (index + 1)),
          type: group.type || "unknown",
          region: group.rk || "",
          created: group.created || null,
          suspended: !!group.suspend,
          race: group.race || null,
          players,
          playerSlots: players.reduce((sum, player) => sum + player.consolePlayers, 0)
        };
      });

    const roomPlayerSlots = rooms.reduce((sum, room) => sum + room.playerSlots, 0);
    const roomConsoleSessions = rooms.reduce((sum, room) => sum + room.players.length, 0);
    // /api/stats counts GameSpy sessions (consoles); room player records also expose
    // local-player slots, so add only the extra split-screen slots to the session total.
    const extraLocalSlots = Math.max(0, roomPlayerSlots - roomConsoleSessions);
    const onlineSessions = number(gameStats.online);
    const onlinePlayers = (onlineSessions === null ? roomConsoleSessions : onlineSessions) + extraLocalSlots;
    const activeSessions = number(gameStats.active);
    const activePlayers = (activeSessions === null ? roomConsoleSessions : activeSessions) + extraLocalSlots;
    const roomCount = number(gameStats.groups) !== null
      ? Number(gameStats.groups)
      : rooms.length;

    return {
      onlinePlayers,
      onlineSessions,
      activePlayers,
      rooms: roomCount,
      roomGroups: rooms,
      status: "live",
      detail: "Live Mario Kart Wii totals and room/player details from WiiLink WFC's public API",
      updatedAt: new Date().toISOString()
    };
  }

  async function refreshWiiLink() {
    try {
      const [statsText, groupsText] = await Promise.all([
        fetchText(WIILINK_API + "/stats?game=mariokartwii", 12000),
        fetchText(WIILINK_API + "/groups?game=mariokartwii", 12000)
      ]);
      const parsed = parseWiiLinkSnapshot(JSON.parse(statsText), JSON.parse(groupsText));
      if (!parsed) throw new Error("WiiLink API returned an unrecognized response");
      networkState.wiilink = Object.assign({
        name: "WiiLink WFC",
        regions: [],
        error: null
      }, parsed);
    } catch (error) {
      networkState.wiilink = {
        name: "WiiLink WFC",
        onlinePlayers: null,
        activePlayers: null,
        rooms: null,
        roomGroups: [],
        regions: [],
        status: "unavailable",
        detail: "Could not read WiiLink's public Mario Kart Wii stats/groups API",
        updatedAt: new Date().toISOString(),
        error: String(error && error.message || error)
      };
    }
  }

  function retroSnapshot() {
    const s = appState();
    const status = s.roomStatus || {};
    const stats = s.roomStats || {};
    const rooms = Array.isArray(s.rooms) ? s.rooms : Array.isArray(status.rooms) ? status.rooms : [];
    const fromRoomList = rooms.reduce((sum, room) => {
      const p = room && room.players;
      return sum + (Array.isArray(p) ? p.length : p && typeof p === "object" ? Object.keys(p).length : 0);
    }, 0);
    const hasSnapshot = !!s.roomStatus || !!s.roomStats;
    const players = number(status.totalPlayers) !== null ? Number(status.totalPlayers)
      : number(stats.totalPlayers) !== null ? Number(stats.totalPlayers)
      : hasSnapshot ? fromRoomList : null;
    const roomCount = number(stats.totalRooms) !== null ? Number(stats.totalRooms)
      : number(status.totalRooms) !== null ? Number(status.totalRooms)
      : hasSnapshot ? rooms.length : null;
    return {
      name: "Retro WFC",
      onlinePlayers: players,
      rooms: roomCount,
      peakToday: number(stats.peakPlayersToday),
      peakAllTime: number(stats.peakPlayersAllTime),
      status: players === null ? "waiting" : "live",
      detail: "Current Mario Kart Wii room snapshot from Retro WFC; historical peak is tracked separately",
      updatedAt: stats.lastUpdated || status.timestamp || null,
      races: number(s.globalStats && s.globalStats.totalRacesTracked),
      trackedPlayers: number(s.globalStats && s.globalStats.uniquePlayersCount),
      url: "https://rwfc.net"
    };
  }

  function providers() {
    return [
      Object.assign(retroSnapshot(), { key: "retro" }),
      Object.assign({}, networkState.wiimmfi, { key: "wiimmfi", url: WIIMMFI_PAGE }),
      Object.assign({}, networkState.wiilink, { key: "wiilink", url: WIILINK_URL })
    ];
  }

  function combined(field) {
    const values = providers()
      .filter(provider => provider.status === "live")
      .map(provider => number(provider[field]))
      .filter(value => value !== null);
    return values.length ? values.reduce((sum, value) => sum + value, 0) : null;
  }

  function statusLabel(provider) {
    if (provider.status === "live") return '<span class="network-status live"><i></i> LIVE DATA</span>';
    if (provider.status === "partial") return '<span class="network-status partial"><i></i> PARTIAL</span>';
    if (provider.status === "unavailable") return '<span class="network-status down"><i></i> UNAVAILABLE</span>';
    if (provider.status === "linked") return '<span class="network-status linked"><i></i> SOURCE LINK</span>';
    return '<span class="network-status pending"><i></i> WAITING</span>';
  }

  function capability(label, value, good) {
    return '<span class="network-capability ' + (good ? "good" : "limited") + '">' + esc(label) + ': ' + esc(value) + '</span>';
  }

  function providerCard(provider) {
    let features = "";
    let substats = "";
    if (provider.key === "retro") {
      features = capability("Live rooms", "yes", true) +
        capability("VR leaderboard", "yes", true) +
        capability("Race archive", "yes", true) +
        capability("Combo analytics", "yes", true);
      substats = '<div class="network-substats"><div><b>' + fmt(provider.races) + '</b><span>RECORDED RACES</span></div><div><b>' + fmt(provider.trackedPlayers) + '</b><span>TRACKED PLAYERS</span></div><div><b>' + fmt(provider.peakAllTime) + '</b><span>ALL-TIME ROOM PEAK</span></div><div><b>' + fmt(provider.peakToday) + '</b><span>TODAY\'S ROOM PEAK</span></div></div>';
    } else if (provider.key === "wiimmfi") {
      features = capability("Live MKWii status", provider.onlinePlayers === null ? "not readable" : "yes", provider.onlinePlayers !== null) +
        capability("Active rooms", provider.rooms === null ? "not readable" : "yes", provider.rooms !== null) +
        capability("Regional counts", Array.isArray(provider.regions) && provider.regions.length ? "yes" : "not exposed", Array.isArray(provider.regions) && provider.regions.length > 0) +
        capability("VR / race archive", "not in public status feed", false);
    } else {
      features = capability("Live rooms / players", provider.onlinePlayers === null ? "unavailable" : "yes", provider.onlinePlayers !== null) +
        capability("Friend codes", "yes", true) +
        capability("VS / Battle ELO", "yes", true) +
        capability("Historical race archive", "not exposed", false);
      substats = '<div class="network-substats"><div><b>' + fmt(provider.activePlayers) + '</b><span>ACTIVE PLAYER SLOTS</span></div><div><b>' + fmt(provider.onlineSessions) + '</b><span>ONLINE CONSOLES</span></div></div>';
    }
    return '<article class="network-card">' +
      '<div class="network-card-head"><div><div class="network-name">' + esc(provider.name) + '</div><div class="network-source">' + esc(provider.key === "retro" ? "RETRO REWIND / RETRO WFC" : provider.key === "wiimmfi" ? "WIIMMFI PROJECT" : "WIILINK TEAM") + '</div></div>' + statusLabel(provider) + '</div>' +
      '<div class="network-numbers"><div><span>MKWII PLAYERS ONLINE</span><b>' + fmt(provider.onlinePlayers) + '</b></div><div><span>ACTIVE ROOMS</span><b>' + fmt(provider.rooms) + '</b></div></div>' +
      substats +
      '<p class="network-detail">' + esc(provider.detail || "") + '</p>' +
      '<p class="network-checked">LAST SOURCE UPDATE · ' + esc(localTime(provider.updatedAt)) + '</p>' +
      '<div class="network-capabilities">' + features + '</div>' +
      '<a class="network-external" href="' + esc(provider.url) + '" target="_blank" rel="noopener noreferrer">OPEN OFFICIAL SOURCE ↗</a>' +
      '</article>';
  }

  function renderNetworkActivity() {
    const wiimmfi = networkState.wiimmfi;
    const wiilink = networkState.wiilink;
    const wiimmfiRegions = (wiimmfi.regions || []).slice(0, 30).map(region =>
      '<tr><td class="mono">' + esc(region.id) + '</td><td class="mono lime">' + fmt(region.players) + '</td></tr>'
    ).join("");
    const wiimmfiRooms = (wiimmfi.roomGroups || []).slice(0, 60).map(room =>
      '<tr><td class="mono">' + esc(room.id) + '</td><td class="mono">' + esc(room.region) + '</td><td>' + fmt(room.players) + '</td></tr>'
    ).join("");
    const wiilinkRooms = (wiilink.roomGroups || []).slice(0, 60).map(room => {
      const race = room.race || {};
      const course = race.course == null ? "—" : "Course " + race.course;
      const players = room.players.map(player =>
        '<div class="network-player-line"><b>' + esc(player.name) + '</b><span>' +
        (player.friendCode ? esc(player.friendCode) + " · " : "") +
        'VS ' + fmt(player.versusElo) + ' / BT ' + fmt(player.battleElo) +
        (player.consolePlayers > 1 ? " · " + player.consolePlayers + "P" : "") +
        '</span></div>'
      ).join("");
      return '<tr><td class="mono">' + esc(room.id) + '</td><td>' + esc(room.type) +
        (room.suspended ? ' · SUSPENDED' : '') + '</td><td>' + esc(course) +
        (race.cc == null ? "" : " · " + esc(race.cc) + " CC") + '</td><td>' +
        fmt(room.playerSlots) + '<div class="network-room-players">' + players + '</div></td></tr>';
    }).join("");

    const wiimmfiSection = (wiimmfi.regions || []).length || (wiimmfi.roomGroups || []).length
      ? '<section><div class="panel-title"><strong>Wiimmfi</strong><small>Legacy JSON regions and live room records</small></div>' +
        '<div class="table-wrap"><table class="data-table"><thead><tr><th>REGION ID</th><th>PLAYERS</th></tr></thead><tbody>' +
        (wiimmfiRegions || '<tr><td colspan="2">Regional breakdown not exposed</td></tr>') +
        '</tbody></table></div><div class="table-wrap"><table class="data-table"><thead><tr><th>ROOM</th><th>REGION</th><th>PLAYERS</th></tr></thead><tbody>' +
        (wiimmfiRooms || '<tr><td colspan="3">No room rows</td></tr>') +
        '</tbody></table></div></section>'
      : '<section><div class="panel-title"><strong>Wiimmfi</strong><small>Live activity detail</small></div><div class="empty-state">Room details unavailable from the current Wiimmfi feed.</div></section>';

    const wiilinkSection = wiilink.status === "live"
      ? '<section><div class="panel-title"><strong>WiiLink WFC</strong><small>Live rooms, player ELO and current race metadata</small></div>' +
        '<div class="table-wrap"><table class="data-table"><thead><tr><th>ROOM</th><th>TYPE</th><th>RACE / COURSE</th><th>PLAYERS · VS / BATTLE ELO</th></tr></thead><tbody>' +
        (wiilinkRooms || '<tr><td colspan="4">No active room records</td></tr>') +
        '</tbody></table></div></section>'
      : '<section><div class="panel-title"><strong>WiiLink WFC</strong><small>Live activity detail</small></div><div class="empty-state">WiiLink live room details are currently unavailable.</div></section>';

    return '<div class="network-live-grid">' + wiimmfiSection + wiilinkSection + '</div>';
  }

  function renderNetworks() {
    const list = providers();
    const countable = list.filter(provider => provider.status === "live" && number(provider.onlinePlayers) !== null).length;
    const totalPlayers = combined("onlinePlayers");
    const totalRooms = combined("rooms");
    const retro = list[0];
    const lastUpdate = networkState.lastAttempt ? localTime(networkState.lastAttempt) : "—";
    const liveNote = countable
      ? countable + " of " + list.length + " networks currently return a readable Mario Kart Wii player count."
      : "No server has returned a verified count yet. Check the individual source cards for current feed availability.";
    return '<div class="network-summary">' +
      '<div class="network-summary-main"><div class="network-eyebrow">CROSS-SERVER POPULATION</div><div class="network-total">' + fmt(totalPlayers) + '</div><div class="network-summary-caption">REPORTED MARIO KART WII PLAYERS · ALL COUNTABLE NETWORKS</div><p>' + esc(liveNote) + '</p></div>' +
      '<div class="network-summary-side"><div><span>REPORTED ACTIVE ROOMS</span><b>' + fmt(totalRooms) + '</b></div><div><span>RWFC ALL-TIME ROOM PEAK</span><b>' + fmt(retro.peakAllTime) + '</b></div><div><span>COUNTABLE NETWORKS</span><b>' + countable + ' / ' + list.length + '</b></div><div><span>LAST CHECK</span><b>' + esc(lastUpdate) + '</b></div></div>' +
      '</div>' +
      '<div class="network-important"><strong>Counting rule:</strong> only verified, current Mario Kart Wii player counts are added. The result is a reported cross-server total, not a guaranteed unique-person count; the same person could appear on multiple networks. A dash means no verified count was available, not zero. Historical peaks are never added to live totals.</div>' +
      '<div class="network-card-grid">' + list.map(providerCard).join("") + '</div>' +
      '<section class="panel network-notes"><div class="panel-head"><div class="panel-title"><strong>Wiimmfi live activity</strong><small>Player names, status and room IDs where the public feed provides them</small></div><span class="panel-kicker">LIVE FEED</span></div><div class="panel-body">' + renderWiimmfiActivity() + '</div></section>' +
      '<section class="panel network-notes"><div class="panel-head"><div class="panel-title"><strong>Coverage and data boundaries</strong><small>Each online service publishes a different amount of public telemetry</small></div><span class="panel-kicker">DATA NOTES</span></div><div class="panel-body">' +
      '<div class="coverage-row"><b>Retro WFC / Retro Rewind</b><p>Full integration: active rooms and players, VR / BR, public VR leaderboard, player history, recorded races, finish positions, character and vehicle selections, combo analytics, and the server-reported all-time room-population peak.</p></div>' +
      '<div class="coverage-row"><b>Wiimmfi</b><p>Mario Kart Wii-specific machine-readable status feed. It reports online status, player names, room IDs, region and whether a player is in a race, battle, searching or connecting. Its public status feed does not supply a compatible historical race-result archive or the Retro WFC VR scale, so those stats are not invented or mixed.</p></div>' +
      '<div class="coverage-row"><b>WiiLink WFC</b><p>Full live MKWii integration through the public WFC API: game-specific online and active player counts, room counts, room IDs, public/private type, current course and engine class, player names, friend codes, versus ELO and battle ELO. Its public API does not provide a persistent historical race-result archive, so no historical race totals or finish records are fabricated.</p></div>' +
      '<div class="coverage-row"><b>Other/private WFC services</b><p>Private servers and other revival projects can be added when they provide a verifiable Mario Kart Wii-specific status feed. Generic all-game counts and unverified mirrors are intentionally excluded.</p></div>' +
      '<p class="network-footnote">Browser-only deployment: upstream CORS and anti-bot rules may prevent the dashboard from reading a feed. The site reports unavailable data rather than substituting stale or fabricated values. Last network check: ' + esc(lastUpdate) + '.</p>' +
      '</div></section>';
  }

  function setNetworkView() {
    const tabs = Array.from(document.querySelectorAll(".nav-tab"));
    tabs.forEach(tab => tab.classList.toggle("active", tab.dataset.view === "networks"));
    const eyebrow = document.querySelector("#viewEyebrow");
    const title = document.querySelector("#viewTitle");
    const subtitle = document.querySelector("#viewSubtitle");
    if (eyebrow) eyebrow.textContent = "MARIO KART WII // CROSS-SERVER TELEMETRY";
    if (title) title.innerHTML = "One grid, <em>every server.</em>";
    if (subtitle) subtitle.textContent = "Compare live populations across Retro WFC, Wiimmfi, WiiLink WFC and other supported networks.";
    const root = document.querySelector("#viewContent");
    if (root) root.innerHTML = renderNetworks();
  }

  const originalSetView = window.setView;
  if (typeof originalSetView === "function") {
    window.setView = function (view) {
      if (view === "networks") {
        appState().view = "networks";
        setNetworkView();
      } else {
        originalSetView(view);
      }
    };
  }

  const originalRenderView = window.renderView;
  if (typeof originalRenderView === "function") {
    window.renderView = function () {
      if (appState().view === "networks") setNetworkView();
      else originalRenderView();
    };
  }

  const originalUpdateMetrics = window.updateMetrics;
  if (typeof originalUpdateMetrics === "function") {
    window.updateMetrics = function () {
      originalUpdateMetrics();
      const player = document.querySelector("#metricPlayers");
      const rooms = document.querySelector("#metricRooms");
      const playerFoot = document.querySelector("#metricPlayersFoot");
      const roomsFoot = document.querySelector("#metricRoomsFoot");
      const allTimePeak = retroSnapshot().peakAllTime;
      if (player) player.textContent = fmt(combined("onlinePlayers"));
      if (rooms) rooms.textContent = fmt(combined("rooms"));
      if (playerFoot) playerFoot.textContent = "Verified cross-server sum · RWFC all-time peak " + fmt(allTimePeak);
      if (roomsFoot) roomsFoot.textContent = "Countable Mario Kart Wii network room totals";
      const labels = document.querySelectorAll(".metric-label");
      if (labels[0]) labels[0].firstChild.textContent = "PLAYERS ONLINE · COMBINED ";
      if (labels[1]) labels[1].firstChild.textContent = "ACTIVE ROOMS · COMBINED ";
      if (labels[2]) labels[2].firstChild.textContent = "RWFC RACES TRACKED ";
      if (labels[3]) labels[3].firstChild.textContent = "RWFC PLAYERS TRACKED ";
    };
  }

  async function refreshNetworks() {
    if (networkState.busy) return;
    networkState.busy = true;
    networkState.lastAttempt = new Date();
    await Promise.allSettled([refreshWiimmfi(), refreshWiiLink()]);
    networkState.busy = false;
    if (typeof window.updateMetrics === "function") window.updateMetrics();
    if (appState().view === "networks") setNetworkView();
  }

  window.rrNetworkStats = {
    refresh: refreshNetworks,
    getSnapshot: () => ({
      combinedPlayers: combined("onlinePlayers"),
      combinedRooms: combined("rooms"),
      providers: providers()
    })
  };

  const refreshButton = document.querySelector("#refreshButton");
  if (refreshButton) refreshButton.addEventListener("click", refreshNetworks);
  const networkTab = document.querySelector('.nav-tab[data-view="networks"]');
  if (networkTab) networkTab.addEventListener("click", () => setTimeout(setNetworkView, 0));

  refreshNetworks();
  setInterval(refreshNetworks, REFRESH_MS);
  setInterval(() => {
    if (appState().view === "networks") setNetworkView();
    if (typeof window.updateMetrics === "function") window.updateMetrics();
  }, 5000);
})();