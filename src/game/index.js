"use strict";

import { getCachedUser, logout } from "./auth.js";
import { initFriends, destroyFriends } from "./friends.js";
import { loadHomeTab, updateHome, loadGamesTab } from "./home.js";
import { openGame } from "./game-screen.js";
import { openSurvival } from "./survival.js";
import { GamePoller } from "./poller.js";

window.navigateToGame = (gameId) => openGame(gameId);
window.openSurvival   = openSurvival;

let _toastTimer = null;
function showToast(msg, duration = 2800) {
  const t = document.getElementById("toast");
  if (!t) return;
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => t.classList.remove("show"), duration);
}
window.showToast = showToast;

function switchNav(tab) {
  document.querySelectorAll(".nav-btn").forEach((b) => b.classList.remove("active"));
  document.querySelectorAll(".app-tab-content").forEach((c) => c.classList.remove("active"));
  const btn = document.querySelector(`.nav-btn[data-nav="${tab}"]`);
  if (btn) btn.classList.add("active");
  const panel = document.getElementById("tab-" + tab);
  if (panel) panel.classList.add("active");
  if (tab === "home") loadHomeTab();
  if (tab === "games") loadGamesTab();
  if (tab === "friends") initFriends();
}
window.switchNav = switchNav;

let gamePoller = null;

function setupShell() {
  document.querySelectorAll(".nav-btn").forEach((btn) => {
    btn.addEventListener("click", () => switchNav(btn.dataset.nav));
  });

  const headerBtn = document.getElementById("header-user-btn");
  if (headerBtn) {
    headerBtn.addEventListener("click", () => {
      const user = getCachedUser();
      if (!user) return;
      const name = user.display_name || user.username;
      document.getElementById("profile-avatar").textContent = name.slice(0, 2).toUpperCase();
      document.getElementById("profile-display-name").textContent = name;
      document.getElementById("profile-handle").textContent = "@" + user.username;
      document.getElementById("profile-tricks").textContent = user.tricks_landed || 0;
      document.getElementById("profile-wins").textContent = user.games_won || 0;
      document.getElementById("profile-losses").textContent = user.games_lost || 0;
      document.getElementById("profile-overlay").classList.remove("hidden");
    });
  }

  const closeBtn = document.getElementById("profile-close-btn");
  if (closeBtn) closeBtn.addEventListener("click", () => {
    document.getElementById("profile-overlay").classList.add("hidden");
  });

  const overlay = document.getElementById("profile-overlay");
  if (overlay) overlay.addEventListener("click", (e) => {
    if (e.target.id === "profile-overlay") overlay.classList.add("hidden");
  });

  const logoutBtn = document.getElementById("profile-logout-btn");
  if (logoutBtn) logoutBtn.addEventListener("click", async () => {
    document.getElementById("profile-overlay").classList.add("hidden");
    if (gamePoller) gamePoller.stop();
    destroyFriends();
    await logout();
  });
}

function onLogin() {
  const user = getCachedUser();
  if (user) {
    const name = user.display_name || user.username;
    const avatarEl = document.getElementById("header-avatar");
    const usernameEl = document.getElementById("header-username");
    if (avatarEl) avatarEl.textContent = name.slice(0, 2).toUpperCase();
    if (usernameEl) usernameEl.textContent = name;
  }

  if (gamePoller) gamePoller.stop();
  gamePoller = new GamePoller((data) => {
    const reqBadge = document.getElementById("requests-badge");
    if (reqBadge) {
      reqBadge.textContent = data.friend_requests_count || "";
      reqBadge.classList.toggle("hidden", !data.friend_requests_count);
    }
    const gamesBadge = document.getElementById("games-badge");
    if (gamesBadge) {
      gamesBadge.textContent = data.my_turn_count || "";
      gamesBadge.classList.toggle("hidden", !data.my_turn_count);
    }
    updateHome(data);
  }, user ? user.id : null);
  gamePoller.start();
  window.gamePoller = gamePoller;

  loadHomeTab();
}

function watchForLogin() {
  const appShell = document.getElementById("app-shell");
  if (!appShell) return;
  if (!appShell.classList.contains("hidden")) { onLogin(); return; }
  const observer = new MutationObserver(() => {
    if (!appShell.classList.contains("hidden")) {
      observer.disconnect();
      onLogin();
    }
  });
  observer.observe(appShell, { attributes: true, attributeFilter: ["class"] });
}

document.addEventListener("DOMContentLoaded", () => {
  setupShell();
  watchForLogin();
});
