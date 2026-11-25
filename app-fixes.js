"use strict";

// Ensure each archive tab requests its full first page when opened.
document.addEventListener("click", event => {
  const tab = event.target.closest(".nav-tab[data-view]");
  if (!tab) return;
  if (tab.dataset.view === "players") loadLeaderboard(1);
  if (tab.dataset.view === "races") loadRaces(1);
});

document.addEventListener("reset", event => {
  if (event.target && event.target.id === "raceFilterForm") {
    setTimeout(() => {
      state.raceFilters = {};
      loadRaces(1);
    }, 0);
  }
}, true);

// Prefer the direct live player-count endpoint over the room snapshot's rounded total.
const updateMetricsFromSnapshot = updateMetrics;
function updateMetrics() {
  updateMetricsFromSnapshot();
  if (state.livePlayerCount != null) {
    $("#metricPlayers").textContent = fmt(state.livePlayerCount);
    $("#metricPlayersFoot").textContent = "Direct Retro WFC player-count feed";
  }
}
async function refreshDirectPlayerCount() {
  try {
    const payload = await api("/roomstatus/pcount");
    if (payload && Number.isFinite(Number(payload.count))) {
      state.livePlayerCount = Number(payload.count);
      updateMetrics();
    }
  } catch (_) {
    // The room snapshot remains a valid fallback if the direct counter is unavailable.
  }
}
refreshDirectPlayerCount();
setInterval(refreshDirectPlayerCount, 60000);

// Add the official per-character and per-vehicle win-rate views to the global meta page.
const renderMetaBase = renderMeta;
function renderMeta() {
  const g = state.globalStats || {};
  return renderMetaBase() +
    '<div class="section-spacer"></div><div class="lower-grid">' +
    '<section class="panel"><div class="panel-head"><div class="panel-title"><strong>Character win rates</strong><small>Win percentage by character</small></div><span class="panel-kicker">WIN RATE</span></div><div class="panel-body">' + rateList(g.topCharactersByWinRate) + '</div></section>' +
    '<section class="panel"><div class="panel-head"><div class="panel-title"><strong>Vehicle win rates</strong><small>Win percentage by vehicle</small></div><span class="panel-kicker">WIN RATE</span></div><div class="panel-body">' + rateList(g.topVehiclesByWinRate) + '</div></section></div>';
}

// Bring track-by-track performance and finish-position distribution into each player dossier.
const playerDetailBase = playerDetail;
function playerDetail(player, stats, analytics, history, results) {
  const base = playerDetailBase(player, stats, analytics, history, results);
  const tracks = safeList(analytics && analytics.trackPerformance).slice(0, 8);
  const positions = safeList(analytics && analytics.finishPositionDistribution);
  const trackRows = tracks.map(track =>
    '<div class="rank-row"><span class="rank-name">' + esc(track.trackName) + '<div class="subnote">' + fmt(track.raceCount) + ' races · avg finish ' + (Number(track.avgFinishPos) || 0).toFixed(2) + '</div></span><span class="rank-value">' + (Number(track.winRate) || 0).toFixed(1) + '% wins</span></div>'
  ).join("");
  const positionRows = positions.map(item =>
    '<div class="rank-row"><span class="rank-name">Place #' + fmt(item.position) + '</span><span class="rank-value">' + fmt(item.count) + ' finishes</span></div>'
  ).join("");
  return base +
    '<section class="detail-section"><h3>Track-by-track performance</h3>' + (trackRows ? '<div class="rank-list">' + trackRows + '</div>' : '<div class="empty-state">NO TRACK BREAKDOWN AVAILABLE</div>') + '</section>' +
    '<section class="detail-section"><h3>Finish position distribution</h3>' + (positionRows ? '<div class="rank-list">' + positionRows + '</div>' : '<div class="empty-state">NO FINISH DISTRIBUTION AVAILABLE</div>') + '</section>';
}
