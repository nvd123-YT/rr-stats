"use strict";

(() => {
  const WIIMMFI_URL = "https://wiimmfi.de/stats/game/mariokartwii/text";
  const WIILINK_URL = "https://wfc.wiilink.ca/online";
  const REFRESH_MS = 45000;
  const networkState = {
    wiimmfi: { name: "Wiimmfi", onlinePlayers: null, rooms: null, status: "waiting", detail: "Waiting for the public status feed", updatedAt: null, error: null },
    wiilink: { name: "WiiLink WFC", onlinePlayers: null, rooms: null, status: "waiting", detail: "Checking the official online browser", updatedAt: null, error: null },
    lastAttempt: null,
    busy: false
  };

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
      return { text: await response.text(), contentType: response.headers.get("content-type") || "" };
    } finally {
      clearTimeout(timeout);
    }
  }

  function parseWiimmfiPayload(raw) {
    const text = String(raw || "");
    const records = text.match(/wiimmfi\s*=\s*status[\s\S]*?(?=wiimmfi\s*=\s*(?:status|room|race|clear)|$)/gi) || [];
    const byPid = new Map();
    const roomIds = new Set();
    let total = 0;

    records.forEach(record => {
      const field = key => {
        const re = new RegExp("(?:^|[\\\\\\\\\\s|;])" + key + "(?:\\\\\\\\|\\s|=|:|\\|)+\\s*(\\d+)", "i");
        const match = record.match(re);
        return match ? Number(match[1]) : null;
      };
      const pidMatch = record.match(/(?:^|[\\\s|;])pid(?:\\|\s|=|:|\|)+\s*(\d+)/i);
      const pid = pidMatch ? pidMatch[1] : String(byPid.size);
      const onlineStatus = field("ol_stat");
      if (onlineStatus !== null && (onlineStatus & 1) === 1 && !byPid.has(pid)) {
        const consolePlayers = field("np");
        byPid.set(pid, consolePlayers && consolePlayers > 0 ? consolePlayers : 1);
        const room = field("room");
        if (room !== null && room > 0) roomIds.add(String(room));
      }
    });

    byPid.forEach(value => { total += value; });
    if (byPid.size) return { onlinePlayers: total, rooms: roomIds.size || null, method: "status records" };

    const body = text.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ");
    const plain = body.replace(/<[^>]+>/g, " ").replace(/&nbsp;|&#160;/gi, " ").replace(/\s+/g, " ");
    const countPatterns = [
      /(?:mario kart wii\s+)?(?:players?|racers?)\s+(?:currently\s+)?online\s*[:=]?\s*(\d+)/i,
      /(?:online\s+)?(?:players?|racers?)\s*[:=]\s*(\d+)/i,
      /(\d+)\s+(?:mario kart wii\s+)?(?:players?|racers?)\s+online/i,
      /(?:current|total)\s+online\s*[:=]\s*(\d+)/i
    ];
    for (const pattern of countPatterns) {
      const match = plain.match(pattern);
      if (match) return { onlinePlayers: Number(match[1]), rooms: null, method: "summary counter" };
    }
    if (/no (?:players|racers|users) online|nobody online/i.test(plain)) {
      return { onlinePlayers: 0, rooms: 0, method: "explicit empty state" };
    }
    return { onlinePlayers: null, rooms: null, method: "unrecognized format" };
  }

  async function refreshWiimmfi() {
    try {
      const result = await fetchText(WIIMMFI_URL, 12000);
      const parsed = parseWiimmfiPayload(result.text);
      networkState.wiimmfi = {
        name: "Wiimmfi",
        onlinePlayers: parsed.onlinePlayers,
        rooms: parsed.rooms,
        status: parsed.onlinePlayers === null ? "partial" : "live",
        detail: parsed.onlinePlayers === null
          ? "Feed reachable, but its current response format did not expose a count"
          : "Live count parsed from Wiimmfi " + parsed.method,
        updatedAt: new Date().toISOString(),
        error: null
      };
    } catch (error) {
      networkState.wiimmfi = {
        name: "Wiimmfi",
        onlinePlayers: null,
        rooms: null,
        status: "unavailable",
        detail: "Browser could not read the public feed (CORS, Cloudflare, or network restriction)",
        updatedAt: new Date().toISOString(),
        error: String(error && error.message || error)
      };
    }
  }

  function parseWiiLinkPage(html) {
    const plain = String(html || "").replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;|&#160;/gi, " ")
      .replace(/\s+/g, " ");
    const patterns = [
      /(?:players?|users?|racers?)\s+(?:currently\s+)?online\s*[:=]?\s*(\d+)/i,
      /(?:online\s+)?(?:players?|users?|racers?)\s*[:=]\s*(\d+)/i,
      /(\d+)\s+(?:players?|users?|racers?)\s+online/i
    ];
    for (const pattern of patterns) {
      const match = plain.match(pattern);
      if (match) return Number(match[1]);
    }
    if (/there seems to be nobody online right now|no players online/i.test(plain)) return 0;
    return null;
  }

  async function refreshWiiLink() {
    try {
      const result = await fetchText(WIILINK_URL, 12000);
      const count = parseWiiLinkPage(result.text);
      networkState.wiilink = {
        name: "WiiLink WFC",
        onlinePlayers: count,
        rooms: null,
        status: count === null ? "partial" : "live",
        detail: count === null
          ? "Official online page responded; no machine-readable Mario Kart Wii count was exposed in its page response"
          : "Count parsed from the official WiiLink online browser",
        updatedAt: new Date().toISOString(),
        error: null
      };
    } catch (error) {
      networkState.wiilink = {
        name: "WiiLink WFC",
        onlinePlayers: null,
        rooms: null,
        status: "linked",
        detail: "Official online browser is available separately; browser-side data access is not exposed",
        updatedAt: new Date().toISOString(),
        error: String(error && error.message || error)
      };
    }
  }

  function retroSnapshot() {
    const s = window.state || {};
    const status = s.roomStatus || {};
    const stats = s.roomStats || {};
    const rooms = Array.isArray(s.rooms) ? s.rooms : Array.isArray(status.rooms) ? status.rooms : [];
    const liveCount = number(s.livePlayerCount);
    const players = liveCount !== null ? liveCount
      : number(stats.totalPlayers) !== null ? Number(stats.totalPlayers)
      : number(status.totalPlayers) !== null ? Number(status.totalPlayers)
      : rooms.length ? rooms.reduce((sum, room) => {
        const p = room && room.players;
        return sum + (Array.isArray(p) ? p.length : p && typeof p === "object" ? Object.keys(p).length : 0);
      }, 0) : null;
    const roomCount = number(stats.totalRooms) !== null ? Number(stats.totalRooms)
      : number(status.totalRooms) !== null ? Number(status.totalRooms)
      : rooms.length ? rooms.length : null;
    return {
      name: "Retro WFC",
      onlinePlayers: players,
      rooms: roomCount,
      status: players === null ? "waiting" : "live",
      detail: "Live RWFC room snapshot; race archive and VR data stay in the Retro WFC section",
      updatedAt: s.lastUpdated ? new Date(s.lastUpdated).toISOString() : null,
      races: number(s.globalStats && s.globalStats.totalRacesTracked),
      trackedPlayers: number(s.globalStats && s.globalStats.uniquePlayersCount),
      url: "https://rwfc.net"
    };
  }

  function getProviders() {
    return [
      Object.assign(retroSnapshot(), { url: "https://rwfc.net", key: "retro" }),
      Object.assign({}, networkState.wiimmfi, { key: "wiimmfi", url: "https://wiimmfi.de/stats/game/mariokartwii" }),
      Object.assign({}, networkState.wiilink, { key: "wiilink", url: WIILINK_URL })
    ];
  }

  function combined(field) {
    const providers = getProviders();
    const values = providers.map(provider => number(provider[field])).filter(value => value !== null);
    return values.length ? values.reduce((sum, value) => sum + value, 0) : null;
  }

  function statusLabel(provider) {
    if (provider.status === "live") return '<span class="network-status live"><i></i> LIVE DATA</span>';
    if (provider.status === "partial") return '<span class="network-status partial"><i></i> PARTIAL</span>';
    if (provider.status === "unavailable") return '<span class="network-status down"><i></i> UNAVAILABLE</span>';
    if (provider.status === "linked") return '<span class="network-status linked"><i></i> LINK ONLY</span>';
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
        capability("Combos / results", "yes", true);
      substats = '<div class="network-substats"><div><b>' + fmt(provider.races) + '</b><span>RECORDED RACES</span></div><div><b>' + fmt(provider.trackedPlayers) + '</b><span>TRACKED PLAYERS</span></div></div>';
    } else if (provider.key === "wiimmfi") {
      features = capability("Online status", provider.onlinePlayers === null ? "not parsed" : "yes", provider.onlinePlayers !== null) +
        capability("Room count", provider.rooms === null ? "not exposed" : "yes", provider.rooms !== null) +
        capability("Public VR archive", "not exposed", false) +
        capability("Race-result archive", "not exposed", false);
    } else {
      features = capability("Online browser", "yes", true) +
        capability("Machine-readable count", provider.onlinePlayers === null ? "not exposed" : "yes", provider.onlinePlayers !== null) +
        capability("Public VR archive", "not exposed here", false) +
        capability("Race-result archive", "not exposed here", false);
    }
    return '<article class="network-card">' +
      '<div class="network-card-head"><div><div class="network-name">' + esc(provider.name) + '</div><div class="network-source">' + esc(provider.key === "retro" ? "RETRO REWIND / RETRO WFC" : provider.key === "wiimmfi" ? "WIIMMFI PROJECT" : "WIILINK TEAM") + '</div></div>' + statusLabel(provider) + '</div>' +
      '<div class="network-numbers"><div><span>PLAYERS ONLINE</span><b>' + fmt(provider.onlinePlayers) + '</b></div><div><span>ACTIVE ROOMS</span><b>' + fmt(provider.rooms) + '</b></div></div>' +
      substats +
      '<p class="network-detail">' + esc(provider.detail || "") + '</p>' +
      '<div class="network-capabilities">' + features + '</div>' +
      '<a class="network-external" href="' + esc(provider.url) + '" target="_blank" rel="noopener noreferrer">OPEN OFFICIAL SOURCE ↗</a>' +
      '</article>';
  }

  function renderNetworks() {
    const providers = getProviders();
    const countable = providers.filter(provider => number(provider.onlinePlayers) !== null).length;
    const totalPlayers = combined("onlinePlayers");
    const totalRooms = combined("rooms");
    const lastUpdate = networkState.lastAttempt ? localTime(networkState.lastAttempt) : "—";
    const liveNote = countable
      ? countable + " of " + providers.length + " network feeds currently provide a readable player count."
      : "No network feed has returned a readable live count yet. See each source card for its current availability.";
    return '<div class="network-summary">' +
      '<div class="network-summary-main"><div class="network-eyebrow">CROSS-SERVER POPULATION</div><div class="network-total">' + fmt(totalPlayers) + '</div><div class="network-summary-caption">REPORTED PLAYERS ONLINE · ALL READABLE NETWORKS</div><p>' + esc(liveNote) + '</p></div>' +
      '<div class="network-summary-side"><div><span>REPORTED ROOMS</span><b>' + fmt(totalRooms) + '</b></div><div><span>COUNTABLE NETWORKS</span><b>' + countable + ' / ' + providers.length + '</b></div><div><span>LAST CHECK</span><b>' + esc(lastUpdate) + '</b></div></div>' +
      '</div>' +
      '<div class="network-important"><strong>How combined totals work:</strong> counts are added only when a network returns a numeric live value. The total is <strong>not guaranteed to be deduplicated across networks</strong>; player identities are network-specific. A dash means no verified count was available, not zero.</div>' +
      '<div class="network-card-grid">' + providers.map(providerCard).join("") + '</div>' +
      '<section class="panel network-notes"><div class="panel-head"><div class="panel-title"><strong>Coverage and data boundaries</strong><small>Each server publishes a different amount of public telemetry</small></div><span class="panel-kicker">DATA NOTES</span></div><div class="panel-body">' +
      '<div class="coverage-row"><b>Retro WFC</b><p>Full integration: live room/player snapshots, race history, player statistics, VR leaderboard, character and vehicle selections, and combo analytics. These are the existing Retro Rewind Stats feeds.</p></div>' +
      '<div class="coverage-row"><b>Wiimmfi</b><p>Live Mario Kart Wii online-status feed is queried directly. Public online status is not the same as a complete race-result database, so this dashboard does not fabricate race logs, VR ratings, character picks, or finish positions for Wiimmfi players.</p></div>' +
      '<div class="coverage-row"><b>WiiLink WFC</b><p>The official online browser is linked and checked for a count when its public page response exposes one. It is not treated as zero when the response is blocked or the page hides its live data behind client-side requests.</p></div>' +
      '<div class="coverage-row"><b>Other community servers</b><p>Additional servers can be added when their public Mario Kart Wii endpoints or an approved status feed are available. Unsupported or unverified endpoints are deliberately excluded from the combined total.</p></div>' +
      '<p class="network-footnote">Browser-only deployment note: upstream CORS and anti-bot rules can prevent a static site from reading a server feed. The site will show that feed as unavailable rather than substituting stale or invented numbers. Last network check: ' + esc(lastUpdate) + '.</p>' +
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
    if (subtitle) subtitle.textContent = "Compare live populations across the public Mario Kart Wii online networks.";
    const root = document.querySelector("#viewContent");
    if (root) root.innerHTML = renderNetworks();
  }

  const originalSetView = window.setView;
  if (typeof originalSetView === "function") {
    window.setView = function (view) {
      if (view === "networks") {
        window.state.view = "networks";
        setNetworkView();
      } else {
        originalSetView(view);
      }
    };
  }

  const originalRenderView = window.renderView;
  if (typeof originalRenderView === "function") {
    window.renderView = function () {
      if (window.state && window.state.view === "networks") setNetworkView();
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
      if (player) player.textContent = fmt(combined("onlinePlayers"));
      if (rooms) rooms.textContent = fmt(combined("rooms"));
      if (playerFoot) playerFoot.textContent = "Combined reported population · see Networks";
      if (roomsFoot) roomsFoot.textContent = "Readable counts only · see Networks";
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
    if (window.state && window.state.view === "networks") setNetworkView();
  }

  window.rrNetworkStats = {
    refresh: refreshNetworks,
    getSnapshot: () => ({
      combinedPlayers: combined("onlinePlayers"),
      combinedRooms: combined("rooms"),
      providers: getProviders()
    })
  };

  const refreshButton = document.querySelector("#refreshButton");
  if (refreshButton) refreshButton.addEventListener("click", refreshNetworks);

  const networkTab = document.querySelector('.nav-tab[data-view="networks"]');
  if (networkTab) networkTab.addEventListener("click", () => setTimeout(setNetworkView, 0));

  // Start external network polling. Retro WFC is read from the existing app state.
  refreshNetworks();
  setInterval(() => {
    refreshNetworks();
    if (window.state && window.state.view === "networks") setNetworkView();
  }, REFRESH_MS);
  setInterval(() => {
    if (window.state && window.state.view === "networks") setNetworkView();
    if (typeof window.updateMetrics === "function") window.updateMetrics();
  }, 5000);
})();