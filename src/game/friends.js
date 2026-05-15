"use strict";

import { getToken } from "./auth.js";

export const FRIENDS_API = "/game/api";
export const SENT_REQS_KEY = "fp_sent_requests"; // localStorage: Set<userId> of pending sent requests

// ──────────────────────────────────────────────
// API helpers
// ──────────────────────────────────────────────
export function _headers() {
  const h = { "Content-Type": "application/json" };
  const token = getToken();
  if (token) h["Authorization"] = `Bearer ${token}`;
  return h;
}

export async function searchUsers(query) {
  const resp = await fetch(
    `${FRIENDS_API}/users/search?q=${encodeURIComponent(query)}`,
    { headers: _headers() }
  );
  if (!resp.ok) return [];
  return resp.json();
}

export async function getFriends() {
  const resp = await fetch(`${FRIENDS_API}/friends`, { headers: _headers() });
  if (!resp.ok) return [];
  return resp.json();
}

export async function getRequests() {
  const resp = await fetch(`${FRIENDS_API}/friends/requests`, { headers: _headers() });
  if (!resp.ok) return [];
  return resp.json();
}

export async function getSentRequests() {
  const resp = await fetch(`${FRIENDS_API}/friends/sent`, { headers: _headers() });
  if (!resp.ok) return [];
  return resp.json();
}

export async function sendRequest(userId) {
  const resp = await fetch(`${FRIENDS_API}/friends/request`, {
    method: "POST",
    headers: _headers(),
    body: JSON.stringify({ user_id: userId }),
  });
  return resp;
}

export async function acceptRequest(friendshipId) {
  const resp = await fetch(`${FRIENDS_API}/friends/accept`, {
    method: "POST",
    headers: _headers(),
    body: JSON.stringify({ friendship_id: friendshipId }),
  });
  return resp.json();
}

export async function declineRequest(friendshipId) {
  const resp = await fetch(`${FRIENDS_API}/friends/decline`, {
    method: "POST",
    headers: _headers(),
    body: JSON.stringify({ friendship_id: friendshipId }),
  });
  return resp.json();
}

export async function removeFriend(friendshipId) {
  const resp = await fetch(`${FRIENDS_API}/friends/${friendshipId}`, {
    method: "DELETE",
    headers: _headers(),
  });
  return resp.json();
}

// ──────────────────────────────────────────────
// Persistent sent-request tracking
// ──────────────────────────────────────────────
export function _loadSentSet() {
  try { return new Set(JSON.parse(localStorage.getItem(SENT_REQS_KEY)) || []); }
  catch { return new Set(); }
}
export function _saveSentSet(s) {
  localStorage.setItem(SENT_REQS_KEY, JSON.stringify([...s]));
}
export function _markSent(userId) {
  const s = _loadSentSet(); s.add(String(userId)); _saveSentSet(s);
}
export function _unmarkSent(userId) {
  const s = _loadSentSet(); s.delete(String(userId)); _saveSentSet(s);
}
export function _isSent(userId) {
  return _loadSentSet().has(String(userId));
}

// ──────────────────────────────────────────────
// UI helpers
// ──────────────────────────────────────────────
export function _initials(user) {
  const name = user.display_name || user.username;
  return name.slice(0, 2).toUpperCase();
}

export function _statsLine(user) {
  const parts = [];
  if (user.tricks_landed) parts.push(`${user.tricks_landed} tricks`);
  if (user.games_won) parts.push(`${user.games_won} W`);
  return parts.length ? parts.join(" · ") : "New player";
}

export function _el(tag, cls, text) {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text !== undefined) el.textContent = text;
  return el;
}

// ──────────────────────────────────────────────
// Search
// ──────────────────────────────────────────────
export let searchTimer = null;

export function setupSearch() {
  const input = document.getElementById("friend-search-input");
  const list = document.getElementById("search-results");
  if (!input || !list) return;

  input.addEventListener("input", () => {
    const q = input.value.trim();
    clearTimeout(searchTimer);
    if (q.length < 2) { list.innerHTML = ""; return; }
    searchTimer = setTimeout(async () => {
      const users = await searchUsers(q);
      if (input.value.trim() !== q) return;
      renderSearchResults(users, list);
    }, 400);
  });
}

export function renderSearchResults(users, container) {
  container.innerHTML = "";
  if (!users.length) {
    container.appendChild(_el("div", "friends-empty", "Keine Nutzer gefunden"));
    return;
  }
  users.forEach((u) => {
    const row = _el("div", "friend-row");

    row.appendChild(_el("div", "avatar-circle", _initials(u)));

    const info = _el("div", "friend-info");
    info.appendChild(_el("div", "friend-name", u.display_name || u.username));
    info.appendChild(_el("div", "friend-meta", `@${u.username} · ${_statsLine(u)}`));
    row.appendChild(info);

    const btn = _el("button", "friend-action-btn accent-btn");
    const alreadySent = _isSent(u.id);
    if (alreadySent) {
      btn.textContent = "Gesendet ✓";
      btn.disabled = true;
      btn.classList.add("disabled");
    } else {
      btn.textContent = "Anfrage senden";
      btn.addEventListener("click", async () => {
        btn.textContent = "...";
        btn.disabled = true;
        const resp = await sendRequest(u.id);
        if (resp.ok) {
          _markSent(u.id);
          btn.textContent = "Gesendet ✓";
          btn.classList.add("disabled");
          loadSentRequests();
          if (typeof showToast !== "undefined") showToast("Freundschaftsanfrage gesendet!");
        } else {
          btn.textContent = "Anfrage senden";
          btn.disabled = false;
        }
      });
    }
    row.appendChild(btn);
    container.appendChild(row);
  });
}

// ──────────────────────────────────────────────
// Incoming requests
// ──────────────────────────────────────────────
export async function loadRequests() {
  const reqs = await getRequests();
  _renderRequests(reqs);
}

export function _renderRequests(reqs) {
  const badge = document.getElementById("requests-badge");
  const list  = document.getElementById("requests-list");
  const banner = document.getElementById("requests-banner");
  const bannerCount = document.getElementById("requests-banner-count");
  if (!list) return;

  // Update nav badge + top banner
  if (badge) {
    badge.textContent = reqs.length || "";
    badge.classList.toggle("hidden", reqs.length === 0);
  }
  if (banner && bannerCount) {
    bannerCount.textContent = reqs.length;
    banner.classList.toggle("hidden", reqs.length === 0);
  }

  list.innerHTML = "";
  if (!reqs.length) {
    list.appendChild(_el("div", "friends-empty", "Keine offenen Anfragen"));
    return;
  }

  reqs.forEach((r) => {
    const row = _el("div", "friend-row request-row");
    row.appendChild(_el("div", "avatar-circle", _initials(r.from_user)));

    const info = _el("div", "friend-info");
    info.appendChild(_el("div", "friend-name", r.from_user.display_name || r.from_user.username));
    info.appendChild(_el("div", "friend-meta", `@${r.from_user.username}`));
    row.appendChild(info);

    const actions = _el("div", "request-actions");

    const acceptBtn = _el("button", "friend-action-btn accept-btn", "✓ Annehmen");
    acceptBtn.addEventListener("click", async () => {
      acceptBtn.disabled = true;
      declineBtn.disabled = true;
      await acceptRequest(r.friendship_id);
      row.classList.add("fade-out");
      setTimeout(() => {
        row.remove();
        _unmarkSent(r.from_user.id);
        loadRequests();
        loadFriends();
        if (typeof refreshHomeFriends !== "undefined") refreshHomeFriends();
        if (typeof showToast !== "undefined") showToast(`${r.from_user.display_name || r.from_user.username} ist jetzt dein Freund!`);
      }, 300);
    });
    actions.appendChild(acceptBtn);

    const declineBtn = _el("button", "friend-action-btn decline-btn", "Ablehnen");
    declineBtn.addEventListener("click", async () => {
      declineBtn.disabled = true;
      acceptBtn.disabled = true;
      await declineRequest(r.friendship_id);
      row.classList.add("fade-out");
      setTimeout(() => { row.remove(); loadRequests(); }, 300);
    });
    actions.appendChild(declineBtn);

    row.appendChild(actions);
    list.appendChild(row);
  });
}

// ──────────────────────────────────────────────
// Sent requests
// ──────────────────────────────────────────────
export async function loadSentRequests() {
  const sent = await getSentRequests();
  const list = document.getElementById("sent-requests-list");
  const section = document.getElementById("sent-requests-section");
  if (!list) return;

  // Sync localStorage with what server knows
  // (server may have moved them to accepted/declined)
  const serverPendingIds = new Set(sent.map(s => String(s.to_user.id)));
  const localSent = _loadSentSet();
  localSent.forEach(id => { if (!serverPendingIds.has(id)) localSent.delete(id); });
  _saveSentSet(localSent);

  if (section) section.style.display = sent.length ? "" : "none";

  list.innerHTML = "";
  if (!sent.length) return;

  sent.forEach((s) => {
    const row = _el("div", "friend-row");
    row.appendChild(_el("div", "avatar-circle", _initials(s.to_user)));

    const info = _el("div", "friend-info");
    info.appendChild(_el("div", "friend-name", s.to_user.display_name || s.to_user.username));
    info.appendChild(_el("div", "friend-meta", `@${s.to_user.username} · Anfrage ausstehend`));
    row.appendChild(info);

    const badge = _el("span", "home-sent-badge", "Ausstehend");
    row.appendChild(badge);

    list.appendChild(row);
  });
}

// ──────────────────────────────────────────────
// Friends list
// ──────────────────────────────────────────────
export async function loadFriends() {
  const friends = await getFriends();
  const list = document.getElementById("friends-list");
  if (!list) return;

  list.innerHTML = "";
  if (!friends.length) {
    list.appendChild(_el("div", "friends-empty", "Noch keine Freunde. Suche oben nach Nutzern!"));
    return;
  }

  friends
    .sort((a, b) => (a.user.username).localeCompare(b.user.username))
    .forEach((f) => {
      const row = _el("div", "friend-row");
      row.appendChild(_el("div", "avatar-circle", _initials(f.user)));

      const info = _el("div", "friend-info");
      info.appendChild(_el("div", "friend-name", f.user.display_name || f.user.username));
      info.appendChild(_el("div", "friend-meta", `@${f.user.username} · ${_statsLine(f.user)}`));
      row.appendChild(info);

      const actions = _el("div", "request-actions");

      const challengeBtn = _el("button", "friend-action-btn accent-btn", "Challenge");
      challengeBtn.addEventListener("click", () => startChallenge(f.user.id, f.user.display_name || f.user.username));
      actions.appendChild(challengeBtn);

      const removeBtn = _el("button", "friend-action-btn decline-btn", "×");
      removeBtn.title = "Entfernen";
      removeBtn.addEventListener("click", async () => {
        if (!confirm(`${f.user.display_name || f.user.username} entfernen?`)) return;
        row.classList.add("fade-out");
        await removeFriend(f.friendship_id);
        setTimeout(() => row.remove(), 300);
      });
      actions.appendChild(removeBtn);

      row.appendChild(actions);
      list.appendChild(row);
    });
}

// ──────────────────────────────────────────────
// Challenge a friend
// ──────────────────────────────────────────────
export async function startChallenge(userId, displayName) {
  try {
    const resp = await fetch("/game/api/games/challenge", {
      method: "POST",
      headers: _headers(),
      body: JSON.stringify({ opponent_id: userId }),
    });
    if (resp.ok) {
      if (typeof showToast !== "undefined") showToast(`Herausforderung an ${displayName} gesendet!`);
      // Switch to home tab so user sees the sent invitation
      if (typeof switchNav !== "undefined") switchNav("home");
      if (typeof gamePoller !== "undefined" && gamePoller) gamePoller.poll();
    } else {
      const err = await resp.json().catch(() => ({}));
      if (typeof showToast !== "undefined") showToast(err.error || "Fehler beim Senden");
    }
  } catch {
    if (typeof showToast !== "undefined") showToast("Verbindungsfehler");
  }
}

// ──────────────────────────────────────────────
// Polling & init
// ──────────────────────────────────────────────
export let requestsPollTimer = null;

export function initFriends() {
  setupSearch();
  loadRequests();
  loadSentRequests();
  loadFriends();

  // Scroll to requests banner if there are incoming requests
  const banner = document.getElementById("requests-banner");
  if (banner && !banner.classList.contains("hidden")) {
    banner.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  if (requestsPollTimer) clearInterval(requestsPollTimer);
  requestsPollTimer = setInterval(() => { loadRequests(); loadSentRequests(); }, 30000);
}

export function destroyFriends() {
  if (requestsPollTimer) { clearInterval(requestsPollTimer); requestsPollTimer = null; }
}
