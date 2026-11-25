"use strict";

(() => {
  // Preserve the first-pass app functions before extending them.
  const baseUpdateMetrics = window.updateMetrics;
  window.updateMetrics = function updateMetricsWithVerifiedRoomCount() {
    if (typeof baseUpdateMetrics === "function") baseUpdateMetrics();

    // Never use /roomstatus/pcount for the live MKWii room total: that upstream
    // counter is not the same thing as the current room snapshot / peak metric.
    const snapshotCount = state.roomStatus && Number.isFinite(Number(state.roomStatus.totalPlayers))
      ? Number(state.roomStatus.totalPlayers)
      : state.rooms.reduce((sum, room) => sum + roomPlayers(room).length, 0);
    const peak = state.roomStats && state.roomStats.peakPlayersAllTime;
    const todayPeak = state.roomStats && state.roomStats.peakPlayersToday;

    $("#metricPlayers").textContent = fmt(snapshotCount);
    $("#metricPlayersFoot").textContent =
      "Current room snapshot · all-time peak " + fmt(peak) +
      (todayPeak == null ? "" : " · today " + fmt(todayPeak));
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
    const tracks = analyticsItems(analytics && analytics.trackPerformance, 8);
    const positions = safeList(analytics && analytics.finishPositionDistribution);
    const trackRows = tracks.map(track =>
      '<div class="rank-row"><span class="rank-name">' + esc(courseDisplayName(track.trackName, track.courseId != null ? track.courseId : track.trackId)) + '<div class="subnote">' + fmt(track.raceCount) + ' races · avg finish ' + (Number(track.avgFinishPos) || 0).toFixed(2) + '</div></span><span class="rank-value">' + (Number(track.winRate) || 0).toFixed(1) + '% wins</span></div>'
    ).join("");
    const positionRows = positions.map(item =>
      '<div class="rank-row"><span class="rank-name">Place #' + fmt(item.position) + '</span><span class="rank-value">' + fmt(item.count) + ' finishes</span></div>'
    ).join("");
    return html +
      '<section class="detail-section"><h3>Track-by-track performance</h3>' + (trackRows ? '<div class="rank-list">' + trackRows + '</div>' : '<div class="empty-state">NO TRACK BREAKDOWN AVAILABLE</div>') + '</section>' +
      '<section class="detail-section"><h3>Finish position distribution</h3>' + (positionRows ? '<div class="rank-list">' + positionRows + '</div>' : '<div class="empty-state">NO FINISH DISTRIBUTION AVAILABLE</div>') + '</section>';
  };

  // Time-trial data uses its own profile IDs and categories, separate from online VR.
  state.ttTracks = [];
  state.ttWorldRecords = [];
  state.ttLeaderboard = null;
  state.ttRankings = [];
  state.ttSelectedTrack = null;
  state.ttPage = 1;
  state.ttPages = 1;
  state.ttLoaded = false;
  state.ttFilters = {
    cc: "150",
    glitchAllowed: "true",
    shroomless: "all",
    vehicle: "all",
    category: "all",
    mode: "regular"
  };

  function ttQuery(includeCategory) {
    const query = new URLSearchParams({
      cc: state.ttFilters.cc,
      glitchAllowed: state.ttFilters.glitchAllowed
    });
    if (state.ttFilters.shroomless !== "all") query.set("shroomless", state.ttFilters.shroomless);
    if (state.ttFilters.vehicle !== "all") query.set("vehicle", state.ttFilters.vehicle);
    if (includeCategory && state.ttFilters.category !== "all") query.set("trackCategory", state.ttFilters.category);
    return query;
  }

  function ttVisibleTracks() {
    return safeList(state.ttTracks)
      .filter(track => !track.isHidden && (state.ttFilters.category === "all" || track.category === state.ttFilters.category))
      .sort((a, b) => (Number(a.sortOrder) || 0) - (Number(b.sortOrder) || 0));
  }

  function ttTime(value) {
    return value == null ? "—" : esc(value);
  }

  function ttRecordRows() {
    const records = new Map(safeList(state.ttWorldRecords).map(record => [Number(record.trackId), record.activeWorldRecord || null]));
    const tracks = ttVisibleTracks();
    if (!tracks.length) return '<tr><td colspan="5" class="muted">No tracks were returned for this category.</td></tr>';
    return tracks.map(track => {
      const record = records.get(Number(track.id));
      return '<tr>' +
        '<td><button class="player-link" data-action="tt-track" data-id="' + fmt(track.id) + '">' + esc(track.name) + '</button> <span class="tag">' + esc(track.category) + '</span></td>' +
        '<td class="mono">' + fmt(track.laps) + '</td>' +
        '<td class="mono lime">' + (record ? ttTime(record.finishTimeDisplay) : '<span class="muted">NO RECORD</span>') + '</td>' +
        '<td>' + (record ? esc(record.playerName) : "—") + '</td>' +
        '<td class="mono muted">' + (record ? shortDate(record.dateSet) : "—") + '</td>' +
      '</tr>';
    }).join("");
  }

  function ttSubmissionRows() {
    const submissions = safeList(state.ttLeaderboard && state.ttLeaderboard.submissions);
    if (!submissions.length) return '<tr><td colspan="8" class="muted">No submissions returned for this track and filter combination.</td></tr>';
    return submissions.map((entry, index) => {
      const rank = entry.rank == null ? index + 1 : entry.rank;
      const flags = [entry.glitch ? "GLITCH" : "NO GLITCH", entry.shroomless ? "SHROOMLESS" : "MUSHROOMS", entry.isFlap ? "FLAP" : "3-LAP"];
      return '<tr>' +
        '<td class="mono lime">#' + fmt(rank) + '</td>' +
        '<td><button class="player-link" data-action="tt-player" data-id="' + fmt(entry.ttProfileId) + '">' + esc(entry.playerName || entry.miiName || "Unknown") + '</button>' + (entry.countryAlpha2 ? ' <span class="muted">' + esc(entry.countryAlpha2) + '</span>' : '') + '</td>' +
        '<td class="mono">' + ttTime(entry.finishTimeDisplay) + '</td>' +
        '<td class="mono">' + fmt(entry.characterId) + '</td>' +
        '<td class="mono">' + fmt(entry.vehicleId) + '</td>' +
        '<td class="mono">' + ttTime(entry.fastestLapDisplay) + '</td>' +
        '<td class="mono muted">' + shortDate(entry.dateSet) + '</td>' +
        '<td>' + flags.map(flag => '<span class="tag">' + esc(flag) + '</span>').join(" ") +
          (entry.hasGhostFile ? ' <button class="quiet-button" data-action="download-ghost" data-id="' + fmt(entry.id) + '">GHOST ↓</button>' : '') +
        '</td>' +
      '</tr>';
    }).join("");
  }

  function ttRankingRows() {
    const players = analyticsItems(state.ttRankings, 10);
    if (!players.length) return '<div class="empty-state">NO TIME-TRIAL PLAYER RANKINGS AVAILABLE</div>';
    return '<div class="rank-list">' + players.map(player =>
      '<div class="rank-row"><span class="rank-number">#' + fmt(player.rank) + '</span><span class="rank-name"><button class="player-link" data-action="tt-player" data-id="' + fmt(player.ttProfileId) + '">' + esc(player.displayName) + '</button></span><span class="rank-value">' + fmt(player.worldRecordCount) + ' WR</span></div>'
    ).join("") + '</div>';
  }

  function renderTimeTrials() {
    const tracks = ttVisibleTracks();
    const selected = tracks.find(track => Number(track.id) === Number(state.ttSelectedTrack)) || tracks[0] || null;
    const leaderboard = state.ttLeaderboard;
    const filters = state.ttFilters;
    const recordsCount = safeList(state.ttWorldRecords).filter(record => !!record.activeWorldRecord).length;
    const recordCountLabel = state.ttWorldRecords.length ? fmt(recordsCount) : "—";
    const trackTitle = selected ? selected.name : "Select a track";
    const ttModeLabel = filters.mode === "flap" ? "FASTEST LAP" : "3-LAP TIMES";
    const loading = !state.ttLoaded ? '<div class="loading-state"><span class="loader"></span> Connecting to time-trial records…</div>' : '';
    return loading +
      '<div class="metric-grid">' +
        '<div class="metric-card"><div class="metric-label">TT TRACKS <span class="metric-symbol">◈</span></div><div class="metric-value">' + fmt(tracks.length) + '</div><div class="metric-foot">Visible retro + custom tracks</div></div>' +
        '<div class="metric-card"><div class="metric-label">ACTIVE WORLD RECORDS <span class="metric-symbol">♛</span></div><div class="metric-value">' + recordCountLabel + '</div><div class="metric-foot">' + esc(filters.cc) + 'cc · selected filters</div></div>' +
        '<div class="metric-card"><div class="metric-label">TRACK SUBMISSIONS <span class="metric-symbol">⌁</span></div><div class="metric-value">' + (leaderboard ? fmt(leaderboard.totalSubmissions) : "—") + '</div><div class="metric-foot">' + esc(trackTitle) + '</div></div>' +
        '<div class="metric-card"><div class="metric-label">CURRENT BEST <span class="metric-symbol">◷</span></div><div class="metric-value">' + (leaderboard && leaderboard.fastestLapDisplay ? ttTime(leaderboard.fastestLapDisplay) : "—") + '</div><div class="metric-foot">' + ttModeLabel + '</div></div>' +
      '</div>' +
      '<section class="panel"><div class="panel-head"><div class="panel-title"><strong>Time trial filters</strong><small>Filter world records and per-track submissions. TT supports 150cc and 200cc categories.</small></div><span class="panel-kicker">RECORD LAB</span></div><div class="panel-body">' +
        '<form id="ttFilterForm" class="toolbar">' +
          '<select id="ttCc" class="filter-control" aria-label="Engine class"><option value="150"' + (filters.cc === "150" ? " selected" : "") + '>150 CC</option><option value="200"' + (filters.cc === "200" ? " selected" : "") + '>200 CC</option></select>' +
          '<select id="ttMode" class="filter-control" aria-label="Leaderboard mode"><option value="regular"' + (filters.mode === "regular" ? " selected" : "") + '>3-LAP TIMES</option><option value="flap"' + (filters.mode === "flap" ? " selected" : "") + '>FASTEST LAPS</option></select>' +
          '<select id="ttGlitch" class="filter-control" aria-label="Glitch category"><option value="true"' + (filters.glitchAllowed === "true" ? " selected" : "") + '>GLITCHES ALLOWED</option><option value="false"' + (filters.glitchAllowed === "false" ? " selected" : "") + '>NO GLITCH</option></select>' +
          '<select id="ttShroomless" class="filter-control" aria-label="Shroomless filter"><option value="all"' + (filters.shroomless === "all" ? " selected" : "") + '>ALL MUSHROOM</option><option value="only"' + (filters.shroomless === "only" ? " selected" : "") + '>SHROOMLESS ONLY</option><option value="exclude"' + (filters.shroomless === "exclude" ? " selected" : "") + '>EXCLUDE SHROOMLESS</option></select>' +
          '<select id="ttVehicle" class="filter-control" aria-label="Vehicle type"><option value="all"' + (filters.vehicle === "all" ? " selected" : "") + '>ALL VEHICLES</option><option value="karts"' + (filters.vehicle === "karts" ? " selected" : "") + '>KARTS</option><option value="bikes"' + (filters.vehicle === "bikes" ? " selected" : "") + '>BIKES</option></select>' +
          '<select id="ttCategory" class="filter-control" aria-label="Track category"><option value="all"' + (filters.category === "all" ? " selected" : "") + '>ALL TRACKS</option><option value="retro"' + (filters.category === "retro" ? " selected" : "") + '>RETRO</option><option value="custom"' + (filters.category === "custom" ? " selected" : "") + '>CUSTOM</option></select>' +
          '<button class="primary-button" type="submit">APPLY FILTERS ↗</button>' +
        '</form>' +
      '</div></section>' +
      '<div class="section-spacer"></div>' +
      '<section class="panel"><div class="panel-head"><div class="panel-title"><strong>Track world records</strong><small>Current fastest recorded submissions for every track in the selected category</small></div><span class="panel-kicker">' + esc(filters.cc) + 'CC</span></div><div class="table-wrap"><table class="data-table"><thead><tr><th>TRACK / CATEGORY</th><th>LAPS</th><th>WORLD RECORD</th><th>PLAYER</th><th>SET</th></tr></thead><tbody>' + ttRecordRows() + '</tbody></table></div></section>' +
      '<div class="section-spacer"></div>' +
      '<div class="dashboard-grid">' +
        '<section class="panel"><div class="panel-head"><div class="panel-title"><strong>' + esc(trackTitle) + ' // ' + ttModeLabel + '</strong><small>' + (leaderboard ? fmt(leaderboard.totalSubmissions) + ' submitted times' : 'Choose a track above to load the leaderboard') + '</small></div><div class="toolbar">' + (selected ? '<button class="quiet-button" data-action="tt-history" data-id="' + fmt(selected.id) + '">WR HISTORY ↗</button>' : '') + '<button class="quiet-button" data-action="tt-export">EXPORT CSV ↓</button></div></div>' +
          '<div class="table-wrap"><table class="data-table"><thead><tr><th>RANK</th><th>PLAYER</th><th>TIME</th><th>CHAR ID</th><th>VEH ID</th><th>FAST LAP</th><th>DATE</th><th>FLAGS / GHOST</th></tr></thead><tbody>' + (leaderboard ? ttSubmissionRows() : '<tr><td colspan="8" class="muted">Select a track to inspect ranked submissions.</td></tr>') + '</tbody></table></div>' +
          '<div class="table-actions"><span class="subnote">Character and vehicle IDs are the exact identifiers from RWFC submission records.</span><div class="pagination"><button data-action="tt-page" data-page="' + Math.max(1, state.ttPage - 1) + '"' + (state.ttPage <= 1 ? " disabled" : "") + '>‹</button><span>PAGE ' + state.ttPage + ' / ' + Math.max(1, state.ttPages) + '</span><button data-action="tt-page" data-page="' + Math.min(state.ttPages, state.ttPage + 1) + '"' + (state.ttPage >= state.ttPages ? " disabled" : "") + '>›</button></div></div>' +
        '</section>' +
        '<section class="panel"><div class="panel-head"><div class="panel-title"><strong>Time-trial record holders</strong><small>Players with the most active world records</small></div><span class="panel-kicker">TT PLAYERS</span></div><div class="panel-body">' + ttRankingRows() + '</div></section>' +
      '</div>';
  }

  async function loadTTLeaderboard(page) {
    if (!state.ttSelectedTrack) return;
    state.ttPage = page || 1;
    state.ttLeaderboard = null;
    window.renderView();
    const query = ttQuery(false);
    query.set("trackId", String(state.ttSelectedTrack));
    query.set("page", String(state.ttPage));
    query.set("pageSize", state.detailedAnalytics ? "100" : "25");
    const endpoint = state.ttFilters.mode === "flap" ? "/timetrial/leaderboard/flap?" : "/timetrial/leaderboard?";
    try {
      const result = await api(endpoint + query.toString());
      state.ttLeaderboard = result;
      state.ttPage = Number(result.currentPage) || state.ttPage;
      state.ttPages = Number(result.totalPages) || 1;
      window.renderView();
    } catch (error) {
      state.ttLeaderboard = { error: error.message, submissions: [], totalSubmissions: 0, currentPage: 1, totalPages: 1 };
      window.renderView();
      setNotice("Time-trial leaderboard unavailable: " + error.message);
    }
  }

  async function loadTTData() {
    if (state.ttLoading) return;
    state.ttLoading = true;
    state.ttLoaded = false;
    window.renderView();
    const query = ttQuery(false);
    const rankingQuery = ttQuery(true);
    rankingQuery.set("page", "1");
    rankingQuery.set("pageSize", state.detailedAnalytics ? "100" : "10");
    const results = await Promise.allSettled([
      state.ttTracks.length ? Promise.resolve(state.ttTracks) : api("/timetrial/tracks"),
      api("/timetrial/worldrecords/all?" + query.toString()),
      api("/timetrial/rankings?" + rankingQuery.toString())
    ]);
    if (results[0].status === "fulfilled") state.ttTracks = safeList(results[0].value);
    if (results[1].status === "fulfilled") state.ttWorldRecords = safeList(results[1].value);
    if (results[2].status === "fulfilled") state.ttRankings = safeList(results[2].value && results[2].value.players);
    state.ttLoaded = true;
    state.ttLoading = false;
    const visible = ttVisibleTracks();
    if (!visible.some(track => Number(track.id) === Number(state.ttSelectedTrack))) {
      const firstRecord = state.ttWorldRecords.find(record => record.activeWorldRecord);
      state.ttSelectedTrack = firstRecord ? firstRecord.trackId : visible[0] ? visible[0].id : null;
    }
    window.renderView();
    if (state.ttSelectedTrack) await loadTTLeaderboard(1);
    if (results.every(result => result.status === "rejected")) {
      setNotice("Time-trial API feeds could not be reached. No sample results are displayed.");
    } else {
      setNotice("");
    }
  }

  function showTTDetail(title, kicker, html) {
    $("#detailOverlay").hidden = false;
    document.body.style.overflow = "hidden";
    $("#detailContent").innerHTML = '<div class="detail-head"><div class="detail-kicker">' + esc(kicker) + '</div><div class="detail-name" id="detailTitle">' + esc(title) + '</div></div>' + html;
  }

  async function openTTPlayer(profileId) {
    showTTDetail("Loading TT profile", "TIME-TRIAL PLAYER DOSSIER", '<div class="loading-state"><span class="loader"></span> Loading profile and submissions…</div>');
    const results = await Promise.allSettled([
      api("/timetrial/profile/" + encodeURIComponent(profileId)),
      api("/timetrial/profile/" + encodeURIComponent(profileId) + "/stats"),
      api("/timetrial/profile/" + encodeURIComponent(profileId) + "/submissions?page=1&pageSize=" + (state.detailedAnalytics ? 100 : 25))
    ]);
    const profile = results[0].status === "fulfilled" ? results[0].value : {};
    const stats = results[1].status === "fulfilled" ? results[1].value : {};
    const page = results[2].status === "fulfilled" ? results[2].value : {};
    const submissions = safeList(page.submissions);
    const rows = submissions.map((entry, index) => '<tr><td class="mono lime">#' + fmt(entry.rank || index + 1) + '</td><td>' + esc(entry.trackName) + '</td><td class="mono">' + ttTime(entry.cc) + '</td><td class="mono">' + ttTime(entry.finishTimeDisplay) + '</td><td>' + (entry.isFlap ? "FLAP" : "3-LAP") + '</td><td class="mono">' + shortDate(entry.dateSet) + '</td>' + '<td>' + (entry.hasGhostFile ? '<button class="quiet-button" data-action="download-ghost" data-id="' + fmt(entry.id) + '">GHOST ↓</button>' : "—") + '</td></tr>').join("");
    showTTDetail(profile.displayName || "Time-trial player", "TT PROFILE #" + fmt(profile.id), 
      '<div class="stat-pills"><div class="stat-pill"><b>' + fmt(profile.totalSubmissions) + '</b><span>SUBMISSIONS</span></div><div class="stat-pill"><b>' + fmt(profile.currentWorldRecords) + '</b><span>ACTIVE WRS</span></div><div class="stat-pill"><b>' + fmt(stats.tracks150cc) + '</b><span>150CC TRACKS</span></div><div class="stat-pill"><b>' + fmt(stats.tracks200cc) + '</b><span>200CC TRACKS</span></div></div>' +
      '<section class="detail-section"><h3>Recent time-trial submissions</h3><div class="table-wrap"><table class="data-table"><thead><tr><th>RANK</th><th>TRACK</th><th>CC</th><th>TIME</th><th>MODE</th><th>DATE</th><th>GHOST</th></tr></thead><tbody>' + (rows || '<tr><td colspan="7">No submissions returned.</td></tr>') + '</tbody></table></div></section>'
    );
  }

  async function openTTWorldRecordHistory(trackId) {
    const query = ttQuery(false);
    query.set("trackId", String(trackId));
    const endpoint = state.ttFilters.mode === "flap" ? "/timetrial/worldrecord/history/flap?" : "/timetrial/worldrecord/history?";
    showTTDetail("Record history", "WORLD RECORD TIMELINE", '<div class="loading-state"><span class="loader"></span> Loading record progression…</div>');
    try {
      const history = safeList(await api(endpoint + query.toString()));
      const rows = history.map((entry, index) => '<tr><td class="mono">#' + (index + 1) + '</td><td>' + esc(entry.playerName) + '</td><td class="mono lime">' + ttTime(entry.finishTimeDisplay) + '</td><td class="mono">' + fmt(entry.characterId) + ' / ' + fmt(entry.vehicleId) + '</td><td>' + shortDate(entry.dateSet) + '</td></tr>').join("");
      $("#detailContent").innerHTML = '<div class="detail-head"><div class="detail-kicker">WORLD RECORD TIMELINE</div><div class="detail-name" id="detailTitle">' + esc((state.ttTracks.find(track => Number(track.id) === Number(trackId)) || {}).name || "Track") + '</div><div class="detail-sub">' + esc(state.ttFilters.cc) + 'cc · ' + (state.ttFilters.mode === "flap" ? "fastest lap" : "3-lap") + '</div></div><section class="detail-section"><h3>Record progression</h3><div class="table-wrap"><table class="data-table"><thead><tr><th>ORDER</th><th>PLAYER</th><th>TIME</th><th>CHAR / VEH IDs</th><th>DATE</th></tr></thead><tbody>' + (rows || '<tr><td colspan="5">No record history returned.</td></tr>') + '</tbody></table></div></section>';
    } catch (error) {
      $("#detailContent").innerHTML = '<div class="empty-state">WORLD RECORD HISTORY UNAVAILABLE · ' + esc(error.message) + '</div>';
    }
  }

  async function downloadTTGhost(id) {
    try {
      const response = await fetch(apiPath("/timetrial/ghost/" + encodeURIComponent(id) + "/download"), { mode: "cors" });
      if (!response.ok) throw new Error("Ghost download failed (" + response.status + ")");
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = "retro-rewind-ghost-" + id + ".rkg";
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) {
      setNotice(error.message);
    }
  }

  window.refreshTimeTrialDetailMode = function refreshTimeTrialDetailMode() {
    if (!state.ttLoaded) {
      if (!state.ttLoading) loadTTData();
      return;
    }
    const rankingQuery = ttQuery(true);
    rankingQuery.set("page", "1");
    rankingQuery.set("pageSize", state.detailedAnalytics ? "100" : "10");
    api("/timetrial/rankings?" + rankingQuery.toString()).then(result => {
      state.ttRankings = safeList(result && result.players);
      if (state.view === "time-trials") window.renderView();
    }).catch(error => {
      setNotice("Time-trial rankings unavailable: " + error.message);
    });
    if (state.ttSelectedTrack) loadTTLeaderboard(state.ttPage || 1);
  };

  const baseRenderView = window.renderView;
  window.renderView = function renderViewWithTimeTrials() {
    if (state.view === "time-trials") {
      $("#viewContent").innerHTML = renderTimeTrials();
      return;
    }
    if (typeof baseRenderView === "function") baseRenderView();
  };

  const baseSetView = window.setView;
  window.setView = function setViewWithTimeTrials(view) {
    if (view !== "time-trials") {
      if (typeof baseSetView === "function") baseSetView(view);
      return;
    }
    state.view = view;
    $$(".nav-tab").forEach(button => button.classList.toggle("active", button.dataset.view === view));
    $("#viewEyebrow").textContent = "TIME TRIALS // GHOST RECORD DATABASE";
    $("#viewTitle").innerHTML = "Chase the <em>world record.</em>";
    $("#viewSubtitle").textContent = "Track-by-track 150cc / 200cc leaderboards, ghost submissions, record history and TT player rankings.";
    window.renderView();
    if (!state.ttLoaded) loadTTData();
  };

  document.addEventListener("click", event => {
    const tab = event.target.closest(".nav-tab[data-view]");
    if (tab && tab.dataset.view === "players" && state.leaderboard.length <= 10) loadLeaderboard(1);
    if (tab && tab.dataset.view === "races" && state.races.length <= 12) loadRaces(1);

    const actionButton = event.target.closest("[data-action]");
    if (!actionButton) return;
    const action = actionButton.dataset.action;
    if (action === "tt-track") {
      state.ttSelectedTrack = Number(actionButton.dataset.id);
      loadTTLeaderboard(1);
    } else if (action === "tt-page") {
      loadTTLeaderboard(Number(actionButton.dataset.page));
    } else if (action === "tt-player") {
      openTTPlayer(Number(actionButton.dataset.id));
    } else if (action === "tt-history") {
      openTTWorldRecordHistory(Number(actionButton.dataset.id));
    } else if (action === "download-ghost") {
      downloadTTGhost(Number(actionButton.dataset.id));
    } else if (action === "tt-export") {
      const entries = safeList(state.ttLeaderboard && state.ttLeaderboard.submissions);
      exportCsv(entries.map(entry => ({
        rank: entry.rank, playerName: entry.playerName, finishTime: entry.finishTimeDisplay,
        fastestLap: entry.fastestLapDisplay, characterId: entry.characterId, vehicleId: entry.vehicleId,
        cc: entry.cc, trackName: entry.trackName, dateSet: entry.dateSet,
        glitch: entry.glitch, shroomless: entry.shroomless, isFlap: entry.isFlap
      })), [
        { key: "rank", label: "rank" }, { key: "playerName", label: "player" },
        { key: "finishTime", label: "time" }, { key: "fastestLap", label: "fastestLap" },
        { key: "characterId", label: "characterId" }, { key: "vehicleId", label: "vehicleId" },
        { key: "cc", label: "cc" }, { key: "trackName", label: "track" },
        { key: "dateSet", label: "date" }, { key: "glitch", label: "glitch" },
        { key: "shroomless", label: "shroomless" }, { key: "isFlap", label: "isFlap" }
      ], "retro-rewind-time-trial-submissions.csv");
    }
  });

  document.addEventListener("submit", event => {
    if (event.target.id !== "ttFilterForm") return;
    event.preventDefault();
    state.ttFilters.cc = $("#ttCc").value;
    state.ttFilters.mode = $("#ttMode").value;
    state.ttFilters.glitchAllowed = $("#ttGlitch").value;
    state.ttFilters.shroomless = $("#ttShroomless").value;
    state.ttFilters.vehicle = $("#ttVehicle").value;
    state.ttFilters.category = $("#ttCategory").value;
    state.ttWorldRecords = [];
    state.ttLeaderboard = null;
    state.ttLoaded = false;
    loadTTData();
  });

  document.addEventListener("input", event => {
    if (event.target.id === "ttTrackSearch") {
      const value = event.target.value.toLowerCase();
      $$("#ttRecordTable tbody tr").forEach(row => {
        row.hidden = !row.textContent.toLowerCase().includes(value);
      });
    }
  });

  document.addEventListener("reset", event => {
    if (event.target && event.target.id === "raceFilterForm") {
      setTimeout(() => {
        state.raceFilters = {};
        loadRaces(1);
      }, 0);
    }
  }, true);

})();
