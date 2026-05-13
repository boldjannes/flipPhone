"use strict";

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

const SKATE_WORD = "SKATE";

// ──────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────

function _h(tag, cls, text) {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text !== undefined) el.textContent = text;
  return el;
}

function _avatar(user, size) {
  const name = user.display_name || user.username;
  const el = _h("div", "avatar-circle" + (size ? ` avatar-${size}` : ""));
  el.textContent = name.slice(0, 2).toUpperCase();
  return el;
}

function _myUserId() {
  const u = getCachedUser();
  return u ? u.id : null;
}

function _opponent(game) {
  const me = _myUserId();
  return game.challenger.id === me ? game.opponent : game.challenger;
}

function _myLetters(game) {
  const me = _myUserId();
  return game.challenger.id === me
    ? game.challenger_letters
    : game.opponent_letters;
}

function _opponentLetters(game) {
  const me = _myUserId();
  return game.challenger.id === me
    ? game.opponent_letters
    : game.challenger_letters;
}

// ──────────────────────────────────────────────
// SKATE letters visual
// ──────────────────────────────────────────────

function renderSkateLetters(letters, labelPrefix) {
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

function renderGameCard(game, isMyTurn) {
  const opp = _opponent(game);
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
    btn.addEventListener("click", () => navigateToGame(game.id));
    card.appendChild(btn);
  }

  return card;
}

// ──────────────────────────────────────────────
// Invitation card
// ──────────────────────────────────────────────

function renderInvitationCard(game) {
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

function renderSentInvitationCard(game) {
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

function renderFriendScroller(friends) {
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
    const btn = _h("button", "home-challenge-btn accent-btn", "Challenge");
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

function renderHome(data, friends) {
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

  // 1. Incoming invitations (most urgent — action required)
  if (invitations.length) {
    const sec = _h("div", "home-section");
    sec.appendChild(_h("div", "home-section-title", "Einladungen"));
    invitations.forEach((g) => sec.appendChild(renderInvitationCard(g)));
    container.appendChild(sec);
  }

  // 2. My turn
  if (myTurnGames.length) {
    const sec = _h("div", "home-section");
    sec.appendChild(_h("div", "home-section-title", "Du bist dran"));
    myTurnGames.forEach((g) => sec.appendChild(renderGameCard(g, true)));
    container.appendChild(sec);
  }

  // 3. Waiting for opponent
  if (waitingGames.length) {
    const sec = _h("div", "home-section");
    sec.appendChild(_h("div", "home-section-title", "Warten auf Gegner"));
    waitingGames.forEach((g) => sec.appendChild(renderGameCard(g, false)));
    container.appendChild(sec);
  }

  // 4. Sent invitations (waiting for accept)
  if (sentInvitations.length) {
    const sec = _h("div", "home-section");
    sec.appendChild(_h("div", "home-section-title", "Gesendete Einladungen"));
    sentInvitations.forEach((g) => sec.appendChild(renderSentInvitationCard(g)));
    container.appendChild(sec);
  }

  // 5. Challenge friends scroller
  if (friends && friends.length) {
    const sec = _h("div", "home-section");
    sec.appendChild(_h("div", "home-section-title", "Freunde herausfordern"));
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
// Public API
// ──────────────────────────────────────────────

let _cachedHomeData = null;
let _cachedHomeFriends = null;

async function loadHomeTab() {
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
function updateHome(data) {
  _cachedHomeData = data;
  const homeTab = document.getElementById("tab-home");
  if (homeTab && homeTab.classList.contains("active")) {
    renderHome(_cachedHomeData, _cachedHomeFriends || []);
  }
}

/** Refresh friend list cache (called after friend changes). */
async function refreshHomeFriends() {
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
