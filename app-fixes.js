"use strict";

(() => {
  // Keep the base app's functions before decorating them. The IIFE prevents global
  // function-declaration hoisting from replacing the originals during capture.
  const baseUpdateMetrics = window.updateMetrics;
  window.updateMetrics = function updateMetricsWithLiveCount() {
    if (typeof baseUpdateMetrics === "function") baseUpdateMetrics();
    if (state.livePlayerCount != null) {
      $("#metricPlayers").textContent = fmt(state.livePlayerCount);
      $("#metricPlayersFoot").textContent = "Direct Retro WFC player-count feed";
    }
  };

  const baseRenderMeta = window.renderMeta;
  window.renderMeta = function renderMetaWithExtraRates() {
    const html = typeof baseRenderMeta === "function" ? baseRenderMeta() : "";
    const g = state.globalStats || {};
    return html +
      '<div class="section-spacer"></div><div class="lower-grid">' +
      '<section class="panel"><div class="panel-head"><div class="panel-title"><strong>Character win rates</strong><small>Win percentage by character</small></div><span class="panel-kicker">WIN RATE</span></div><div class="panel-body">' + rateList(g.topCharactersByWinRate) + '</div></section>' +
      '<section class="panel"><div class="panel-head"><div class="panel-title"><strong>Vehicle win rates</strong><small>Win percentage by vehicle</small></div><span class="panel-kicker">WIN RATE</span></div><div class="panel-body">' + rateList(g.topVehiclesByWinRate) + '</div></section></div>';
  };

  const basePlayerDetail = window.playerDetail;
  window.playerDetail = function playerDetailWithTrackBreakdown(player, stats, analytics, history, results) {
    const html = typeof basePlayerDetail === "function"
      ? basePlayerDetail(player, stats, analytics, history, results)
      : "";
    const tracks = safeList(analytics && analytics.trackPerformance).slice(0, 8);
    const positions = safeList(analytics && analytics.finishPositionDistribution);
    const trackRows = tracks.map(track =>
      '<div class="rank-row"><span class="rank-name">' + esc(track.trackName) + '<div class="subnote">' + fmt(track.raceCount) + ' races · avg finish ' + (Number(track.avgFinishPos) || 0).toFixed(2) + '</div></span><span class="rank-value">' + (Number(track.winRate) || 0).toFixed(1) + '% wins</span></div>'
    ).join("");
    const positionRows = positions.map(item =>
      '<div class="rank-row"><span class="rank-name">Place #' + fmt(item.position) + '</span><span class="rank-value">' + fmt(item.count) + ' finishes</span></div>'
    ).join("");
    return html +
      '<section class="detail-section"><h3>Track-by-track performance</h3>' + (trackRows ? '<div class="rank-list">' + trackRows + '</div>' : '<div class="empty-state">NO TRACK BREAKDOWN AVAILABLE</div>') + '</section>' +
      '<section class="detail-section"><h3>Finish position distribution</h3>' + (positionRows ? '<div class="rank-list">' + positionRows + '</div>' : '<div class="empty-state">NO FINISH DISTRIBUTION AVAILABLE</div>') + '</section>';
  };

  async function refreshDirectPlayerCount() {
    try {
      const payload = await api("/roomstatus/pcount");
      if (payload && Number.isFinite(Number(payload.count))) {
        state.livePlayerCount = Number(payload.count);
        window.updateMetrics();
      }
    } catch (_) {
      // A room snapshot remains a useful fallback if the direct counter is unavailable.
    }
  }

  // The base app already loads a first page when these collections are empty.
  // Refresh the default first page when a user opens either full index.
  document.addEventListener("click", event => {
    const tab = event.target.closest(".nav-tab[data-view]");
    if (!tab) return;
    if (tab.dataset.view === "players" && state.leaderboard.length <= 10) loadLeaderboard(1);
    if (tab.dataset.view === "races" && state.races.length <= 12) loadRaces(1);
  });

  document.addEventListener("reset", event => {
    if (event.target && event.target.id === "raceFilterForm") {
      setTimeout(() => {
        state.raceFilters = {};
        loadRaces(1);
      }, 0);
    }
  }, true);

  refreshDirectPlayerCount();
  setInterval(refreshDirectPlayerCount, 60000);
})();
