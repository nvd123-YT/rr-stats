"use strict";

const API = "https://rwfc.net/api";
const state = {
  view: "overview",
  rooms: [],
  roomStatus: null,
  roomStats: null,
  roomAnalytics: [],
  globalStats: null,
  races: [],
  racePage: 1,
  raceTotal: 0,
  racePages: 1,
  raceFilters: {},
  leaderboard: [],
  leaderboardPage: 1,
  leaderboardTotal: 0,
  leaderboardPages: 1,
  leaderboardFilters: { search: "", sortBy: "vr", ascending: false, activeDays: "", vehicleFilter: "" },
  selectedPlayer: null,
  selectedRace: null,
  favorites: loadFavorites(),
  detailedAnalytics: (() => { try { return localStorage.getItem("rrstats-detailed-analytics") === "true"; } catch (_) { return false; } })(),
  lastUpdated: null,
  errors: [],
  loading: false
};

const $ = (selector, root) => (root || document).querySelector(selector);
const $$ = (selector, root) => Array.from((root || document).querySelectorAll(selector));
const esc = value => String(value == null ? "" : value).replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
const fmt = value => Number.isFinite(Number(value)) ? Number(value).toLocaleString() : "—";
const signed = value => value == null || !Number.isFinite(Number(value)) ? "—" : (Number(value) > 0 ? "+" : "") + Number(value).toLocaleString();
const safeList = value => Array.isArray(value) ? value : [];

const MKW_TRACK_NAMES = Object.freeze({
  0:"Mario Circuit",1:"Moo Moo Meadows",2:"Mushroom Gorge",3:"Grumble Volcano",
  4:"Toad's Factory",5:"Coconut Mall",6:"DK Summit",7:"Wario's Gold Mine",
  8:"Luigi Circuit",9:"Daisy Circuit",10:"Moonview Highway",11:"Maple Treeway",
  12:"Bowser's Castle",13:"Rainbow Road",14:"Dry Dry Ruins",15:"Koopa Cape",
  16:"GCN Peach Beach",17:"GCN Mario Circuit",18:"GCN Waluigi Stadium",19:"GCN DK Mountain",
  20:"DS Yoshi Falls",21:"DS Desert Hills",22:"DS Peach Gardens",23:"DS Delfino Square",
  24:"SNES Mario Circuit 3",25:"SNES Ghost Valley 2",26:"N64 Mario Raceway",27:"N64 Sherbet Land",
  28:"N64 Bowser's Castle",29:"N64 DK's Jungle Parkway",30:"GBA Bowser Castle 3",31:"GBA Shy Guy Beach",
  32:"Delfino Pier",33:"Block Plaza",34:"Chain Chomp Wheel",35:"Funky Stadium",
  36:"Thwomp Desert",37:"GCN Cookie Land",38:"DS Twilight House",39:"SNES Battle Course 4",
  40:"GBA Battle Course 3",41:"N64 Skyscraper",54:"Galaxy Colosseum",
  55:"Winning Scene",56:"Losing Scene",57:"Unused Draw Scene",58:"Luigi Circuit (Credits)",
  67:"No Track Selected",255:"Random Track"
});
function courseDisplayName(trackName, courseId) {
  const label = trackName == null ? "" : String(trackName).trim();
  const genericMatch = label.match(/^(?:(?:course|track)\s*#?\s*|custom\s+track(?:\s*[·:#-]?\s*id)?\s*#?\s*)(0x[0-9a-f]+|[0-9]+)$/i);
  const isPlaceholder = !label || /^(?:—|-|n\/a|unknown(?:\s+track)?|none|null)$/i.test(label);
  const isNumericLabel = /^[0-9]+$/.test(label);

  // The feed's textual name is authoritative. In particular, do not replace
  // custom-track names with a generic label just because courseId is present.
  if (!isPlaceholder && !genericMatch && !isNumericLabel) return label;

  const idValue = genericMatch ? genericMatch[1] : (isNumericLabel ? label : courseId);
  if (idValue !== null && idValue !== undefined && idValue !== "") {
    const idText = String(idValue).trim();
    const id = /^0x[0-9a-f]+$/i.test(idText) ? parseInt(idText, 16) : Number(idText);
    if (Number.isInteger(id) && id >= 0) {
      if (Object.prototype.hasOwnProperty.call(MKW_TRACK_NAMES, id)) return MKW_TRACK_NAMES[id];
      if ((id >= 68 && id <= 254) || id >= 256) return "Custom Track · ID " + id;
      return "Track ID " + id;
    }
  }
  return label || "—";
}
function analyticsItems(items, defaultLimit) {
  const list = safeList(items);
  return state.detailedAnalytics ? list : list.slice(0, defaultLimit);
}
function updateAnalyticsModeButton() {
  const button = $("#detailModeToggle");
  if (!button) return;
  const enabled = !!state.detailedAnalytics;
  button.textContent = enabled ? "DETAIL: ALL" : "DETAIL: TOP";
  button.setAttribute("aria-pressed", enabled ? "true" : "false");
  button.classList.toggle("enabled", enabled);
  button.title = enabled
    ? "Showing every currently loaded record across stats, rankings, rooms and charts. Source pagination still applies."
    : "Showing compact top rankings and summary samples. Click to expand every currently available list.";
}

const getItems = value => Array.isArray(value) ? value : safeList(value && value.items);
const shortDate = value => {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "2-digit" });
};
const dateTime = value => {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
};
const ago = value => {
  if (!value) return "—";
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 1000));
  if (!Number.isFinite(seconds)) return "—";
  if (seconds < 60) return seconds + "s ago";
  if (seconds < 3600) return Math.floor(seconds / 60) + "m ago";
  if (seconds < 86400) return Math.floor(seconds / 3600) + "h ago";
  return Math.floor(seconds / 86400) + "d ago";
};
const apiPath = path => API + path;
async function api(path) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(apiPath(path), {
      method: "GET",
      mode: "cors",
      cache: "no-store",
      headers: { "Accept": "application/json" },
      signal: controller.signal
    });
    if (!response.ok) {
      const message = await response.text().catch(() => "");
      throw new Error("RWFC API " + response.status + (message ? ": " + message.slice(0, 150) : ""));
    }
    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}
function loadFavorites() {
  try { return new Set(JSON.parse(localStorage.getItem("rrstats-favorites") || "[]")); }
  catch (_) { return new Set(); }
}
function saveFavorites() {
  try { localStorage.setItem("rrstats-favorites", JSON.stringify(Array.from(state.favorites))); }
  catch (_) {}
}
function roomPlayers(room) {
  if (Array.isArray(room && room.players)) return room.players;
  if (room && room.players && typeof room.players === "object") return Object.values(room.players);
  return [];
}
function normalizePage(payload) {
  return {
    items: getItems(payload),
    totalCount: Number(payload && payload.totalCount) || getItems(payload).length,
    currentPage: Number(payload && payload.currentPage) || 1,
    totalPages: Number(payload && payload.totalPages) || 1
  };
}
function setApiStatus(status, label) {
  const badge = $("#apiStatus");
  badge.className = "api-status " + status;
  $("span", badge).textContent = label;
}
function setNotice(message) {
  const notice = $("#notice");
  notice.hidden = !message;
  notice.textContent = message || "";
}
function updateTimestamp() {
  state.lastUpdated = new Date();
  $("#lastUpdated").textContent = state.lastUpdated.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}
function updateMetrics() {
  const totalPlayers = state.roomStats && state.roomStats.totalPlayers != null
    ? state.roomStats.totalPlayers
    : state.roomStatus && state.roomStatus.totalPlayers != null
      ? state.roomStatus.totalPlayers
      : state.rooms.reduce((sum, room) => sum + roomPlayers(room).length, 0);
  const totalRooms = state.roomStats && state.roomStats.totalRooms != null ? state.roomStats.totalRooms : state.rooms.length;
  const global = state.globalStats || {};
  $("#metricPlayers").textContent = totalPlayers == null ? "—" : fmt(totalPlayers);
  $("#metricRooms").textContent = totalRooms == null ? "—" : fmt(totalRooms);
  $("#metricRaces").textContent = global.totalRacesTracked == null ? "—" : fmt(global.totalRacesTracked);
  $("#metricPlayersTracked").textContent = global.uniquePlayersCount == null ? "—" : fmt(global.uniquePlayersCount);
  $("#metricPlayersFoot").textContent = state.roomStats && state.roomStats.lastUpdated ? "Snapshot " + ago(state.roomStats.lastUpdated) : "Live room snapshot";
  $("#metricRoomsFoot").textContent = state.roomStats ? fmt(state.roomStats.publicRooms || 0) + " public · " + fmt(state.roomStats.privateRooms || 0) + " private" : "Public + private rooms";
  $("#metricRacesFoot").textContent = global.trackedSince ? "Tracked since " + shortDate(global.trackedSince) : "RWFC race-result archive";
  $("#metricPlayersTrackedFoot").textContent = global.trackedSince ? "Tracked since " + shortDate(global.trackedSince) : "Unique recorded racers";
}
function barChart(items, labelKey, valueKey) {
  if (!items.length) return '<div class="empty-state">NO ACTIVITY DATA AVAILABLE</div>';
  const max = Math.max(1, ...items.map(item => Number(item[valueKey]) || 0));
  return '<div class="chart-bars">' + items.map(item => {
    const value = Number(item[valueKey]) || 0;
    const height = Math.max(3, Math.round(value / max * 100));
    return '<div class="chart-bar" title="' + esc(item[labelKey]) + ': ' + fmt(value) + '"><b>' + fmt(value) + '</b><i style="height:' + height + '%"></i><span>' + esc(String(item[labelKey]).slice(0, 3)) + '</span></div>';
  }).join("") + '</div>';
}
function rankList(items, nameKey, valueKey, suffix) {
  items = analyticsItems(items, 7);
  if (!items.length) return '<div class="empty-state">NO AGGREGATES AVAILABLE</div>';
  return '<div class="rank-list">' + items.map((item, index) =>
    '<div class="rank-row"><span class="rank-number">' + String(index + 1).padStart(2, "0") + '</span><span class="rank-name">' + esc(item[nameKey]) + '</span><span class="rank-value">' + fmt(item[valueKey]) + (suffix || "") + '</span></div>'
  ).join("") + '</div>';
}
function roomCard(room, index) {
  const players = roomPlayers(room);
  const race = room.race || {};
  const track = race.trackName || race.courseName ? courseDisplayName(race.trackName || race.courseName, race.courseId != null ? race.courseId : race.course) : (race.course != null || race.courseId != null ? courseDisplayName(null, race.courseId != null ? race.courseId : race.course) : "Waiting for race");
  const id = room.id || room.roomId || "ROOM";
  const tags = [];
  if (room.isPublic === false) tags.push('<span class="tag private">PRIVATE</span>');
  else if (room.isPublic === true) tags.push('<span class="tag good">PUBLIC</span>');
  if (room.isJoinable === false) tags.push('<span class="tag warn">NOT JOINABLE</span>');
  if (room.isJoinable === true) tags.push('<span class="tag good">JOINABLE</span>');
  if (room.roomType) tags.push('<span class="tag">' + esc(room.roomType) + '</span>');
  if (race.cc) tags.push('<span class="tag">' + fmt(race.cc) + ' CC</span>');
  const playerRows = players.slice().sort((a, b) => (Number(b.vr) || 0) - (Number(a.vr) || 0)).map(player => {
    const isHost = String(room.host || "") === String(player.pid || player.friendCode || player.name || "");
    return '<div class="room-player"><span class="room-player-name">' + esc(player.name || "Unknown") + (isHost || player.isOpenHost ? '<span class="room-host">' + (player.isOpenHost ? "OPEN HOST" : "HOST") + '</span>' : "") + '</span><span class="room-player-vr">' + (player.vr == null ? "—" : fmt(player.vr) + " VR") + '</span><span class="room-player-br">' + (player.br == null ? "" : fmt(player.br) + " BR") + '</span></div>';
  }).join("");
  return '<article class="room-card"><div class="room-card-top"><div><div class="room-id">' + esc(id) + '</div><div class="room-type">' + esc(room.type || room.roomType || "ROOM") + ' · ' + (room.created ? "OPENED " + ago(room.created) : "ACTIVE") + '</div></div><div class="room-count">' + players.length + ' / 12</div></div><div class="room-track">' + esc(track) + '</div><div class="room-tags">' + tags.join("") + (room.averageVR != null ? '<span class="tag">' + fmt(Math.round(room.averageVR)) + ' AVG VR</span>' : "") + '</div><details class="room-players"><summary class="subnote">VIEW PLAYERS / ' + players.length + '</summary>' + (playerRows || '<div class="subnote">No player detail available.</div>') + '</details></article>';
}
function raceRow(race, index) {
  const participants = safeList(race.participants);
  return '<tr><td class="mono muted">' + dateTime(race.timestamp) + '</td><td><button class="race-link" data-action="open-race" data-index="' + index + '">' + esc(courseDisplayName(race.trackName, race.courseId)) + '</button></td><td class="mono">' + esc(race.roomId || "—") + ' <span class="muted">#' + fmt(race.raceNumber) + '</span></td><td class="mono">' + fmt(race.engineClassId) + ' CC</td><td>' + participants.length + '</td><td class="muted">' + esc(race.gameMode || "—") + '</td></tr>';
}
function raceTable(items, emptyMessage) {
  if (!items.length) return '<div class="empty-state">' + esc(emptyMessage || "NO RACE RESULTS FOUND") + '</div>';
  return '<div class="table-wrap"><table class="data-table"><thead><tr><th>WHEN</th><th>TRACK</th><th>ROOM / RACE</th><th>ENGINE</th><th>RACERS</th><th>MODE</th></tr></thead><tbody>' + items.map((race, index) => raceRow(race, index)).join("") + '</tbody></table></div>';
}
function playerButton(player) {
  return '<button class="player-link" data-action="open-player" data-pid="' + esc(player.pid) + '" data-fc="' + esc(player.friendCode) + '">' + esc(player.name || "Unknown racer") + '</button>';
}
function leaderboardRows(players) {
  if (!players.length) return '<tr><td colspan="7" class="muted">No players match this search.</td></tr>';
  return players.map(player => {
    const change = player.vrStats && player.vrStats.last24Hours != null ? Number(player.vrStats.last24Hours) : null;
    const favorite = state.favorites.has(String(player.friendCode));
    return '<tr><td class="mono muted">#' + fmt(player.rank) + '</td><td>' + playerButton(player) + (player.countryAlpha2 ? ' <span class="muted">' + esc(player.countryAlpha2) + '</span>' : '') + '</td><td class="mono">' + esc(player.friendCode || "—") + '</td><td class="mono lime">' + fmt(player.vr) + '</td><td class="mono ' + (change > 0 ? "positive" : change < 0 ? "negative" : "muted") + '">' + signed(change) + '</td><td class="muted">' + ago(player.lastSeen) + '</td><td><button class="quiet-button" data-action="favorite" data-fc="' + esc(player.friendCode) + '">' + (favorite ? "★ SAVED" : "☆ SAVE") + '</button></td></tr>';
  }).join("");
}
function renderOverview() {
  const global = state.globalStats || {};
  const rooms = analyticsItems(state.rooms, 4);
  const topPlayers = analyticsItems(state.leaderboard, 6);
  const recentRaces = analyticsItems(state.races, 8);
  return '<div class="dashboard-grid"><section class="panel"><div class="panel-head"><div class="panel-title"><strong>Race activity // last 7 days</strong><small>Recorded finish events across the Retro Rewind network</small></div><span class="panel-kicker">ACTIVITY</span></div><div class="panel-body">' + barChart(safeList(global.racesByDayOfWeek), "dayName", "raceCount") + '</div></section><section class="panel"><div class="panel-head"><div class="panel-title"><strong>Combo meta // all tracked</strong><small>Most-used character + vehicle combinations</small></div><span class="panel-kicker">SETUPS</span></div><div class="panel-body">' + rankList(global.topCombos, "name", "raceCount", " RACES") + '</div></section></div>' +
  '<div class="lower-grid"><section class="panel"><div class="panel-head"><div class="panel-title"><strong>Live rooms // sample</strong><small>Current room snapshot from RWFC</small></div><button class="quiet-button" data-action="goto" data-view="rooms">ALL ROOMS ↗</button></div><div class="panel-body">' + (rooms.length ? '<div class="room-grid">' + rooms.map(roomCard).join("") + '</div>' : '<div class="empty-state">NO LIVE ROOM DATA</div>') + '</div></section><section class="panel"><div class="panel-head"><div class="panel-title"><strong>VR leaders</strong><small>Highest current player ratings</small></div><button class="quiet-button" data-action="goto" data-view="players">FULL BOARD ↗</button></div><div class="panel-body">' + (topPlayers.length ? '<div class="rank-list">' + topPlayers.map((p, i) => '<div class="rank-row"><span class="rank-number">' + String(i + 1).padStart(2, "0") + '</span><span class="rank-name">' + playerButton(p) + '</span><span class="rank-value">' + fmt(p.vr) + ' VR</span></div>').join("") + '</div>' : '<div class="empty-state">LEADERBOARD UNAVAILABLE</div>') + '</div></section></div>' +
  '<section class="panel"><div class="panel-head"><div class="panel-title"><strong>Latest recorded races</strong><small>Each result expands to the full finishing order and player setups</small></div><button class="quiet-button" data-action="goto" data-view="races">OPEN RACE ARCHIVE ↗</button></div>' + raceTable(recentRaces, "NO RECENT RACES RETURNED") + '</section>';
}
function renderRooms() {
  const history = state.detailedAnalytics ? safeList(state.roomAnalytics) : safeList(state.roomAnalytics).slice(-14);
  return '<section class="panel"><div class="panel-head"><div class="panel-title"><strong>Live room browser</strong><small>' + fmt(state.rooms.length) + ' rooms in the latest captured snapshot · refreshes every 20 seconds</small></div><input id="roomSearch" class="searchbar room-search" placeholder="Filter by room, track or player…" autocomplete="off"></div><div class="panel-body"><div id="roomGrid" class="room-grid">' + (state.rooms.length ? state.rooms.map(roomCard).join("") : '<div class="empty-state">NO ACTIVE ROOMS REPORTED BY RWFC</div>') + '</div></div></section><div class="section-spacer"></div><section class="panel"><div class="panel-head"><div class="panel-title"><strong>Population history</strong><small>' + fmt(history.length) + ' recorded samples in the available 7-day feed</small></div><span class="panel-kicker">7 DAY VIEW</span></div><div class="panel-body">' + barChart(history.map(point => ({ dayName: new Date(point.timestamp).toLocaleDateString([], { weekday: "short", hour: "numeric" }), raceCount: point.players })), "dayName", "raceCount") + '</div></section>';
}
function renderRaces() {
  const f = state.raceFilters;
  const trackOptions = analyticsItems(state.globalStats && state.globalStats.allPlayedTracks, 100).map(track => '<option value="' + esc(track.courseId) + '"' + (String(f.courseId || "") === String(track.courseId) ? " selected" : "") + '>' + esc(courseDisplayName(track.name || track.trackName, track.courseId)) + '</option>').join("");
  return '<section class="panel"><div class="panel-head"><div class="panel-title"><strong>Race archive</strong><small>Search the recorded results database · ${state.detailedAnalytics ? "50" : "25"} races per page</small></div><button class="quiet-button" data-action="export-races">EXPORT CURRENT PAGE ↓</button></div><div class="panel-body"><form id="raceFilterForm"><div class="filter-grid"><div class="filter-field"><label for="raceRoom">ROOM ID</label><input class="filter-control" id="raceRoom" name="roomId" placeholder="e.g. YRAVOQ" value="' + esc(f.roomId || "") + '"></div><div class="filter-field"><label for="raceFc">PLAYER FRIEND CODE</label><input class="filter-control" id="raceFc" name="friendCode" placeholder="0000-0000-0000" value="' + esc(f.friendCode || "") + '"></div><div class="filter-field"><label for="raceTrack">TRACK</label><select class="filter-control" id="raceTrack" name="courseId"><option value="">All tracks</option>' + trackOptions + '</select></div><div class="filter-field"><label for="raceCc">ENGINE CLASS</label><select class="filter-control" id="raceCc" name="engineClassId"><option value="">All classes</option><option value="50"' + (String(f.engineClassId || "") === "50" ? " selected" : "") + '>50cc</option><option value="100"' + (String(f.engineClassId || "") === "100" ? " selected" : "") + '>100cc</option><option value="150"' + (String(f.engineClassId || "") === "150" ? " selected" : "") + '>150cc</option><option value="200"' + (String(f.engineClassId || "") === "200" ? " selected" : "") + '>200cc</option></select></div><div class="filter-field"><label for="raceFrom">FROM DATE</label><input class="filter-control" type="date" id="raceFrom" name="from" value="' + esc(f.from || "") + '"></div><div class="filter-field"><label for="raceTo">TO DATE</label><input class="filter-control" type="date" id="raceTo" name="to" value="' + esc(f.to || "") + '"></div><div class="filter-actions"><button class="secondary-button" type="reset">CLEAR</button><button class="primary-button" type="submit">SEARCH RACES ↗</button></div></div></form></div><div id="raceResults">' + raceTable(state.races, "LOADING RACE RESULTS") + '</div><div class="table-actions"><span class="subnote">' + fmt(state.raceTotal) + ' matching race records</span><div class="pagination"><button data-action="race-page" data-page="' + Math.max(1, state.racePage - 1) + '"' + (state.racePage <= 1 ? " disabled" : "") + '>‹</button><span>PAGE ' + state.racePage + ' / ' + Math.max(1, state.racePages) + '</span><button data-action="race-page" data-page="' + Math.min(state.racePages, state.racePage + 1) + '"' + (state.racePage >= state.racePages ? " disabled" : "") + '>›</button></div></div></section>';
}
function renderPlayers() {
  const f = state.leaderboardFilters;
  return '<section class="panel"><div class="panel-head"><div class="panel-title"><strong>VR leaderboard</strong><small>Individual player ratings and 24-hour movement · select a racer for their full record</small></div><span class="panel-kicker">' + fmt(state.leaderboardTotal) + ' PLAYERS</span></div><div class="panel-body"><form id="playerFilterForm" class="toolbar"><input id="playerSearch" class="searchbar" placeholder="Search player name or friend code…" value="' + esc(f.search) + '"><select id="playerSort" class="filter-control"><option value="vr">Sort: VR</option><option value="rank">Sort: rank</option><option value="name">Sort: name</option><option value="vrgain24">Sort: 24h VR gain</option><option value="vrgain7">Sort: 7d VR gain</option><option value="lastSeen">Sort: last seen</option></select><select id="playerVehicle" class="filter-control"><option value="">All vehicles</option><option value="kart"' + (f.vehicleFilter === "kart" ? " selected" : "") + '>Kart</option><option value="bike"' + (f.vehicleFilter === "bike" ? " selected" : "") + '>Bike</option></select><select id="playerActive" class="filter-control"><option value="">Any activity</option><option value="1">Active in 1 day</option><option value="7">Active in 7 days</option><option value="30">Active in 30 days</option></select><button class="primary-button" type="submit">FILTER ↗</button></form></div><div class="table-wrap"><table class="data-table"><thead><tr><th>RANK</th><th>PLAYER</th><th>FRIEND CODE</th><th>VR</th><th>24H CHANGE</th><th>LAST SEEN</th><th>WATCHLIST</th></tr></thead><tbody>' + leaderboardRows(state.leaderboard) + '</tbody></table></div><div class="table-actions"><span class="subnote">Your saved racers stay in this browser only.</span><div class="pagination"><button data-action="player-page" data-page="' + Math.max(1, state.leaderboardPage - 1) + '"' + (state.leaderboardPage <= 1 ? " disabled" : "") + '>‹</button><span>PAGE ' + state.leaderboardPage + ' / ' + Math.max(1, state.leaderboardPages) + '</span><button data-action="player-page" data-page="' + Math.min(state.leaderboardPages, state.leaderboardPage + 1) + '"' + (state.leaderboardPage >= state.leaderboardPages ? " disabled" : "") + '>›</button></div></div></section>';
}
function metaList(items, mode) {
  const list = safeList(items);
  if (!list.length) return '<div class="empty-state">NO DATA</div>';
  const max = Math.max(1, ...list.map(item => Number(item.raceCount) || 0));
  return analyticsItems(list, 12).map((item, i) => '<div class="meta-item"><div class="meta-item-head"><b><span class="muted mono">' + String(i + 1).padStart(2, "0") + '</span> &nbsp;' + esc(item.name || item.trackName) + '</b><span>' + fmt(item.raceCount) + (mode === "track" ? " races" : "") + '</span></div><div class="bar-meter"><i style="width:' + Math.max(1, (Number(item.raceCount) || 0) / max * 100) + '%"></i></div></div>').join("");
}
function renderMeta() {
  const g = state.globalStats || {};
  const trackCount = safeList(g.allPlayedTracks).length;
  const detailControl = '<div class="detail-mode-banner"><div><strong>ANALYTICS DISPLAY</strong><small>' + (state.detailedAnalytics ? "Showing every returned record" : "Showing compact top rankings") + ' · ' + fmt(trackCount) + ' tracks available</small></div><button class="detail-mode-toggle detail-mode-inline' + (state.detailedAnalytics ? " enabled" : "") + '" data-action="toggle-detail" type="button" aria-pressed="' + (state.detailedAnalytics ? "true" : "false") + '">' + (state.detailedAnalytics ? "DETAIL: ALL" : "DETAIL: TOP") + '</button></div>';
  return detailControl + '<div class="meta-grid"><section class="panel"><div class="panel-head"><div class="panel-title"><strong>Character usage</strong><small>Most selected racers</small></div><span class="panel-kicker">PICK RATE</span></div><div class="panel-body">' + metaList(g.topCharacters) + '</div></section><section class="panel"><div class="panel-head"><div class="panel-title"><strong>Vehicle usage</strong><small>Karts and bikes by exact vehicle</small></div><span class="panel-kicker">PICK RATE</span></div><div class="panel-body">' + metaList(g.topVehicles) + '</div></section><section class="panel"><div class="panel-head"><div class="panel-title"><strong>Character + vehicle meta</strong><small>Exact combo frequency</small></div><span class="panel-kicker">COMBOS</span></div><div class="panel-body">' + metaList(g.topCombos) + '</div></section><section class="panel"><div class="panel-head"><div class="panel-title"><strong>Most played tracks</strong><small>All tracks with recorded race results</small></div><span class="panel-kicker">TRACKS</span></div><div class="panel-body">' + metaList(safeList(g.allPlayedTracks).map(t => ({ name: courseDisplayName(t.name || t.trackName, t.courseId), raceCount: t.raceCount })), "track") + '</div></section><section class="panel"><div class="panel-head"><div class="panel-title"><strong>Combo win rates</strong><small>Successful setups by wins per race</small></div><span class="panel-kicker">WIN RATE</span></div><div class="panel-body">' + rateList(g.topCombosByWinRate) + '</div></section><section class="panel"><div class="panel-head"><div class="panel-title"><strong>Player activity</strong><small>Most active racers in the archive</small></div><span class="panel-kicker">RACE COUNT</span></div><div class="panel-body">' + rankList(g.mostActivePlayers, "name", "raceCount", " RACES") + '</div></section></div><div class="section-spacer"></div><section class="panel"><div class="panel-head"><div class="panel-title"><strong>When the grid gets busy</strong><small>Recorded race results by time of day</small></div><span class="panel-kicker">HOURLY ACTIVITY · UTC</span></div><div class="panel-body">' + barChart(safeList(g.racesByHour).map(item => ({ hour: String(item.hour).padStart(2, "0") + ":00", count: item.raceCount })), "hour", "count") + '</div></section>';
}
function rateList(items) {
  if (!safeList(items).length) return '<div class="empty-state">NO WIN-RATE DATA</div>';
  return '<div class="rank-list">' + analyticsItems(items, 8).map((item, index) => '<div class="rank-row"><span class="rank-number">' + String(index + 1).padStart(2, "0") + '</span><span class="rank-name">' + esc(item.name) + '<div class="subnote">' + fmt(item.winCount) + ' wins / ' + fmt(item.raceCount) + ' races</div></span><span class="rank-value">' + (Number(item.winRate) || 0).toFixed(1) + '%</span></div>').join("") + '</div>';
}
function setView(view) {
  state.view = view;
  $$(".nav-tab").forEach(button => button.classList.toggle("active", button.dataset.view === view));
  const headings = {
    overview: ["GLOBAL NETWORK // LIVE INTELLIGENCE", "The grid, <em>right now.</em>", "Combined live Mario Kart Wii population, plus deep Retro WFC race and player analytics."],
    rooms: ["RETRO WFC // ROOM SCANNER", "Find your <em>next room.</em>", "Live Retro WFC rooms, player VR / BR, room status and current course."],
    races: ["RETRO WFC // RACE LOGS", "Every race, <em>on record.</em>", "Search Retro WFC results by room, player, track, engine class or date."],
    players: ["RETRO WFC // VR RANKINGS", "Know the <em>competition.</em>", "Browse Retro WFC player VR, recent movement and full player histories."],
    meta: ["RETRO WFC // COMBO LAB", "Read the <em>meta.</em>", "Retro WFC character, vehicle, combo, track and win-rate analytics from recorded races."],
    networks: ["MARIO KART WII // CROSS-SERVER TELEMETRY", "One grid, <em>every server.</em>", "Compare live Mario Kart Wii populations, active rooms and network-specific player details."]
  };
  const h = headings[view] || headings.overview;
  $("#viewEyebrow").textContent = h[0];
  $("#viewTitle").innerHTML = h[1];
  $("#viewSubtitle").textContent = h[2];
  renderView();
}
function renderView() {
  const root = $("#viewContent");
  if (state.view === "overview") root.innerHTML = renderOverview();
  else if (state.view === "rooms") root.innerHTML = renderRooms();
  else if (state.view === "races") root.innerHTML = renderRaces();
  else if (state.view === "players") root.innerHTML = renderPlayers();
  else if (state.view === "meta") root.innerHTML = renderMeta();
  else if (state.view === "networks") {
    root.innerHTML = window.rrNetworkStats && typeof window.rrNetworkStats.render === "function"
      ? window.rrNetworkStats.render()
      : '<div class="loading-state"><span class="loader"></span> Loading network feeds…</div>';
  }
}
async function initialLoad() {
  state.loading = true;
  setApiStatus("", "CONNECTING");
  const paths = [
    api("/roomstatus"),
    api("/roomstatus/stats"),
    api("/roomstatus/analytics?days=7"),
    api("/racestats/global?days=30"),
    api("/racestats/races?page=1&pageSize=" + (state.detailedAnalytics ? 50 : 12)),
    api("/leaderboard?page=1&pageSize=" + (state.detailedAnalytics ? 50 : 10) + "&sortBy=vr&ascending=false")
  ];
  const results = await Promise.allSettled(paths);
  state.errors = [];
  const assign = (index, callback, label) => {
    if (results[index].status === "fulfilled") callback(results[index].value);
    else state.errors.push(label);
  };
  assign(0, value => { state.roomStatus = value; state.rooms = safeList(value && value.rooms); }, "live rooms");
  assign(1, value => { state.roomStats = value; }, "room statistics");
  assign(2, value => { state.roomAnalytics = safeList(value); }, "population history");
  assign(3, value => { state.globalStats = value; }, "global race statistics");
  assign(4, value => { const page = normalizePage(value); state.races = page.items; state.raceTotal = page.totalCount; }, "race archive");
  assign(5, value => { const page = normalizePage({ items: value && value.players, totalCount: value && value.totalCount, totalPages: value && value.totalPages, currentPage: value && value.currentPage }); state.leaderboard = page.items; state.leaderboardTotal = page.totalCount; state.leaderboardPages = page.totalPages; }, "VR leaderboard");
  state.loading = false;
  updateMetrics();
  updateTimestamp();
  if (state.errors.length === paths.length) {
    setApiStatus("error", "API UNREACHABLE");
    setNotice("The RWFC API could not be reached. Check your connection and try refresh. No sample or simulated statistics are shown.");
  } else {
    setApiStatus("connected", state.errors.length ? "PARTIAL DATA" : "RWFC CONNECTED");
    setNotice(state.errors.length ? "Some feeds did not respond: " + state.errors.join(", ") + ". Available sections remain usable; refresh to retry." : "");
  }
  renderView();
}
async function refreshOverviewCollections() {
  if (!state.detailedAnalytics) return;
  const results = await Promise.allSettled([
    api("/racestats/races?page=1&pageSize=50"),
    api("/leaderboard?page=1&pageSize=50&sortBy=vr&ascending=false")
  ]);
  if (results[0].status === "fulfilled") {
    const page = normalizePage(results[0].value);
    state.races = page.items;
    state.raceTotal = page.totalCount;
    state.racePages = page.totalPages;
  }
  if (results[1].status === "fulfilled") {
    const payload = results[1].value || {};
    state.leaderboard = safeList(payload.players);
    state.leaderboardTotal = Number(payload.totalCount) || state.leaderboard.length;
    state.leaderboardPages = Number(payload.totalPages) || 1;
  }
  if (state.view === "overview") renderView();
}
async function refreshLive() {
  const results = await Promise.allSettled([api("/roomstatus"), api("/roomstatus/stats")]);
  if (results[0].status === "fulfilled") {
    state.roomStatus = results[0].value;
    state.rooms = safeList(results[0].value && results[0].value.rooms);
  }
  if (results[1].status === "fulfilled") state.roomStats = results[1].value;
  if (results.some(r => r.status === "fulfilled")) {
    updateMetrics();
    if (state.view === "overview" || state.view === "rooms") renderView();
  }
  updateTimestamp();
}
async function refreshSlow() {
  const results = await Promise.allSettled([
    api("/racestats/global?days=30"),
    api("/roomstatus/analytics?days=7"),
    api("/racestats/races?page=1&pageSize=" + (state.detailedAnalytics ? 50 : 12)),
    api("/leaderboard?page=1&pageSize=" + (state.detailedAnalytics ? 50 : 10) + "&sortBy=vr&ascending=false")
  ]);
  if (results[0].status === "fulfilled") state.globalStats = results[0].value;
  if (results[1].status === "fulfilled") state.roomAnalytics = safeList(results[1].value);
  if (results[2].status === "fulfilled") { const page = normalizePage(results[2].value); state.races = page.items; state.raceTotal = page.totalCount; }
  if (results[3].status === "fulfilled") { state.leaderboard = safeList(results[3].value && results[3].value.players); state.leaderboardTotal = Number(results[3].value && results[3].value.totalCount) || state.leaderboard.length; state.leaderboardPages = Number(results[3].value && results[3].value.totalPages) || 1; }
  updateMetrics();
  if (state.view === "overview" || state.view === "meta") renderView();
  updateTimestamp();
}
function formQuery(form) {
  const data = new FormData(form);
  const query = new URLSearchParams();
  for (const [key, value] of data.entries()) {
    if (!String(value).trim()) continue;
    if ((key === "from" || key === "to") && /^\d{4}-\d{2}-\d{2}$/.test(String(value))) {
      query.set(key, String(value) + (key === "from" ? "T00:00:00Z" : "T23:59:59Z"));
    } else query.set(key, String(value).trim());
  }
  return query;
}
async function loadRaces(page) {
  state.racePage = page || 1;
  const query = new URLSearchParams(state.raceFilters);
  query.set("page", String(state.racePage));
  query.set("pageSize", state.detailedAnalytics ? "50" : "25");
  $("#raceResults").innerHTML = '<div class="loading-state"><span class="loader"></span> Querying race records…</div>';
  try {
    const payload = await api("/racestats/races?" + query.toString());
    const result = normalizePage(payload);
    state.races = result.items;
    state.raceTotal = result.totalCount;
    state.racePages = result.totalPages;
    state.racePage = result.currentPage;
    renderView();
  } catch (error) {
    $("#raceResults").innerHTML = '<div class="empty-state">RACE QUERY FAILED · ' + esc(error.message) + '</div>';
  }
}
async function loadLeaderboard(page) {
  state.leaderboardPage = page || 1;
  const f = state.leaderboardFilters;
  const query = new URLSearchParams({
    page: String(state.leaderboardPage),
    pageSize: state.detailedAnalytics ? "50" : "10",
    sortBy: f.sortBy || "vr",
    ascending: String(!!f.ascending)
  });
  if (f.search) query.set("search", f.search);
  if (f.activeDays) query.set("activeDays", f.activeDays);
  if (f.vehicleFilter) query.set("vehicleFilter", f.vehicleFilter);
  $("#viewContent").innerHTML = '<div class="loading-state"><span class="loader"></span> Loading player rankings…</div>';
  try {
    const payload = await api("/leaderboard?" + query.toString());
    state.leaderboard = safeList(payload && payload.players);
    state.leaderboardTotal = Number(payload && payload.totalCount) || 0;
    state.leaderboardPages = Number(payload && payload.totalPages) || 1;
    state.leaderboardPage = Number(payload && payload.currentPage) || state.leaderboardPage;
    renderView();
  } catch (error) {
    $("#viewContent").innerHTML = '<div class="panel"><div class="empty-state">LEADERBOARD QUERY FAILED · ' + esc(error.message) + '</div></div>';
  }
}
async function openPlayer(pid, friendCode) {
  const overlay = $("#detailOverlay");
  overlay.hidden = false;
  document.body.style.overflow = "hidden";
  $("#detailContent").innerHTML = '<div class="loading-state"><span class="loader"></span> Loading player record from RWFC…</div>';
  const fc = encodeURIComponent(friendCode || "");
  const safePid = encodeURIComponent(pid || "");
  const results = await Promise.allSettled([
    friendCode ? api("/leaderboard/player/" + fc) : Promise.reject(new Error("No friend code")),
    pid ? api("/racestats/player/" + safePid + "?page=1&pageSize=20") : Promise.reject(new Error("No player ID")),
    pid ? api("/racestats/player/" + safePid + "/analytics") : Promise.reject(new Error("No player ID")),
    friendCode ? api("/leaderboard/player/" + fc + "/history?days=30") : Promise.reject(new Error("No friend code"))
  ]);
  const player = results[0].status === "fulfilled" ? results[0].value : null;
  const raceStats = results[1].status === "fulfilled" ? results[1].value : null;
  const analytics = results[2].status === "fulfilled" ? results[2].value : null;
  const history = results[3].status === "fulfilled" ? results[3].value : null;
  state.selectedPlayer = player || { pid: pid, friendCode: friendCode };
  $("#detailContent").innerHTML = playerDetail(player, raceStats, analytics, history, results);
}
function historyArray(data) {
  if (Array.isArray(data)) return data;
  if (!data || typeof data !== "object") return [];
  return safeList(data.history || data.items || data.entries || data.points || data.data);
}
function playerDetail(player, stats, analytics, history, results) {
  const p = player || {};
  const changes = p.vrStats || {};
  const rows = analyticsItems(stats && stats.recentRaces, 12);
  const h = historyArray(history);
  const vals = h.map(item => Number(item.vr != null ? item.vr : item.value != null ? item.value : item.rating)).filter(Number.isFinite);
  const max = Math.max(1, ...vals);
  const min = Math.min(0, ...vals);
  const chart = vals.length ? '<div class="history-chart">' + vals.map(value => '<i title="' + fmt(value) + ' VR" style="height:' + Math.max(3, (value - min) / Math.max(1, max - min) * 100) + '%"></i>').join("") + '</div>' : '<div class="empty-state">NO VR HISTORY RETURNED FOR THIS PLAYER</div>';
  const raceRows = rows.map((race, index) => '<tr><td>' + dateTime(race.timestamp) + '</td><td>' + esc(courseDisplayName(race.trackName, race.courseId)) + '</td><td>' + esc(race.characterName || "—") + ' / ' + esc(race.vehicleName || "—") + '</td><td class="mono">' + (race.finishPos == null ? "—" : "#" + fmt(race.finishPos)) + '</td></tr>').join("");
  return '<div class="detail-head"><div class="detail-kicker">PLAYER DOSSIER // ' + esc(p.friendCode || "") + '</div><div class="detail-name" id="detailTitle">' + esc(p.name || "Unknown player") + '</div><div class="detail-sub">PID ' + esc(p.pid || "—") + ' · LAST SEEN ' + esc(ago(p.lastSeen)) + '</div></div>' +
    '<div class="stat-pills"><div class="stat-pill"><b>' + fmt(p.vr) + '</b><span>CURRENT VR</span></div><div class="stat-pill"><b>' + (p.rank ? "#" + fmt(p.rank) : "—") + '</b><span>RANK</span></div><div class="stat-pill"><b class="' + (Number(changes.last24Hours) >= 0 ? "positive" : "negative") + '">' + signed(changes.last24Hours) + '</b><span>24H VR</span></div><div class="stat-pill"><b>' + fmt(stats && stats.totalRaces) + '</b><span>TRACKED RACES</span></div></div>' +
    '<section class="detail-section"><h3>VR history // 30 days</h3>' + chart + '<div class="subnote">History points returned by the official RWFC player endpoint.</div></section>' +
    '<div class="two-col"><section class="detail-section"><h3>Top character picks</h3>' + rankList(stats && stats.topCharacters, "name", "raceCount", " RACES") + '</section><section class="detail-section"><h3>Top vehicle picks</h3>' + rankList(stats && stats.topVehicles, "name", "raceCount", " RACES") + '</section></div>' +
    '<section class="detail-section"><h3>Most-used combos</h3>' + rankList(stats && stats.topCombos, "name", "raceCount", " RACES") + '</section>' +
    '<section class="detail-section"><h3>Recent recorded races</h3>' + (rows.length ? '<div class="table-wrap"><table class="data-table"><thead><tr><th>WHEN</th><th>TRACK</th><th>SETUP</th><th>FINISH</th></tr></thead><tbody>' + raceRows + '</tbody></table></div>' : '<div class="empty-state">NO PLAYER RACE HISTORY RETURNED</div>') + '</section>' +
    '<section class="detail-section"><h3>Performance snapshot</h3><div class="stat-pills"><div class="stat-pill"><b>' + (analytics && analytics.winRate != null ? Number(analytics.winRate).toFixed(1) + "%" : "—") + '</b><span>WIN RATE</span></div><div class="stat-pill"><b>' + fmt(stats && stats.kartRaces) + '</b><span>KART RACES</span></div><div class="stat-pill"><b>' + fmt(stats && stats.bikeRaces) + '</b><span>BIKE RACES</span></div><div class="stat-pill"><b>' + fmt(stats && stats.totalFramesIn1st) + '</b><span>FRAMES IN 1ST</span></div></div></section>' +
    (results.some(result => result.status === "rejected") ? '<div class="subnote">Some profile feeds were unavailable. Available data is shown without estimates.</div>' : '');
}
function openRace(index) {
  const race = state.races[index];
  if (!race) return;
  state.selectedRace = race;
  $("#detailOverlay").hidden = false;
  document.body.style.overflow = "hidden";
  const participants = safeList(race.participants).slice().sort((a, b) => Number(a.finishPos) - Number(b.finishPos));
  const rows = participants.map(player => '<tr><td class="mono lime">#' + fmt(player.finishPos) + '</td><td>' + esc(player.name || player.friendCode || "Unknown player") + '</td><td class="mono">' + esc(player.friendCode || "—") + '</td><td>' + esc(player.characterName || "—") + '</td><td>' + esc(player.vehicleName || "—") + '</td><td class="mono">' + esc(player.finishTimeDisplay || "—") + '</td><td class="mono">' + fmt(player.framesIn1st) + '</td></tr>').join("");
  $("#detailContent").innerHTML = '<div class="detail-head"><div class="detail-kicker">RACE RECORD // ' + esc(race.roomId || "") + '</div><div class="detail-name" id="detailTitle">' + esc(courseDisplayName(race.trackName, race.courseId)) + '</div><div class="detail-sub">' + dateTime(race.timestamp) + ' · ROOM ' + esc(race.roomId || "—") + ' · RACE #' + fmt(race.raceNumber) + '</div></div><div class="stat-pills"><div class="stat-pill"><b>' + participants.length + '</b><span>PARTICIPANTS</span></div><div class="stat-pill"><b>' + fmt(race.engineClassId) + '</b><span>ENGINE CLASS</span></div><div class="stat-pill"><b>' + fmt(race.courseId) + '</b><span>COURSE ID</span></div><div class="stat-pill"><b>' + esc(race.gameMode || "—") + '</b><span>MODE</span></div></div><section class="detail-section"><h3>Finishing order + character combos</h3><div class="table-wrap"><table class="data-table"><thead><tr><th>PLACE</th><th>PLAYER</th><th>FRIEND CODE</th><th>CHARACTER</th><th>VEHICLE</th><th>TIME</th><th>FRAMES IN 1ST</th></tr></thead><tbody>' + (rows || '<tr><td colspan="7">No participant detail returned.</td></tr>') + '</tbody></table></div></section><section class="detail-section"><h3>Race metadata</h3><div class="subnote">Public room: ' + (race.isPublic == null ? "not reported" : race.isPublic ? "yes" : "no") + ' · Exact finish positions and setup names are provided by the RWFC race-result archive.</div></section>';
}
function closeOverlay() {
  $("#detailOverlay").hidden = true;
  document.body.style.overflow = "";
}
function exportCsv(rows, columns, filename) {
  if (!rows.length) { setNotice("There are no rows on this page to export."); return; }
  const cell = value => '"' + String(value == null ? "" : value).replace(/"/g, '""') + '"';
  const csv = [columns.map(column => cell(column.label)).join(",")].concat(rows.map(row => columns.map(column => cell(row[column.key])).join(","))).join("\r\n");
  const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url; link.download = filename; link.click();
  URL.revokeObjectURL(url);
}
document.addEventListener("click", event => {
  const tab = event.target.closest("[data-view]");
  if (tab && tab.classList.contains("nav-tab")) {
    setView(tab.dataset.view);
    if (tab.dataset.view === "players" && !state.leaderboard.length) loadLeaderboard(1);
    if (tab.dataset.view === "races" && !state.races.length) loadRaces(1);
    return;
  }
  const button = event.target.closest("[data-action]");
  if (!button) return;
  const action = button.dataset.action;
  if (action === "toggle-detail") {
    state.detailedAnalytics = !state.detailedAnalytics;
    try { localStorage.setItem("rrstats-detailed-analytics", state.detailedAnalytics ? "true" : "false"); } catch (_) {}
    updateAnalyticsModeButton();
    if (typeof window.renderView === "function") window.renderView();
    else renderView();
    if (state.detailedAnalytics) refreshOverviewCollections();
    if (state.view === "players") loadLeaderboard(1);
    if (state.view === "races") loadRaces(1);
    if (state.view === "time-trials" && typeof window.refreshTimeTrialDetailMode === "function") window.refreshTimeTrialDetailMode();
    return;
  }
  if (action === "goto") {
    setView(button.dataset.view);
    if (button.dataset.view === "players") loadLeaderboard(1);
    if (button.dataset.view === "races") loadRaces(1);
  } else if (action === "refresh") initialLoad();
  else if (action === "close-overlay") closeOverlay();
  else if (action === "open-player") openPlayer(button.dataset.pid, button.dataset.fc);
  else if (action === "open-race") openRace(Number(button.dataset.index));
  else if (action === "race-page") loadRaces(Number(button.dataset.page));
  else if (action === "player-page") loadLeaderboard(Number(button.dataset.page));
  else if (action === "favorite") {
    const fc = String(button.dataset.fc || "");
    if (state.favorites.has(fc)) state.favorites.delete(fc); else state.favorites.add(fc);
    saveFavorites(); renderView();
  } else if (action === "export-races") {
    exportCsv(state.races.map(race => ({ timestamp: race.timestamp, trackName: race.trackName, roomId: race.roomId, raceNumber: race.raceNumber, engineClassId: race.engineClassId, participants: safeList(race.participants).length })), [
      { key: "timestamp", label: "timestamp" }, { key: "trackName", label: "track" }, { key: "roomId", label: "roomId" }, { key: "raceNumber", label: "raceNumber" }, { key: "engineClassId", label: "engineClassId" }, { key: "participants", label: "participants" }
    ], "retro-rewind-races.csv");
  }
});
document.addEventListener("submit", event => {
  if (event.target.id === "raceFilterForm") {
    event.preventDefault();
    state.raceFilters = Object.fromEntries(formQuery(event.target).entries());
    loadRaces(1);
  } else if (event.target.id === "playerFilterForm") {
    event.preventDefault();
    state.leaderboardFilters.search = $("#playerSearch").value.trim();
    state.leaderboardFilters.sortBy = $("#playerSort").value;
    state.leaderboardFilters.vehicleFilter = $("#playerVehicle").value;
    state.leaderboardFilters.activeDays = $("#playerActive").value;
    state.leaderboardFilters.ascending = state.leaderboardFilters.sortBy === "name";
    loadLeaderboard(1);
  }
});
document.addEventListener("input", event => {
  if (event.target.id === "roomSearch") {
    const value = event.target.value.toLowerCase();
    const filtered = state.rooms.filter(room => {
      const playerNames = roomPlayers(room).map(player => player.name + " " + player.friendCode).join(" ");
      return [room.id, room.roomId, room.type, room.roomType, room.race && room.race.trackName, playerNames].join(" ").toLowerCase().includes(value);
    });
    $("#roomGrid").innerHTML = filtered.length ? filtered.map(roomCard).join("") : '<div class="empty-state">NO ROOMS MATCH THAT FILTER</div>';
  }
});
$("#refreshButton").addEventListener("click", () => initialLoad());
$("#detailOverlay").addEventListener("keydown", event => { if (event.key === "Escape") closeOverlay(); });
document.addEventListener("keydown", event => { if (event.key === "Escape") closeOverlay(); });

updateAnalyticsModeButton();
initialLoad();
setInterval(refreshLive, 20000);
setInterval(refreshSlow, 60000);
