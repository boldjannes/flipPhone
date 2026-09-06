"use strict";

import { getToken, getCachedUser } from "./auth.js";
import { openGame } from "./game-screen.js";

/**
 * Home tab — renders game overview after login.
 *
 * Sections:
 *   1. "Du bist dran" — games where it's my turn
 *   2. "Warten auf..." — games where opponent is playing
 *   3. "Herausfordern" — horizontal friend scroller
 *   4. "Einladungen" — pending game invitations
 *
 * Called by:
 *   - loadHomeTab()       on tab switch / initial load
 *   - updateHome(data)    from GamePoller.onUpdate
 */

export const SKATE_WORD = "SKATE";

// ──────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────

export function _h(tag, cls, text) {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text !== undefined) el.textContent = text;
  return el;
}

export function _avatar(user, size) {
  const name = user.display_name || user.username;
  const el = _h("div", "avatar-circle" + (size ? ` avatar-${size}` : ""));
  el.textContent = name.slice(0, 2).toUpperCase();
  return el;
}

/**
 * Black section bar with a red numbered square, uppercase label and a
 * thin rule — the recurring "Ausgabe"-style divider from the redesign.
 */
export function _sectionBar(num, label, count) {
  const bar = _h("div", "home-section-bar");
  bar.appendChild(_h("span", "hsb-num", String(num)));
  bar.appendChild(_h("span", "hsb-label", label));
  bar.appendChild(_h("span", "hsb-rule"));
  if (count) bar.appendChild(_h("span", "hsb-count", count));
  return bar;
}

export function _myUserId() {
  const u = getCachedUser();
  return u ? u.id : null;
}

export function _opponent(game) {
  const me = _myUserId();
  return game.challenger.id === me ? game.opponent : game.challenger;
}

export function _myLetters(game) {
  const me = _myUserId();
  return game.challenger.id === me
    ? game.challenger_letters
    : game.opponent_letters;
}

export function _opponentLetters(game) {
  const me = _myUserId();
  return game.challenger.id === me
    ? game.opponent_letters
    : game.challenger_letters;
}

// ──────────────────────────────────────────────
// SKATE letters visual
// ──────────────────────────────────────────────

export function renderSkateLetters(letters, labelPrefix) {
  const wrap = _h("div", "skate-letters");
  if (labelPrefix) {
    const lbl = _h("span", "skate-label", labelPrefix);
    wrap.appendChild(lbl);
  }
  for (let i = 0; i < SKATE_WORD.length; i++) {
    const ch = _h("span", "skate-char");
    ch.textContent = SKATE_WORD[i];
    if (i < letters.length) {
      ch.classList.add("skate-active");
    }
    wrap.appendChild(ch);
  }
  return wrap;
}

// ──────────────────────────────────────────────
// Game card
// ──────────────────────────────────────────────

export function renderGameCard(game, isMyTurn) {
  const opp = _opponent(game);
  const oppName = opp.display_name || opp.username;

  // ── My-turn hero card (ink ground, red shadow, Anton scream) ──
  if (isMyTurn) {
    const isSetter = game.current_role === "setter";
    const card = _h("div", "home-game-card home-hero");
    card.appendChild(_h("div", "fp-texture"));

    const body = _h("div", "home-hero-body");

    const tag = _h("div", "home-hero-tag");
    tag.appendChild(_h("span", "home-hero-now", "Jetzt"));
    tag.appendChild(_h("span", "home-hero-vs", `gegen ${oppName}`));
    body.appendChild(tag);

    const title = _h("div", "home-hero-title", isSetter ? "Trick zeigen" : "Nachmachen");
    body.appendChild(title);

    // Line pills (matcher only — the setter still has to throw a line)
    if (!isSetter && game.current_line && game.current_line.length) {
      const pills = _h("div", "home-hero-pills");
      game.current_line.forEach((t, i) => {
        pills.appendChild(_h("span", "home-hero-pill", `${i + 1} · ${t.replace(/_/g, " ")}`));
      });
      body.appendChild(pills);
    }

    const stands = _h("div", "home-game-stands home-hero-stands");
    const myCol = _h("div", "home-hero-standcol");
    myCol.appendChild(_h("span", "home-hero-standlbl", "Du"));
    myCol.appendChild(renderSkateLetters(_myLetters(game), ""));
    stands.appendChild(myCol);
    const oppCol = _h("div", "home-hero-standcol");
    oppCol.appendChild(_h("span", "home-hero-standlbl", oppName));
    oppCol.appendChild(renderSkateLetters(_opponentLetters(game), ""));
    stands.appendChild(oppCol);
    body.appendChild(stands);

    card.appendChild(body);

    const btn = _h("button", "home-game-btn");
    btn.innerHTML = `${isSetter ? "Line werfen" : "Line matchen"} <span style="font-size:20px">→</span>`;
    btn.addEventListener("click", () => openGame(game.id));
    card.appendChild(btn);

    return card;
  }

  // ── Standard card (waiting on opponent) ──
  const card = _h("div", "home-game-card");

  // Top row: avatar + info
  const top = _h("div", "home-game-top");
  top.appendChild(_avatar(opp, "md"));

  const info = _h("div", "home-game-info");
  info.appendChild(_h("div", "home-game-opponent", opp.display_name || opp.username));

  const roleText =
    isMyTurn && game.current_role === "setter"
      ? "Trick zeigen"
      : isMyTurn && game.current_role === "matcher"
        ? "Nachmachen"
        : "Wartet...";
  const roleEl = _h("div", "home-game-role" + (isMyTurn ? " role-active" : ""), roleText);
  info.appendChild(roleEl);

  if (game.current_line && !isMyTurn) {
    const lineStr = game.current_line.map((t) => t.replace(/_/g, " ")).join(", ");
    info.appendChild(_h("div", "home-game-line", lineStr));
  }

  top.appendChild(info);
  card.appendChild(top);

  // SKATE stands
  const stands = _h("div", "home-game-stands");
  stands.appendChild(renderSkateLetters(_myLetters(game), "Du "));
  stands.appendChild(renderSkateLetters(_opponentLetters(game), ""));
  card.appendChild(stands);

  // CTA for my turn
  if (isMyTurn) {
    const btn = _h("button", "home-game-btn accent-btn");
    btn.textContent = game.current_role === "setter" ? "Trick zeigen" : "Nachmachen";
    btn.addEventListener("click", () => openGame(game.id));
    card.appendChild(btn);
  }

  return card;
}

// ──────────────────────────────────────────────
// Invitation card
// ──────────────────────────────────────────────

export function renderInvitationCard(game) {
  const opp = game.challenger;
  const card = _h("div", "home-invite-card");

  const row = _h("div", "home-invite-row");
  row.appendChild(_avatar(opp, "md"));
  const info = _h("div", "home-game-info");
  info.appendChild(
    _h("div", "home-game-opponent", opp.display_name || opp.username)
  );
  info.appendChild(_h("div", "friend-meta", "hat dich herausgefordert"));
  row.appendChild(info);
  card.appendChild(row);

  const actions = _h("div", "home-invite-actions");
  const acceptBtn = _h("button", "friend-action-btn accept-btn", "Annehmen");
  acceptBtn.addEventListener("click", async () => {
    acceptBtn.disabled = true;
    try {
      const token = getToken();
      await fetch(`/game/api/games/${game.id}/accept`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
      });
      card.classList.add("fade-out");
      setTimeout(() => card.remove(), 300);
      if (typeof gamePoller !== "undefined" && gamePoller) gamePoller.poll();
    } catch {
      acceptBtn.disabled = false;
    }
  });
  actions.appendChild(acceptBtn);

  const declineBtn = _h("button", "friend-action-btn decline-btn", "Ablehnen");
  declineBtn.addEventListener("click", async () => {
    declineBtn.disabled = true;
    try {
      const token = getToken();
      await fetch(`/game/api/games/${game.id}/decline`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
      });
      card.classList.add("fade-out");
      setTimeout(() => card.remove(), 300);
    } catch {
      declineBtn.disabled = false;
    }
  });
  actions.appendChild(declineBtn);

  card.appendChild(actions);
  return card;
}

// ──────────────────────────────────────────────
// Sent invitation card
// ──────────────────────────────────────────────

export function renderSentInvitationCard(game) {
  const opp = game.opponent;
  const card = _h("div", "home-sent-invite-card");

  card.appendChild(_avatar(opp, "md"));

  const info = _h("div", "home-game-info");
  info.appendChild(_h("div", "home-game-opponent", opp.display_name || opp.username));
  info.appendChild(_h("div", "friend-meta", "Einladung gesendet · wartet auf Antwort"));
  card.appendChild(info);

  card.appendChild(_h("span", "home-sent-badge", "Ausstehend"));
  return card;
}

// ──────────────────────────────────────────────
// Friend scroller (challenge)
// ──────────────────────────────────────────────

export function renderFriendScroller(friends) {
  const scroller = _h("div", "home-friend-scroller");
  if (!friends || !friends.length) {
    scroller.appendChild(
      _h("div", "friends-empty", "Noch keine Freunde")
    );
    return scroller;
  }
  friends.forEach((f) => {
    const item = _h("div", "home-friend-item");
    item.appendChild(_avatar(f.user, "lg"));
    item.appendChild(
      _h("div", "home-friend-name", f.user.display_name || f.user.username)
    );
    const btn = _h("button", "home-challenge-btn", "Call");
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      btn.textContent = "...";
      try {
        const token = getToken();
        const resp = await fetch("/game/api/games/challenge", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ opponent_id: f.user.id }),
        });
        if (resp.ok) {
          btn.textContent = "Gesendet";
          btn.classList.add("disabled");
          if (typeof gamePoller !== "undefined" && gamePoller) gamePoller.poll();
        } else {
          const err = await resp.json().catch(() => ({}));
          btn.textContent = err.error || "Fehler";
          setTimeout(() => {
            btn.textContent = "Challenge";
            btn.disabled = false;
          }, 2000);
        }
      } catch {
        btn.textContent = "Challenge";
        btn.disabled = false;
      }
    });
    item.appendChild(btn);
    scroller.appendChild(item);
  });
  return scroller;
}

// ──────────────────────────────────────────────
// Render home sections
// ──────────────────────────────────────────────

export function renderHome(data, friends) {
  const container = document.getElementById("home-content");
  if (!container) return;
  container.innerHTML = "";

  const me = _myUserId();
  const myTurnGames = [];
  const waitingGames = [];
  const invitations = [];
  const sentInvitations = [];

  if (data.pending_games) data.pending_games.forEach((g) => invitations.push(g));
  if (data.sent_invitations) data.sent_invitations.forEach((g) => sentInvitations.push(g));

  if (data.active_games) {
    data.active_games.forEach((g) => {
      if (g.current_turn_id === me) myTurnGames.push(g);
      else waitingGames.push(g);
    });
  }

  let secNum = 0;

  // 1. My turn (most urgent — it's on you)
  if (myTurnGames.length) {
    const sec = _h("div", "home-section");
    sec.appendChild(_sectionBar(++secNum, "Du bist dran", `${myTurnGames.length} offen`));
    myTurnGames.forEach((g) => sec.appendChild(renderGameCard(g, true)));
    container.appendChild(sec);
  }

  // 2. Incoming invitations (action required)
  if (invitations.length) {
    const sec = _h("div", "home-section");
    sec.appendChild(_sectionBar(++secNum, "Calls", `${invitations.length} offen`));
    invitations.forEach((g) => sec.appendChild(renderInvitationCard(g)));
    container.appendChild(sec);
  }

  // 3. Waiting for opponent
  if (waitingGames.length) {
    const sec = _h("div", "home-section");
    sec.appendChild(_sectionBar(++secNum, "Am Laufen", `${waitingGames.length}`));
    waitingGames.forEach((g) => sec.appendChild(renderGameCard(g, false)));
    container.appendChild(sec);
  }

  // 4. Sent invitations (waiting for accept)
  if (sentInvitations.length) {
    const sec = _h("div", "home-section");
    sec.appendChild(_sectionBar(++secNum, "Rausgeschickt", `${sentInvitations.length}`));
    sentInvitations.forEach((g) => sec.appendChild(renderSentInvitationCard(g)));
    container.appendChild(sec);
  }

  // 5. Challenge friends scroller
  if (friends && friends.length) {
    const sec = _h("div", "home-section");
    sec.appendChild(_sectionBar(++secNum, "Jemanden callen", ""));
    sec.appendChild(renderFriendScroller(friends));
    container.appendChild(sec);
  }

  // Empty state
  const hasAnything = myTurnGames.length || waitingGames.length || invitations.length ||
    sentInvitations.length || (friends && friends.length);
  if (!hasAnything) {
    const empty = _h("div", "home-empty");
    empty.appendChild(_h("div", "home-empty-icon", "\uD83D\uDEF9"));
    empty.appendChild(_h("div", "home-empty-text", "Noch keine Spiele"));
    empty.appendChild(
      _h("div", "home-empty-hint", 'Wechsle zum "Freunde" Tab und fordere jemanden heraus!')
    );
    container.appendChild(empty);
  }
}

// ──────────────────────────────────────────────
// Games history tab
// ──────────────────────────────────────────────

export function renderHistoryCard(game) {
  const me = _myUserId();
  const won = game.winner_id === me;
  const opp = _opponent(game);
  const myLetters   = _myLetters(game);
  const oppLetters  = _opponentLetters(game);

  const card = _h("div", "history-card");

  const result = _h("div", `history-result ${won ? "win" : "loss"}`);
  result.textContent = won ? "W" : "L";
  card.appendChild(result);

  const info = _h("div", "history-info");
  info.appendChild(_h("div", "history-opponent", opp.display_name || opp.username));

  const letters = _h("div", "history-letters");
  const WORD = "SKATE";

  const myGroup = _h("div", "history-letter-group");
  for (let i = 0; i < WORD.length; i++) {
    const ch = _h("span", "history-ch" + (i < myLetters.length ? " lit" : ""));
    ch.textContent = WORD[i];
    myGroup.appendChild(ch);
  }
  letters.appendChild(myGroup);

  letters.appendChild(_h("span", "history-letter-sep", "vs"));

  const oppGroup = _h("div", "history-letter-group");
  for (let i = 0; i < WORD.length; i++) {
    const ch = _h("span", "history-ch" + (i < oppLetters.length ? " lit" : ""));
    ch.textContent = WORD[i];
    oppGroup.appendChild(ch);
  }
  letters.appendChild(oppGroup);
  info.appendChild(letters);
  card.appendChild(info);

  const date = _h("div", "history-date");
  const d = new Date(game.updated_at);
  date.textContent = d.toLocaleDateString("de-DE", { day: "numeric", month: "short" });
  card.appendChild(date);

  return card;
}

export async function loadGamesTab() {
  const container = document.getElementById("games-content");
  if (!container) return;
  container.innerHTML = "";

  const token = getToken();
  const r = await fetch("/game/api/games/history", {
    headers: { Authorization: `Bearer ${token}` },
  }).catch(() => null);

  if (!r || !r.ok) {
    container.innerHTML = `<div style="padding:60px 20px;text-align:center;color:var(--dim);font-size:11px;text-transform:uppercase;letter-spacing:0.1em;">Fehler beim Laden</div>`;
    return;
  }

  const games = await r.json();
  if (!games.length) {
    container.innerHTML = `<div style="padding:60px 20px;text-align:center;color:var(--dim);font-size:11px;text-transform:uppercase;letter-spacing:0.1em;">Noch keine abgeschlossenen Spiele</div>`;
    return;
  }

  const me = _myUserId();
  const wins = games.filter(g => g.winner_id === me).length;
  const losses = games.length - wins;

  const sec = _h("div", "home-section");
  sec.appendChild(_sectionBar(1, "Ergebnisse", `${wins} W · ${losses} L`));
  games.forEach(g => sec.appendChild(renderHistoryCard(g)));
  container.appendChild(sec);
}

// ──────────────────────────────────────────────
// Public API
// ──────────────────────────────────────────────

export let _cachedHomeData = null;
export let _cachedHomeFriends = null;

export async function loadHomeTab() {
  const token = getToken();
  if (!token) return;

  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`,
  };

  // Fetch poll data + friends in parallel
  const [pollResp, friendsResp] = await Promise.all([
    fetch("/game/api/poll", { headers }).catch(() => null),
    fetch("/game/api/friends", { headers }).catch(() => null),
  ]);

  if (pollResp && pollResp.ok) {
    _cachedHomeData = await pollResp.json();
  }
  if (friendsResp && friendsResp.ok) {
    _cachedHomeFriends = await friendsResp.json();
  }

  renderHome(_cachedHomeData || {}, _cachedHomeFriends || []);
}

/** Called by poller onUpdate — only re-renders if home tab is active. */
export function updateHome(data) {
  _cachedHomeData = data;
  const homeTab = document.getElementById("tab-home");
  if (homeTab && homeTab.classList.contains("active")) {
    renderHome(_cachedHomeData, _cachedHomeFriends || []);
  }
}

/** Refresh friend list cache (called after friend changes). */
export async function refreshHomeFriends() {
  const token = getToken();
  if (!token) return;
  try {
    const resp = await fetch("/game/api/friends", {
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
    });
    if (resp.ok) _cachedHomeFriends = await resp.json();
  } catch { /* silent */ }
}
