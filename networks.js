"use strict";

(() => {
  const WIIMMFI_JSON_URL = "https://wiimmfi.de/stats/mkwx?m=json";
  const WIIMMFI_URL = "https://wiimmfi.de/stats/game/mariokartwii/text";
  const WIIMMFI_PAGE = "https://wiimmfi.de/stats/mkw";
  const WIILINK_URL = "https://wfc.wiilink.ca/online/";
  const WIILINK_API = "https://api.wfc.wiilink24.com/api";
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

    const roleName = value => ({
      "0": "Offline", "1": "Online", "2": "Connecting",
      "3": "Viewer", "4": "Guest", "5": "Host"
    }[String(value)] || "Unknown");

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
      const roomId = fields.room || "";
      const region = fields.region || "";
      const changedAt = number(fields.time);
      const statusAt = changedAt === null ? null : new Date(changedAt * 1000).toISOString();
      const flags = {
        online: !!(statusBits & 0x0001),
        privateRoom: !!(statusBits & 0x0002),
        global: !!(statusBits & 0x0004),
        continental: !!(statusBits & 0x0008),
        worldwide: !!(statusBits & 0x0010),
        active: !!(statusBits & 0x0020),
        race: !!(statusBits & 0x0040),
        battle: !!(statusBits & 0x0080),
        host: !!(statusBits & 0x0100),
        guest: !!(statusBits & 0x0200),
        viewer: !!(statusBits & 0x0400),
        searching: !!(statusBits & 0x1000),
        connecting: !!(statusBits & 0x2000)
      };
      const mode = flags.battle ? "Battle" : flags.race ? "Race"
        : flags.searching ? "Searching" : flags.connecting ? "Connecting" : "Online";
      const role = roleName(fields.ol_role);
      const onlinePlayers = [];

      for (let slot = 0; slot < requestedSlots; slot++) {
        const name = names[slot] || (slot === 1 && names[0] ? names[0] + " (2P)" : "Player " + pid);
        onlinePlayers.push(Object.assign({
          name, pid, room: roomId, region, slot: slot + 1,
          consolePlayerCount: requestedSlots,
          statusBits, mode, role, statusAt,
          statusCode: fields.status == null ? null : fields.status,
          onlineScope: flags.worldwide ? "Worldwide" : flags.continental ? "Continental" : flags.global ? "Global" : "—"
        }, flags));
      }
      playersByPid.set(pid, onlinePlayers);

      if (roomId && roomId !== "0") {
        if (!roomGroups.has(roomId)) {
          roomGroups.set(roomId, {
            id: roomId, region, privateRoom: flags.privateRoom,
            onlineScope: onlinePlayers[0].onlineScope, modes: new Set(), roster: []
          });
        }
        const room = roomGroups.get(roomId);
        onlinePlayers.forEach(player => {
          room.modes.add(player.mode);
          room.roster.push(player);
        });
      }
    }

    const players = Array.from(playersByPid.values()).flat();
    const rooms = Array.from(roomGroups.values()).map(room => ({
      id: room.id, region: room.region, privateRoom: room.privateRoom,
      onlineScope: room.onlineScope, mode: Array.from(room.modes).join(" / "),
      playerCount: room.roster.length, roster: room.roster
    }));
    const hasStatusFeed = blocks.length > 0;
    const explicitEmpty = /no\s+(?:players|racers|users)\s+online|nobody\s+online/i.test(text);
    const breakdown = {
      race: 0, battle: 0, searching: 0, connecting: 0, online: 0,
      active: 0, private: 0, public: 0, worldwide: 0, continental: 0,
      global: 0, hosts: 0, guests: 0, viewers: 0, consoles: playersByPid.size
    };
    const byRegion = new Map();
    for (const player of players) {
      breakdown.race += player.race ? 1 : 0;
      breakdown.battle += player.battle ? 1 : 0;
      breakdown.searching += player.searching ? 1 : 0;
      breakdown.connecting += player.connecting ? 1 : 0;
      breakdown.online += player.online ? 1 : 0;
      breakdown.active += player.active ? 1 : 0;
      breakdown.private += player.privateRoom ? 1 : 0;
      breakdown.public += player.privateRoom ? 0 : 1;
      breakdown.worldwide += player.worldwide ? 1 : 0;
      breakdown.continental += player.continental ? 1 : 0;
      breakdown.global += player.global ? 1 : 0;
      breakdown.hosts += player.host ? 1 : 0;
      breakdown.guests += player.guest ? 1 : 0;
      breakdown.viewers += player.viewer ? 1 : 0;
      if (player.region) byRegion.set(player.region, (byRegion.get(player.region) || 0) + 1);
    }
    const regions = Array.from(byRegion.entries())
      .map(([id, playerCount]) => ({ id, players: playerCount }))
      .sort((a, b) => b.players - a.players);

    return {
      onlinePlayers: hasStatusFeed || explicitEmpty ? players.length : null,
      rooms: hasStatusFeed ? rooms.length : explicitEmpty ? 0 : null,
      players, roomGroups: rooms, regions, breakdown,
      method: "Mario Kart Wii online-status records"
    };
  }

    function parseWiimmfiJson(payload) {
    if (!Array.isArray(payload)) return null;
    const rooms = payload.filter(record => record && String(record.type || "").toLowerCase() === "room");
    if (!rooms.length && payload.length) return null;
    const get = (record, keys) => {
      for (const key of keys) if (record[key] !== undefined && record[key] !== null && record[key] !== "") return record[key];
      return null;
    };
    const byRegion = new Map();
    const roomRows = rooms.map(record => {
      const rawPlayers = get(record, ["n_players", "player_count", "players_count", "count", "players"]);
      const roster = Array.isArray(rawPlayers) ? rawPlayers : Array.isArray(record.roster) ? record.roster : [];
      const players = roster.length ? roster.length : number(rawPlayers);
      const regionValue = get(record, ["region", "region_id", "rk"]);
      const region = regionValue == null ? "" : String(regionValue);
      const roomId = get(record, ["room_id", "rid", "room", "id"]);
      const privateValue = get(record, ["private", "is_private", "private_room"]);
      const privateRoom = privateValue == null ? null : typeof privateValue === "boolean" ? privateValue : /^(1|true|yes|private)$/i.test(String(privateValue));
      const details = Object.entries(record).filter(([key, value]) =>
        !["type","id","room","room_id","rid","region","region_id","rk","n_players","player_count","players_count","count","players","roster"].includes(key.toLowerCase()) &&
        value != null && value !== ""
      ).map(([key, value]) => ({ label: key.replace(/[_-]+/g, " "), value: typeof value === "object" ? JSON.stringify(value) : String(value) }));
      if (players !== null) byRegion.set(region || "Unknown", (byRegion.get(region || "Unknown") || 0) + players);
      return {
        id: roomId == null ? "" : String(roomId), region, players, playerCount: players,
        privateRoom, mode: get(record, ["mode", "room_type", "game_mode"]) || "",
        onlineScope: get(record, ["scope", "online_scope"]) || "",
        track: get(record, ["track_name", "course_name", "track", "track_id", "course"]) || "",
        created: get(record, ["created_at", "created", "start"]) || null,
        raceNumber: get(record, ["race_number", "nrace"]) || null,
        host: get(record, ["host", "host_name"]) || "",
        roster, details
      };
    });
    const totalPlayers = roomRows.reduce((sum, room) => sum + (room.players == null ? 0 : room.players), 0);
    const regions = Array.from(byRegion.entries()).map(([id, players]) => ({ id, players })).sort((a, b) => b.players - a.players);
    return {
      onlinePlayers: totalPlayers, rooms: roomRows.length,
      players: roomRows.flatMap(room => room.roster || []), roomGroups: roomRows, regions,
      method: "Wiimmfi legacy mkwx JSON room records", source: "legacy-json"
    };
  }

  function explainFeedError(error) {
    const message = String(error && error.message || error || "Unknown fetch error");
    if (/load failed|failed to fetch|networkerror|fetch failed/i.test(message)) {
      return "browser request failed (possible CORS, Cloudflare protection or network filtering; the exact cause is not exposed)";
    }
    return message;
  }

  async function refreshWiimmfi() {
    const [jsonResult, textResult] = await Promise.allSettled([
      fetchText(WIIMMFI_JSON_URL, 12000),
      fetchText(WIIMMFI_URL, 12000)
    ]);
    let jsonParsed = null;
    let textParsed = null;
    let jsonError = jsonResult.status === "rejected"
      ? explainFeedError(jsonResult.reason) : null;
    let textError = textResult.status === "rejected"
      ? explainFeedError(textResult.reason) : null;

    if (jsonResult.status === "fulfilled") {
      try {
        jsonParsed = parseWiimmfiJson(JSON.parse(jsonResult.value));
        if (!jsonParsed) jsonError = "JSON response did not match the documented room schema";
      } catch (error) {
        jsonError = "JSON parse failed: " + String(error && error.message || error);
      }
    }
    if (textResult.status === "fulfilled") {
      textParsed = parseWiimmfiText(textResult.value);
      if (textParsed.onlinePlayers === null) {
        textError = "Text response contained no readable online-status records";
      }
    }

    if (jsonParsed || (textParsed && textParsed.onlinePlayers !== null)) {
      const hasJson = !!jsonParsed;
      const hasText = !!(textParsed && textParsed.onlinePlayers !== null);
      const details = [];
      if (hasJson) details.push("room-count feed readable");
      if (hasText) details.push("player/status feed readable");
      if (!hasJson && jsonError) details.push("JSON feed: " + jsonError);
      if (!hasText && textError) details.push("text feed: " + textError);
      networkState.wiimmfi = {
        name: "Wiimmfi",
        onlinePlayers: hasJson ? jsonParsed.onlinePlayers : textParsed.onlinePlayers,
        rooms: hasJson ? jsonParsed.rooms : textParsed.rooms,
        players: hasText ? textParsed.players : [],
        roomGroups: hasText && textParsed.roomGroups.length ? textParsed.roomGroups : (jsonParsed ? jsonParsed.roomGroups : []),
        regions: hasText && textParsed.regions.length ? textParsed.regions : (jsonParsed ? jsonParsed.regions : []),
        breakdown: hasText ? textParsed.breakdown : null,
        status: "live",
        detail: details.join(" · "),
        source: [hasJson ? "legacy-json" : null, hasText ? "status-text" : null].filter(Boolean).join("+"),
        error: details.filter(part => part.includes("feed:")).join(" · "),
        updatedAt: new Date().toISOString()
      };
      return;
    }

    networkState.wiimmfi = {
      name: "Wiimmfi", onlinePlayers: null, rooms: null, players: [],
      roomGroups: [], regions: [], breakdown: null,
      status: "unavailable",
      detail: "Neither public Wiimmfi feed returned a verified Mario Kart Wii snapshot",
      error: "JSON: " + (jsonError || "no valid data") + " · Text: " + (textError || "no valid data"),
      updatedAt: new Date().toISOString()
    };
  }

    function parseWiiLinkSnapshot(statsPayload, groupPayload, groupDetailsAvailable) {
    if (!statsPayload || typeof statsPayload !== "object" || Array.isArray(statsPayload) || !Array.isArray(groupPayload)) return null;

    const gameKey = Object.keys(statsPayload).find(key => key.toLowerCase() === "mariokartwii");
    const gameStats = gameKey ? statsPayload[gameKey] : {};
    const globalStats = statsPayload.global;
    if (!gameStats || typeof gameStats !== "object" || !globalStats || typeof globalStats !== "object") return null;

    const rooms = groupPayload
      .filter(group => group && (!group.game || String(group.game).toLowerCase() === "mariokartwii"))
      .map((group, index) => {
        const playerMap = group.players && typeof group.players === "object" && !Array.isArray(group.players)
          ? group.players : {};
        const players = Object.values(playerMap).map(player => ({
          name: player.name || "Unknown player",
          pid: player.pid || "",
          friendCode: player.fc || "",
          versusElo: number(player.ev),
          battleElo: number(player.eb),
          consolePlayers: Math.max(1, number(player.count) || 1),
          suspended: String(player.suspend || "0") !== "0",
          connectionMap: String(player.conn_map || ""),
          connectionFailures: number(player.conn_fail) || 0,
          miis: Array.isArray(player.mii) ? player.mii : []
        }));
        return {
          id: String(group.id || "Room " + (index + 1)),
          type: group.type || "unknown",
          region: group.rk || "",
          host: group.host == null ? "" : String(group.host),
          created: group.created || null,
          suspended: !!group.suspend,
          race: group.race || null,
          players,
          playerSlots: players.reduce((sum, player) => sum + player.consolePlayers, 0)
        };
      });

    const roomPlayerSlots = rooms.reduce((sum, room) => sum + room.playerSlots, 0);
    const roomConsoleSessions = rooms.reduce((sum, room) => sum + room.players.length, 0);
    // /api/stats counts GameSpy sessions (consoles). Room player records also expose
    // local-player slots, so only split-screen extras are added to the console count.
    const extraLocalSlots = Math.max(0, roomPlayerSlots - roomConsoleSessions);
    const onlineSessions = gameKey ? number(gameStats.online) : 0;
    const activeSessions = gameKey ? number(gameStats.active) : 0;
    const onlinePlayers = (onlineSessions === null ? 0 : onlineSessions) + extraLocalSlots;
    const activePlayers = (activeSessions === null ? 0 : activeSessions) + extraLocalSlots;
    const roomCount = number(gameStats.groups) !== null ? Number(gameStats.groups) : rooms.length;

    return {
      onlinePlayers: groupDetailsAvailable === false ? null : onlinePlayers,
      onlineSessions,
      activePlayers: groupDetailsAvailable === false ? null : activePlayers,
      activeSessions,
      rooms: roomCount, roomGroups: rooms,
      status: "live",
      detail: "Live Mario Kart Wii stats and room details from WiiLink's public API",
      updatedAt: new Date().toISOString()
    };
  }

    async function fetchWiiLinkJson(endpoint) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12000);
    try {
      const response = await fetch(WIILINK_API + endpoint, {
        method: "GET",
        mode: "cors",
        credentials: "omit",
        cache: "no-store",
        redirect: "follow",
        headers: { "Accept": "application/json" },
        signal: controller.signal
      });
      const body = await response.text();
      if (!response.ok) throw new Error(endpoint + " returned HTTP " + response.status + (body ? ": " + body.slice(0, 180) : ""));
      try {
        return JSON.parse(body);
      } catch (error) {
        throw new Error(endpoint + " returned invalid JSON: " + String(error && error.message || error) + (body ? " · " + body.slice(0, 120) : ""));
      }
    } finally {
      clearTimeout(timeout);
    }
  }

  async function refreshWiiLink() {
    const statsPath = "/stats?game=mariokartwii";
    const groupsPath = "/groups?game=mariokartwii";
    const [statsResult, groupsResult] = await Promise.allSettled([
      fetchWiiLinkJson(statsPath),
      fetchWiiLinkJson(groupsPath)
    ]);

    if (statsResult.status === "rejected") {
      const statsError = explainFeedError(statsResult.reason);
      const groupsError = groupsResult.status === "rejected"
        ? explainFeedError(groupsResult.reason) : null;
      networkState.wiilink = {
        name: "WiiLink WFC", onlinePlayers: null, activePlayers: null,
        onlineSessions: null, activeSessions: null, rooms: null,
        roomGroups: [], regions: [], status: "unavailable",
        detail: "The WiiLink stats endpoint could not be read",
        error: statsError + (groupsError ? " · " + groupsPath + ": " + groupsError : ""),
        updatedAt: new Date().toISOString()
      };
      return;
    }

    const groupsPayload = groupsResult.status === "fulfilled" ? groupsResult.value : [];
    const parsed = parseWiiLinkSnapshot(statsResult.value, groupsPayload, groupsResult.status === "fulfilled");
    if (!parsed) {
      networkState.wiilink = {
        name: "WiiLink WFC", onlinePlayers: null, activePlayers: null,
        onlineSessions: null, activeSessions: null, rooms: null,
        roomGroups: [], regions: [], status: "unavailable",
        detail: "WiiLink stats endpoint responded, but its JSON shape was not recognized",
        error: "Stats payload keys: " + Object.keys(statsResult.value || {}).join(", "),
        updatedAt: new Date().toISOString()
      };
      return;
    }

    const groupError = groupsResult.status === "rejected"
      ? explainFeedError(groupsResult.reason) : null;
    networkState.wiilink = Object.assign({
      name: "WiiLink WFC",
      regions: [],
      error: groupError,
      detail: groupError
        ? "Console/session and room totals are live; player-slot counts are withheld because room detail failed"
        : "Live Mario Kart Wii population, rooms, player ELO and connection telemetry"
    }, parsed, {
      status: groupError ? "partial" : "live"
    });
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
      .filter(provider => (provider.status === "live" || provider.status === "partial") && number(provider[field]) !== null)
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
      const telemetry = provider.breakdown || {};
      features = capability("Live MKWii status", provider.onlinePlayers === null ? "not readable" : "yes", provider.onlinePlayers !== null) +
        capability("Race / battle state", provider.breakdown ? "yes" : "not in feed", !!provider.breakdown) +
        capability("Public / private rooms", provider.breakdown ? "yes" : "not in feed", !!provider.breakdown) +
        capability("Historical race archive", "not in public status feed", false);
      if (provider.breakdown) {
        substats = '<div class="network-substats"><div><b>' + fmt(telemetry.race) + '</b><span>RACING SLOTS</span></div><div><b>' + fmt(telemetry.battle) + '</b><span>IN BATTLES</span></div><div><b>' + fmt(telemetry.searching) + '</b><span>SEARCHING</span></div><div><b>' + fmt(telemetry.private) + '</b><span>PRIVATE-ROOM SLOTS</span></div></div>';
      }
    } else {
      features = capability("Live rooms / players", provider.onlinePlayers === null ? "unavailable" : "yes", provider.onlinePlayers !== null) +
        capability("Friend codes", "yes", true) +
        capability("VS / Battle ELO", "yes", true) +
        capability("Connection quality", provider.roomGroups && provider.roomGroups.length ? "yes" : "not in active rooms", !!(provider.roomGroups && provider.roomGroups.length));
      substats = '<div class="network-substats"><div><b>' + fmt(provider.activePlayers) + '</b><span>ACTIVE PLAYER SLOTS</span></div><div><b>' + fmt(provider.onlineSessions) + '</b><span>ONLINE CONSOLES</span></div></div>';
    }
    return '<article class="network-card">' +
      '<div class="network-card-head"><div><div class="network-name">' + esc(provider.name) + '</div><div class="network-source">' + esc(provider.key === "retro" ? "RETRO REWIND / RETRO WFC" : provider.key === "wiimmfi" ? "WIIMMFI PROJECT" : "WIILINK TEAM") + '</div></div>' + statusLabel(provider) + '</div>' +
      '<div class="network-numbers"><div><span>MKWII PLAYERS ONLINE</span><b>' + fmt(provider.onlinePlayers) + '</b></div><div><span>ACTIVE ROOMS</span><b>' + fmt(provider.rooms) + '</b></div></div>' +
      substats +
      '<p class="network-detail">' + esc(provider.detail || "") + '</p>' +
      (provider.error ? '<p class="network-detail network-error">FEED DIAGNOSTIC · ' + esc(provider.error) + '</p>' : '') +
      '<p class="network-checked">LAST SOURCE UPDATE · ' + esc(localTime(provider.updatedAt)) + '</p>' +
      '<div class="network-capabilities">' + features + '</div>' +
      '<a class="network-external" href="' + esc(provider.url) + '" target="_blank" rel="noopener noreferrer">OPEN OFFICIAL SOURCE ↗</a>' +
      '</article>';
  }

  function renderNetworkActivity() {
    const wiimmfi = networkState.wiimmfi;
    const wiilink = networkState.wiilink;
    const wiimmfiRegions = (wiimmfi.regions || []).slice(0, appState().detailedAnalytics ? (wiimmfi.regions || []).length : 30).map(region =>
      '<tr><td class="mono">' + esc(region.id) + '</td><td class="mono lime">' + fmt(region.players) + '</td></tr>'
    ).join("");
    const wiimmfiRooms = (wiimmfi.roomGroups || []).slice(0, 60).map(room => {
      const count = number(room.playerCount) !== null ? room.playerCount
        : Array.isArray(room.roster) ? room.roster.length
        : number(room.players);
      return '<tr><td class="mono">' + esc(room.id || "—") + '</td><td class="mono">' + esc(room.region || "—") + '</td><td>' +
        esc(room.privateRoom == null ? "—" : room.privateRoom ? "Private" : "Public") + '</td><td>' +
        esc(room.onlineScope || room.mode || "—") + '</td><td>' + fmt(count) + '</td></tr>';
    }).join("");
    const wiimmfiPlayers = (wiimmfi.players || []).slice(0, 100).map(player =>
      '<tr><td><b>' + esc(player.name) + '</b></td><td>' + esc(player.mode) + '</td><td>' +
      esc(player.role || "—") + '</td><td class="mono">' + esc(player.room || "—") + '</td><td class="mono">' +
      esc(player.region || "—") + '</td><td>' + esc(player.privateRoom ? "Private" : "Public") + ' · ' +
      esc(player.onlineScope || "—") + '</td></tr>'
    ).join("");
    const wiimmfiTelemetry = wiimmfi.breakdown
      ? '<div class="network-substats">' +
        '<div><b>' + fmt(wiimmfi.breakdown.active) + '</b><span>ACTIVE SLOTS</span></div>' +
        '<div><b>' + fmt(wiimmfi.breakdown.worldwide) + '</b><span>WORLDWIDE</span></div>' +
        '<div><b>' + fmt(wiimmfi.breakdown.continental) + '</b><span>CONTINENTAL</span></div>' +
        '<div><b>' + fmt(wiimmfi.breakdown.hosts) + '</b><span>HOST SLOTS</span></div>' +
        '</div>' : '';
    const wiimmfiSection = (wiimmfi.regions || []).length || (wiimmfi.roomGroups || []).length || (wiimmfi.players || []).length
      ? '<section><div class="panel-title"><strong>Wiimmfi</strong><small>Live status, room classification and player states</small></div>' +
        wiimmfiTelemetry +
        '<div class="table-wrap"><table class="data-table"><thead><tr><th>REGION</th><th>PLAYER SLOTS</th></tr></thead><tbody>' +
        (wiimmfiRegions || '<tr><td colspan="2">Regional breakdown not exposed</td></tr>') +
        '</tbody></table></div>' +
        '<div class="table-wrap"><table class="data-table"><thead><tr><th>ROOM</th><th>REGION</th><th>ACCESS</th><th>SCOPE / MODE</th><th>PLAYERS</th></tr></thead><tbody>' +
        (wiimmfiRooms || '<tr><td colspan="5">No room rows in the readable feed</td></tr>') +
        '</tbody></table></div>' +
        '<div class="table-wrap"><table class="data-table"><thead><tr><th>PLAYER</th><th>STATE</th><th>ROLE</th><th>ROOM</th><th>REGION</th><th>ROOM TYPE / SCOPE</th></tr></thead><tbody>' +
        (wiimmfiPlayers || '<tr><td colspan="6">Player-level status text feed unavailable; counts may still come from the room JSON feed</td></tr>') +
        '</tbody></table></div></section>'
      : '<section><div class="panel-title"><strong>Wiimmfi</strong><small>Live activity detail</small></div><div class="empty-state">Room and player details unavailable from the current Wiimmfi feeds.</div></section>';

    const wiilinkRooms = (wiilink.roomGroups || []).slice(0, 60).map(room => {
      const race = room.race || {};
      const course = race.course == null ? "—" : "Course " + race.course;
      const players = room.players.map(player =>
        '<div class="network-player-line"><b>' + esc(player.name) + '</b><span>' +
        (player.friendCode ? esc(player.friendCode) + " · " : "") +
        'VS ' + fmt(player.versusElo) + ' / BT ' + fmt(player.battleElo) +
        (player.consolePlayers > 1 ? " · " + player.consolePlayers + "P" : "") +
        (player.connectionMap ? " · LINK " + player.connectionMap : "") +
        (player.connectionFailures ? " · " + player.connectionFailures + " failed links" : "") +
        (player.miis && player.miis.length && player.miis[0].name ? " · Mii " + esc(player.miis[0].name) : "") +
        '</span></div>'
      ).join("");
      return '<tr><td class="mono">' + esc(room.id) + '</td><td>' + esc(room.type) +
        (room.suspended ? ' · SUSPENDED' : '') + '</td><td>' + esc(room.region || "—") +
        '</td><td>' + esc(room.created ? localTime(room.created) : "—") + (room.host ? " · HOST " + esc(room.host) : "") +
        '</td><td>' + esc(course) + (race.num == null ? "" : " · Race " + esc(race.num)) +
        (race.cc == null ? "" : " · " + esc(race.cc) + " CC") + '</td><td>' +
        fmt(room.playerSlots) + '<div class="network-room-players">' + players + '</div></td></tr>';
    }).join("");

    const wiilinkSection = wiilink.status === "live" || wiilink.status === "partial"
      ? '<section><div class="panel-title"><strong>WiiLink WFC</strong><small>Live rooms, player ELO and connection telemetry</small></div>' +
        '<div class="table-wrap"><table class="data-table"><thead><tr><th>ROOM</th><th>TYPE</th><th>REGION</th><th>CREATED / HOST</th><th>RACE / COURSE</th><th>PLAYERS · VS / BATTLE ELO</th></tr></thead><tbody>' +
        (wiilinkRooms || '<tr><td colspan="6">No active room records</td></tr>') +
        '</tbody></table></div></section>'
      : '<section><div class="panel-title"><strong>WiiLink WFC</strong><small>Live activity detail</small></div><div class="empty-state">WiiLink live room details are currently unavailable. ' + esc(wiilink.error || "") + '</div></section>';

    return '<div class="network-live-grid">' + wiimmfiSection + wiilinkSection + '</div>';
  }

  const networkSectionTitles = {
    rooms: ["ROOM SCANNER", "Browse active rooms and their current player rosters."],
    players: ["PLAYER DIRECTORY", "Inspect currently visible players and network-specific ratings."],
    races: ["RACE ACTIVITY", "Live race state and race-history coverage for this network."],
    meta: ["NETWORK META", "Live population, activity and network-specific performance metrics."],
    "time-trials": ["TIME TRIALS", "Time-trial and ghost-record coverage for this network."]
  };
  let activeSectionPage = null;

  function networkPageShell(section, network, body) {
    const names = { retro: "RETRO WFC", wiimmfi: "WIIMMFI", wiilink: "WIILINK WFC" };
    const heading = networkSectionTitles[section] || ["NETWORK DATA", "Live network telemetry."];
    return '<div class="network-section-heading"><div><div class="network-eyebrow">' +
      esc(names[network] || network.toUpperCase()) + ' // ' + esc(heading[0]) +
      '</div><p class="network-detail">' + esc(heading[1]) +
      '</p></div><span class="network-section-tag">' + esc(names[network] || network.toUpperCase()) + '</span></div>' + body;
  }

  function networkStat(label, value) {
    return '<div class="network-section-stat"><b>' + fmt(value) + '</b><span>' + esc(label) + '</span></div>';
  }

  function networkPanel(title, subtitle, body) {
    return '<section class="panel network-notes"><div class="panel-head"><div class="panel-title"><strong>' +
      esc(title) + '</strong><small>' + esc(subtitle) +
      '</small></div></div><div class="panel-body">' + body + '</div></section>';
  }

  function networkUnavailable(title, message, diagnostic) {
    return networkPanel(title, "SOURCE COVERAGE", '<div class="network-unsupported"><strong>' + esc(title) +
      '</strong><p>' + esc(message) + '</p>' +
      (diagnostic ? '<p class="network-error" style="margin-top:10px">' + esc(diagnostic) + '</p>' : '') +
      '</div>');
  }

  function wiimmfiRoomCount(room) {
    if (number(room.playerCount) !== null) return Number(room.playerCount);
    if (Array.isArray(room.roster)) return room.roster.length;
    return number(room.players) === null ? 0 : Number(room.players);
  }

  function renderWiimmfiRoomsPage() {
    const w = networkState.wiimmfi;
    const rooms = Array.isArray(w.roomGroups) ? w.roomGroups : [];
    const b = w.breakdown || {};
    const cards = rooms.map((room, index) => {
      const count = room.playerCount == null ? room.players : room.playerCount;
      const facts = [
        ["PLAYER SLOTS", count == null ? "—" : fmt(count)],
        ["REGION CODE", room.region || null],
        ["ACCESS", room.privateRoom == null ? null : room.privateRoom ? "Private" : "Public"],
        ["MATCH TYPE", room.mode || null],
        ["SCOPE", room.onlineScope || null],
        ["TRACK / COURSE", room.track || null],
        ["RACE #", room.raceNumber == null ? null : room.raceNumber],
        ["CREATED", room.created == null ? null : room.created],
        ["HOST", room.host || null]
      ].filter(([, value]) => value !== null && value !== undefined && value !== "");
      const factsHtml = facts.length
        ? '<div class="wiimmfi-room-facts">' + facts.map(([label, value]) => '<div><span>' + esc(label) + '</span><b>' + esc(value) + '</b></div>').join("") + '</div>'
        : '<p class="network-section-note">No descriptive fields were included for this room in the current response.</p>';
      const roster = Array.isArray(room.roster) ? room.roster : [];
      const rosterHtml = roster.length ? '<div class="wiimmfi-room-roster"><strong>ROSTER</strong>' +
        roster.map(player => '<span>' + esc(player.name || player.nick || "Unknown player") + '</span>').join("") + '</div>' : "";
      const extra = Array.isArray(room.details) && room.details.length
        ? '<details class="wiimmfi-room-extra"><summary>Additional feed fields (' + room.details.length + ')</summary>' +
          room.details.map(item => '<div><span>' + esc(item.label) + '</span><b>' + esc(item.value) + '</b></div>').join("") + '</details>' : "";
      return '<article class="wiimmfi-room-card"><header><div><small>ROOM ' + (index + 1) + '</small><strong>' + esc(room.id || "ID unavailable") +
        '</strong></div><b>' + (count == null ? "—" : fmt(count) + " PLAYERS") + '</b></header>' + factsHtml + rosterHtml + extra + '</article>';
    }).join("");
    const hasDetails = rooms.some(room => (room.roster && room.roster.length) || (room.details && room.details.length) ||
      room.privateRoom != null || room.mode || room.onlineScope || room.track || room.created || room.raceNumber != null || room.host);
    const explanation = !hasDetails
      ? '<div class="network-important"><strong>Why you only see basic room information:</strong> the readable Wiimmfi JSON feed supplies room identifiers and a small amount of count/region metadata. It does not provide player names, room membership, track, host, room age or race history. Those fields are not being hidden by the dashboard; they are absent from this response.</div>'
      : '<div class="network-important"><strong>Room detail coverage:</strong> cards display the fields Wiimmfi returned. Missing fields are not available in this snapshot.</div>';
    const body = '<div class="network-section-grid">' +
      networkStat("ONLINE PLAYER SLOTS", w.onlinePlayers) +
      networkStat("ACTIVE ROOMS", w.rooms) +
      networkStat("RACING", b.race) +
      networkStat("BATTLE", b.battle) +
      '</div>' + explanation +
      networkPanel("Current Wiimmfi rooms", "Room-by-room information returned by the public feed",
        cards ? '<div class="wiimmfi-room-grid">' + cards + '</div>' :
          '<p class="network-section-note">The current snapshot returned no individual room records.</p>') +
      (w.players && w.players.length
        ? networkPanel("Player and room status", "Names, status, roles and room assignments", renderWiimmfiPlayerRows(w.players))
        : networkPanel("Player and room roster coverage", "Separate Wiimmfi online-status text feed",
          '<p class="network-section-note">The separate player-status feed is currently failing in this browser session. It is the source that can expose names, room assignments, public/private state, matchmaking scope and race/battle/search state. The JSON room-count feed does not contain that roster.</p>' +
          '<p style="margin-top:10px"><a class="network-external" href="' + esc(WIIMMFI_URL) + '" target="_blank" rel="noopener noreferrer">OPEN RAW PLAYER-STATUS FEED ↗</a></p>' +
          (w.error ? '<p class="network-error" style="margin-top:10px">' + esc(w.error) + '</p>' : ''))) +
      networkPanel("Official Wiimmfi room statistics", "Open the canonical room page",
        '<p class="network-section-note">Wiimmfi’s own room statistics page is the official place to inspect room links and available history. The dashboard will not invent room/player details missing from its machine-readable feed.</p>' +
        '<p><a class="network-external" href="' + esc(WIIMMFI_PAGE) + '" target="_blank" rel="noopener noreferrer">OPEN OFFICIAL WIIMMFI ROOM PAGE ↗</a></p>');
    return body;
  }

  function renderWiimmfiPlayerRows(players) {
    const rows = (players || []).map(player => '<tr><td><b>' + esc(player.name) + '</b></td><td>' + esc(player.mode || "—") +
      '</td><td>' + esc(player.role || "—") + '</td><td class="mono">' + esc(player.room || "—") +
      '</td><td class="mono">' + esc(player.region || "—") + '</td><td>' +
      esc(player.privateRoom ? "Private" : "Public") + ' · ' + esc(player.onlineScope || "—") + '</td></tr>').join("");
    return '<div class="table-wrap"><table class="data-table"><thead><tr><th>PLAYER</th><th>STATE</th><th>ROLE</th><th>ROOM</th><th>REGION</th><th>ACCESS / SCOPE</th></tr></thead><tbody>' +
      (rows || '<tr><td colspan="6">No player records are present in the current feed.</td></tr>') +
      '</tbody></table></div>';
  }

  function renderWiimmfiPlayersPage() {
    const w = networkState.wiimmfi;
    const b = w.breakdown || {};
    return '<div class="network-section-grid">' +
      networkStat("ONLINE SLOTS", w.onlinePlayers) +
      networkStat("RACING", b.race) +
      networkStat("BATTLE", b.battle) +
      networkStat("SEARCHING", b.searching) +
      '</div>' +
      networkPanel("Wiimmfi live player list", "Player identity and online state from public status records",
        w.players && w.players.length
          ? renderWiimmfiPlayerRows(w.players)
          : '<p class="network-section-note">The room-count feed can be read, but the separate Wiimmfi player-status text feed failed. Player names, roles and per-player room state will appear here when that feed is accessible.</p>' +
            '<p style="margin-top:10px"><a class="network-external" href="' + esc(WIIMMFI_URL) + '" target="_blank" rel="noopener noreferrer">OPEN RAW PLAYER-STATUS FEED ↗</a></p>' +
            (w.error ? '<p class="network-error" style="margin-top:10px">' + esc(w.error) + '</p>' : ''));
  }

  function renderWiimmfiRacesPage() {
    const w = networkState.wiimmfi;
    const b = w.breakdown || {};
    return '<div class="network-section-grid">' +
      networkStat("PLAYERS RACING", b.race) +
      networkStat("PLAYERS IN BATTLES", b.battle) +
      networkStat("ACTIVE MATCHES", b.active) +
      networkStat("SEARCHING", b.searching) +
      '</div>' +
      networkUnavailable("No public historical race archive",
        "Wiimmfi’s public HTTP status feed reports whether players are in a race or battle, but it does not publish a persistent finishing-order archive, track history or race-by-race results. The richer wiimmfi=race and wiimmfi=room protocol records are sent to game clients; they are not present in the public room-count JSON feed. This page therefore reports live race state only, without inventing race results.",
        w.error);
  }

  function renderWiimmfiMetaPage() {
    const w = networkState.wiimmfi;
    const b = w.breakdown || {};
    const metrics = [
      ["ONLINE SLOTS", w.onlinePlayers], ["ACTIVE", b.active], ["RACING", b.race],
      ["BATTLE", b.battle], ["SEARCHING", b.searching], ["CONNECTING", b.connecting],
      ["PRIVATE-ROOM SLOTS", b.private], ["PUBLIC-ROOM SLOTS", b.public],
      ["WORLDWIDE", b.worldwide], ["CONTINENTAL", b.continental],
      ["HOST SLOTS", b.hosts], ["GUEST SLOTS", b.guests], ["VIEWER SLOTS", b.viewers],
      ["CONSOLES", b.consoles]
    ];
    const regions = (w.regions || []).map(r => '<tr><td class="mono">' + esc(r.id) +
      '</td><td>' + fmt(r.players) + '</td></tr>').join("");
    return '<div class="network-section-grid">' + metrics.map(item => networkStat(item[0], item[1])).join("") +
      '</div>' + networkPanel("Wiimmfi regional population", "Current region counts, when published by the feed",
        '<div class="table-wrap"><table class="data-table"><thead><tr><th>REGION</th><th>PLAYER SLOTS</th></tr></thead><tbody>' +
        (regions || '<tr><td colspan="2">Regional detail is not available in the current readable feed.</td></tr>') +
        '</tbody></table></div>') +
      (w.error ? networkPanel("Feed availability", "Current source diagnostics", '<p class="network-error">' + esc(w.error) + '</p>') : '');
  }

  function allWiiLinkPlayers() {
    return (networkState.wiilink.roomGroups || []).flatMap(room =>
      (room.players || []).map(player => Object.assign({ roomId: room.id, roomType: room.type, region: room.region }, player)));
  }

  function renderWiiLinkRoomsPage() {
    const w = networkState.wiilink;
    const rooms = w.roomGroups || [];
    const rows = rooms.map(room => {
      const race = room.race || {};
      const roster = (room.players || []).map(player => '<div class="network-player-line"><b>' + esc(player.name) +
        '</b><span>' + (player.friendCode ? esc(player.friendCode) + ' · ' : '') +
        'VS ' + fmt(player.versusElo) + ' / BT ' + fmt(player.battleElo) +
        (player.consolePlayers > 1 ? ' · ' + player.consolePlayers + 'P' : '') +
        (player.connectionFailures ? ' · ' + player.connectionFailures + ' failed links' : '') +
        '</span></div>').join("");
      return '<tr><td class="mono">' + esc(room.id) + '</td><td>' + esc(room.type) +
        (room.suspended ? ' · SUSPENDED' : '') + '</td><td>' + esc(room.region || "—") +
        '</td><td>' + esc(room.created ? localTime(room.created) : "—") +
        '</td><td>' + (race.num == null ? "—" : 'Race ' + fmt(race.num)) +
        (race.course == null ? "" : ' · Course ' + fmt(race.course)) +
        (race.cc == null ? "" : ' · ' + fmt(race.cc) + ' CC') +
        '</td><td>' + fmt(room.playerSlots) + '<div class="network-room-players">' + roster + '</div></td></tr>';
    }).join("");
    return '<div class="network-section-grid">' +
      networkStat("PLAYERS ONLINE", w.onlinePlayers) +
      networkStat("ACTIVE PLAYER SLOTS", w.activePlayers) +
      networkStat("ONLINE CONSOLES", w.onlineSessions) +
      networkStat("ACTIVE ROOMS", w.rooms) +
      '</div>' + networkPanel("WiiLink active rooms", "Public and private groups, race metadata and current player rosters",
        '<div class="table-wrap"><table class="data-table"><thead><tr><th>ROOM</th><th>TYPE</th><th>REGION / MATCH</th><th>CREATED</th><th>RACE / COURSE</th><th>PLAYER SLOTS / ROSTER</th></tr></thead><tbody>' +
        (rows || '<tr><td colspan="6">No active Mario Kart Wii room groups are currently returned.</td></tr>') +
        '</tbody></table></div>' +
        (w.error ? '<p class="network-error" style="margin-top:12px">ROOM DETAIL FEED · ' + esc(w.error) + '</p>' : ''));
  }

  function renderWiiLinkPlayersPage() {
    const w = networkState.wiilink;
    const players = allWiiLinkPlayers();
    const rows = players.map(player => '<tr><td><b>' + esc(player.name) + '</b></td><td class="mono">' +
      esc(player.pid || "—") + '</td><td class="mono">' + esc(player.friendCode || "—") +
      '</td><td>' + fmt(player.versusElo) + '</td><td>' + fmt(player.battleElo) +
      '</td><td>' + fmt(player.consolePlayers) + '</td><td>' +
      (player.suspended ? "Suspended" : "Normal") + '</td><td class="mono">' +
      esc(player.roomId) + '</td></tr>').join("");
    return '<div class="network-section-grid">' +
      networkStat("VISIBLE CONSOLES", w.onlineSessions) +
      networkStat("PLAYER SLOTS", w.onlinePlayers) +
      networkStat("ACTIVE SLOTS", w.activePlayers) +
      networkStat("ROOM ROSTERS", players.length) +
      '</div>' + networkPanel("WiiLink live player directory", "Current online group members, friend codes and WiiLink ELO ratings",
        '<div class="table-wrap"><table class="data-table"><thead><tr><th>PLAYER</th><th>PROFILE ID</th><th>FRIEND CODE</th><th>VS ELO</th><th>BATTLE ELO</th><th>LOCAL SLOTS</th><th>STATUS</th><th>ROOM</th></tr></thead><tbody>' +
        (rows || '<tr><td colspan="8">No player roster returned. If the room endpoint is unavailable, the console/session totals remain separate and player-slot totals are withheld.</td></tr>') +
        '</tbody></table></div>' +
        (w.error ? '<p class="network-error" style="margin-top:12px">ROOM DETAIL FEED · ' + esc(w.error) + '</p>' : ''));
  }

  function renderWiiLinkRacesPage() {
    const w = networkState.wiilink;
    const races = (w.roomGroups || []).filter(room => room.race && Number(room.race.num || 0) > 0);
    const rows = races.map(room => {
      const race = room.race || {};
      return '<tr><td class="mono">' + esc(room.id) + '</td><td>' + esc(room.type) +
        '</td><td>' + fmt(race.num) + '</td><td>' + fmt(race.course) +
        '</td><td>' + (race.cc == null ? "—" : fmt(race.cc) + " CC") +
        '</td><td>' + fmt(room.playerSlots) + '</td></tr>';
    }).join("");
    return '<div class="network-section-grid">' +
      networkStat("ACTIVE ROOMS", w.rooms) +
      networkStat("ROOMS WITH RACE DATA", races.length) +
      networkStat("ONLINE PLAYER SLOTS", w.onlinePlayers) +
      networkStat("ACTIVE PLAYER SLOTS", w.activePlayers) +
      '</div>' + networkPanel("Current WiiLink race metadata", "Live race number, course and engine class from active MKWii groups",
        '<div class="table-wrap"><table class="data-table"><thead><tr><th>ROOM</th><th>TYPE</th><th>RACE #</th><th>COURSE ID</th><th>ENGINE CLASS</th><th>PLAYER SLOTS</th></tr></thead><tbody>' +
        (rows || '<tr><td colspan="6">No active room currently exposes race metadata. WiiLink does not provide a persistent race-results archive through these public endpoints.</td></tr>') +
        '</tbody></table></div>');
  }

  function renderWiiLinkMetaPage() {
    const w = networkState.wiilink;
    const players = allWiiLinkPlayers();
    const byVs = players.filter(p => number(p.versusElo) !== null).slice().sort((a, b) => b.versusElo - a.versusElo).slice(0, appState().detailedAnalytics ? players.length : 8);
    const byBattle = players.filter(p => number(p.battleElo) !== null).slice().sort((a, b) => b.battleElo - a.battleElo).slice(0, appState().detailedAnalytics ? players.length : 8);
    const failures = players.reduce((sum, p) => sum + (number(p.connectionFailures) || 0), 0);
    const slots = players.reduce((sum, p) => sum + (number(p.consolePlayers) || 0), 0);
    const rankRows = items => '<div class="rank-list">' + (items.length ? items.map((p, i) =>
      '<div class="rank-row"><span class="rank-number">' + String(i + 1).padStart(2, "0") +
      '</span><span class="rank-name">' + esc(p.name) + '<div class="subnote">' + esc(p.roomId) +
      '</div></span><span class="rank-value">' + fmt(p.versusElo) + '</span></div>').join("")
      : '<div class="empty-state">NO LIVE ELO ROWS</div>') + '</div>';
    const battleRows = items => '<div class="rank-list">' + (items.length ? items.map((p, i) =>
      '<div class="rank-row"><span class="rank-number">' + String(i + 1).padStart(2, "0") +
      '</span><span class="rank-name">' + esc(p.name) + '<div class="subnote">' + esc(p.roomId) +
      '</div></span><span class="rank-value">' + fmt(p.battleElo) + '</span></div>').join("")
      : '<div class="empty-state">NO LIVE ELO ROWS</div>') + '</div>';
    return '<div class="network-section-grid">' +
      networkStat("ONLINE CONSOLES", w.onlineSessions) +
      networkStat("PLAYER SLOTS", w.onlinePlayers) +
      networkStat("LOCAL PLAYER SLOTS", slots) +
      networkStat("CONNECTION FAILURES", failures) +
      '</div><div class="lower-grid">' +
      '<section class="panel"><div class="panel-head"><div class="panel-title"><strong>Live VS ELO leaders</strong><small>Only currently visible WiiLink players</small></div></div><div class="panel-body">' + rankRows(byVs) + '</div></section>' +
      '<section class="panel"><div class="panel-head"><div class="panel-title"><strong>Live Battle ELO leaders</strong><small>Kept separate from VS ELO</small></div></div><div class="panel-body">' + battleRows(byBattle) + '</div></section></div>';
  }

  function renderNetworkSection(section, network) {
    if (network === "retro") {
      if (section === "time-trials") return networkUnavailable("Retro WFC time trials loading", "The existing Retro WFC time-trial view is opened through its original loader.");
      const renderers = { rooms: "renderRooms", races: "renderRaces", players: "renderPlayers", meta: "renderMeta" };
      const fn = renderers[section] && window[renderers[section]];
      return typeof fn === "function" ? fn() : networkUnavailable("Retro WFC page unavailable", "The original Retro WFC renderer was not found.");
    }
    if (network === "wiimmfi") {
      if (section === "rooms") return renderWiimmfiRoomsPage();
      if (section === "players") return renderWiimmfiPlayersPage();
      if (section === "races") return renderWiimmfiRacesPage();
      if (section === "meta") return renderWiimmfiMetaPage();
    }
    if (network === "wiilink") {
      if (section === "rooms") return renderWiiLinkRoomsPage();
      if (section === "players") return renderWiiLinkPlayersPage();
      if (section === "races") return renderWiiLinkRacesPage();
      if (section === "meta") return renderWiiLinkMetaPage();
    }
    return networkUnavailable("No public " + (network === "wiimmfi" ? "Wiimmfi" : "WiiLink") + " time-trial feed",
      "This network does not publish a public MKWii ghost or time-trial leaderboard through the endpoints currently available to the dashboard. The submenu is retained for consistency, but no results are fabricated.");
  }

  function updateNetworkNavState() {
    document.querySelectorAll(".nav-menu").forEach(menu => {
      const section = menu.dataset.navSection;
      const selected = !!activeSectionPage && activeSectionPage.section === section;
      const summary = menu.querySelector("summary");
      if (summary) summary.classList.toggle("active", selected);
      menu.querySelectorAll(".nav-subtab").forEach(button => {
        button.classList.toggle("active", !!activeSectionPage &&
          button.dataset.page === activeSectionPage.section &&
          button.dataset.network === activeSectionPage.network);
      });
      if (!selected) menu.open = false;
    });
    document.querySelectorAll(".nav-tab[data-view]").forEach(button => {
      button.classList.toggle("active", !activeSectionPage && button.dataset.view === (appState().view === "networks" ? "networks" : "overview"));
    });
  }

  function setNetworkSectionPage(section, network) {
    activeSectionPage = { section, network };
    updateNetworkNavState();
    const s = appState();
    if (s && typeof s === "object") s.view = section;
    const titles = {
      rooms: ["MARIO KART WII // " + network.toUpperCase() + " ROOMS", "Find your <em>next room.</em>", "Current " + network.toUpperCase() + " room information and player rosters."],
      players: ["MARIO KART WII // " + network.toUpperCase() + " PLAYERS", "Who's on the <em>grid?</em>", "Live player records, ratings and connection information published by " + network.toUpperCase() + "."],
      races: ["MARIO KART WII // " + network.toUpperCase() + " RACES", "Race by <em>race.</em>", "Live race telemetry and historical result coverage for " + network.toUpperCase() + "."],
      meta: ["MARIO KART WII // " + network.toUpperCase() + " META", "Read the <em>meta.</em>", "Current activity and network-specific performance data for " + network.toUpperCase() + "."],
      "time-trials": ["MARIO KART WII // " + network.toUpperCase() + " TIME TRIALS", "Chase the <em>record.</em>", "Ghost and time-trial coverage published by " + network.toUpperCase() + "."]
    };
    const h = titles[section] || titles.rooms;
    const eyebrow = document.querySelector("#viewEyebrow");
    const title = document.querySelector("#viewTitle");
    const subtitle = document.querySelector("#viewSubtitle");
    if (eyebrow) eyebrow.textContent = h[0];
    if (title) title.innerHTML = h[1];
    if (subtitle) subtitle.textContent = h[2];

    if (section === "time-trials" && network === "retro") {
      if (typeof originalSetViewForNetwork === "function") originalSetViewForNetwork("time-trials");
      return;
    }
    const root = document.querySelector("#viewContent");
    if (root) {
      try { root.innerHTML = renderNetworkSection(section, network); }
      catch (error) {
        console.error("Network section render failed:", error);
        root.innerHTML = '<section class="panel"><div class="panel-body"><div class="empty-state">PAGE RENDER ERROR · ' + esc(error && error.message || error) + '</div></div></section>';
      }
    }
    if (network === "retro" && section === "players" && typeof window.loadLeaderboard === "function" && appState().leaderboard.length <= 10) window.loadLeaderboard(1);
    if (network === "retro" && section === "races" && typeof window.loadRaces === "function" && appState().races.length <= 12) window.loadRaces(1);
  }

  const originalRenderViewForNetwork = window.renderView;
  const originalSetViewForNetwork = window.setView;
  if (typeof originalRenderViewForNetwork === "function") {
    window.renderView = function renderNetworkSubpageRouter() {
      if (activeSectionPage && activeSectionPage.network !== "retro") {
        const root = document.querySelector("#viewContent");
        if (root) root.innerHTML = renderNetworkSection(activeSectionPage.section, activeSectionPage.network);
        return;
      }
      if (typeof originalRenderViewForNetwork === "function") originalRenderViewForNetwork();
    };
  }
  if (typeof originalSetViewForNetwork === "function") {
    window.setView = function setNetworkSubpageDefault(view) {
      if (["rooms", "races", "players", "meta"].includes(view)) {
        setNetworkSectionPage(view, "retro");
        return;
      }
      if (view === "time-trials") {
        setNetworkSectionPage("time-trials", "retro");
        return;
      }
      activeSectionPage = null;
      updateNetworkNavState();
      originalSetViewForNetwork(view);
    };
  }

  function navigateNetworkSubpage(section, network) {
    const menu = document.querySelector('.nav-menu[data-nav-section="' + section + '"]');
    if (menu) menu.open = false;
    setNetworkSectionPage(section, network);
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
      '<section class="panel network-notes"><div class="panel-head"><div class="panel-title"><strong>Wiimmfi live activity</strong><small>Player names, status and room IDs where the public feed provides them</small></div><span class="panel-kicker">LIVE FEED</span></div><div class="panel-body">' + renderNetworkActivity() + '</div></section>' +
      '<section class="panel network-notes"><div class="panel-head"><div class="panel-title"><strong>Coverage and data boundaries</strong><small>Each online service publishes a different amount of public telemetry</small></div><span class="panel-kicker">DATA NOTES</span></div><div class="panel-body">' +
      '<div class="coverage-row"><b>Retro WFC / Retro Rewind</b><p>Full integration: active rooms and players, VR / BR, public VR leaderboard, player history, recorded races, finish positions, character and vehicle selections, combo analytics, and the server-reported all-time room-population peak.</p></div>' +
      '<div class="coverage-row"><b>Wiimmfi</b><p>Mario Kart Wii-specific machine-readable status feed. It reports online status, player names, room IDs, region and whether a player is in a race, battle, searching or connecting. Its public status feed does not supply a compatible historical race-result archive or the Retro WFC VR scale, so those stats are not invented or mixed.</p></div>' +
      '<div class="coverage-row"><b>WiiLink WFC</b><p>Full live MKWii integration through the public WFC API: game-specific online and active player counts, room counts, room IDs, public/private type, current course and engine class, player names, friend codes, versus ELO and battle ELO. Its public API does not provide a persistent historical race-result archive, so no historical race totals or finish records are fabricated.</p></div>' +
      '<div class="coverage-row"><b>Other/private WFC services</b><p>Private servers and other revival projects can be added when they provide a verifiable Mario Kart Wii-specific status feed. Generic all-game counts and unverified mirrors are intentionally excluded.</p></div>' +
      '<p class="network-footnote">Browser-only deployment: upstream CORS and anti-bot rules may prevent the dashboard from reading a feed. The site reports unavailable data rather than substituting stale or fabricated values. Last network check: ' + esc(lastUpdate) + '.</p>' +
      '</div></section>';
  }

  function setNetworkView() {
    activeSectionPage = null;
    const s = appState();
    if (s && typeof s === "object") s.view = "networks";
    updateNetworkNavState();
    const eyebrow = document.querySelector("#viewEyebrow");
    const title = document.querySelector("#viewTitle");
    const subtitle = document.querySelector("#viewSubtitle");
    if (eyebrow) eyebrow.textContent = "MARIO KART WII // CROSS-SERVER TELEMETRY";
    if (title) title.innerHTML = "One grid, <em>every server.</em>";
    if (subtitle) subtitle.textContent = "Compare live populations across Retro WFC, Wiimmfi, WiiLink WFC and other supported networks.";
    const root = document.querySelector("#viewContent");
    if (!root) return;
    try {
      root.innerHTML = renderNetworks();
    } catch (error) {
      console.error("Networks dashboard render failed:", error);
      root.innerHTML = '<section class="panel"><div class="panel-head"><div class="panel-title"><strong>NETWORK DASHBOARD ERROR</strong><small>The Networks view failed while building its content</small></div></div><div class="panel-body"><div class="empty-state">' + esc(error && error.message ? error.message : error) + '</div></div></section>';
    }
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
    if (activeSectionPage && activeSectionPage.network !== "retro") window.renderView();
    else if (appState().view === "networks") setNetworkView();
  }

  window.rrNetworkStats = {
    refresh: refreshNetworks,
    render: renderNetworks,
    renderSection: renderNetworkSection,
    getSnapshot: () => ({
      combinedPlayers: combined("onlinePlayers"),
      combinedRooms: combined("rooms"),
      providers: providers()
    })
  };

  const refreshButton = document.querySelector("#refreshButton");
  if (refreshButton) refreshButton.addEventListener("click", refreshNetworks);
  // Handle Networks in the capture phase so legacy page handlers cannot leave
  // the previous view mounted or overwrite this route during the same click.
  document.addEventListener("click", event => {
    const target = event.target;
    if (!target || typeof target.closest !== "function") return;
    const subtab = target.closest(".nav-subtab[data-page][data-network]");
    if (subtab) {
      event.preventDefault();
      event.stopImmediatePropagation();
      navigateNetworkSubpage(subtab.dataset.page, subtab.dataset.network);
      return;
    }
    const tab = target.closest('.nav-tab[data-view="networks"]');
    if (tab) {
      event.preventDefault();
      event.stopImmediatePropagation();
      setNetworkView();
    }
  }, true);

  refreshNetworks();
  setInterval(refreshNetworks, REFRESH_MS);
  setInterval(() => {
    if (activeSectionPage && activeSectionPage.network !== "retro") window.renderView();
    else if (appState().view === "networks") setNetworkView();
    if (typeof window.updateMetrics === "function") window.updateMetrics();
  }, 5000);
})();