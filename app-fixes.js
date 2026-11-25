"use strict";

// Small navigation corrections kept separate so the dashboard remains framework-free.
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
