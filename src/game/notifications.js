"use strict";

/**
 * GameNotifications — browser Notification API for Game of Skate.
 *
 * Local notifications only (no push server). Fires when:
 *   - Tab is in background (document.hidden)
 *   - Poller detects a state change (new challenge, your turn, game over)
 *
 * Clicking a notification focuses the tab and optionally navigates.
 *
 * Future: for offline/closed-tab notifications, integrate Web Push with
 * VAPID keys + pywebpush on the Flask side. See bottom of file for outline.
 */

export const NOTIFICATION_PERM_KEY = "fp_notification_perm";

// ──────────────────────────────────────────────
// Permission
// ──────────────────────────────────────────────

export function getNotificationPermission() {
  if (!("Notification" in window)) return "unsupported";
  return Notification.permission; // "default" | "granted" | "denied"
}

export async function requestNotificationPermission() {
  if (!("Notification" in window)) return "unsupported";

  if (Notification.permission === "granted") {
    localStorage.setItem(NOTIFICATION_PERM_KEY, "granted");
    return "granted";
  }

  if (Notification.permission === "denied") {
    localStorage.setItem(NOTIFICATION_PERM_KEY, "denied");
    return "denied";
  }

  const result = await Notification.requestPermission();
  localStorage.setItem(NOTIFICATION_PERM_KEY, result);
  return result;
}

export function canNotify() {
  return (
    "Notification" in window &&
    Notification.permission === "granted" &&
    document.hidden
  );
}

// ──────────────────────────────────────────────
// Notification helpers
// ──────────────────────────────────────────────

export function _notify(title, body, tag, onClick) {
  if (!canNotify()) return null;

  const n = new Notification(title, {
    body,
    tag,           // deduplicates: same tag replaces previous
    icon: "/static/shared/icon-192.png",
    badge: "/static/shared/icon-192.png",
    renotify: true,
  });

  n.onclick = () => {
    window.focus();
    n.close();
    if (onClick) onClick();
  };

  // Auto-close after 8s
  setTimeout(() => n.close(), 8000);
  return n;
}

// ──────────────────────────────────────────────
// Public notification functions
// ──────────────────────────────────────────────

export function notifyNewChallenge(fromUsername, gameId) {
  _notify(
    "Neue Herausforderung!",
    `@${fromUsername} hat dich herausgefordert!`,
    `challenge-${gameId}`,
    () => {
      if (typeof navigateToGame === "function") navigateToGame(gameId);
    }
  );
}

export function notifyYourTurn(gameId, opponentUsername) {
  _notify(
    "Du bist dran!",
    `@${opponentUsername} ist fertig \u2013 dein Zug!`,
    `turn-${gameId}`,
    () => {
      if (typeof navigateToGame === "function") navigateToGame(gameId);
    }
  );
}

export function notifyGameOver(won, opponentUsername, gameId) {
  const title = won ? "Gewonnen!" : "Verloren";
  const body = won
    ? `Du hast gegen @${opponentUsername} gewonnen!`
    : `@${opponentUsername} hat gewonnen.`;

  _notify(title, body, `gameover-${gameId}`, () => {
    if (typeof navigateToGame === "function") navigateToGame(gameId);
  });
}

// ──────────────────────────────────────────────
// Diff engine — compare previous and current poll data
// ──────────────────────────────────────────────

/**
 * Call this from the poller's onUpdate callback.
 * Tracks previous state internally and fires notifications on changes.
 *
 *   const notifier = new PollNotifier(myUserId);
 *   // inside poller onUpdate:
 *   notifier.process(data);
 */
export class PollNotifier {
  constructor(myUserId) {
    this.myUserId = myUserId;
    this._prevMyTurnCount = -1;    // -1 = first poll, don't notify
    this._knownPendingIds = new Set();
    this._knownActiveIds = new Set();
    this._knownFinishedIds = new Set();
  }

  process(data) {
    // ── New challenges ──
    if (data.pending_games) {
      for (const game of data.pending_games) {
        if (!this._knownPendingIds.has(game.id)) {
          this._knownPendingIds.add(game.id);
          const from = game.challenger?.username || "Someone";
          notifyNewChallenge(from, game.id);
        }
      }
    }

    // ── Your turn (new games where it's my turn, or turn changed to me) ──
    if (data.active_games) {
      for (const game of data.active_games) {
        const isMyTurn = game.current_turn_id === this.myUserId;
        const wasKnown = this._knownActiveIds.has(game.id);

        // Game just became active (accepted) — track it
        this._knownActiveIds.add(game.id);
        // Remove from pending if it moved to active
        this._knownPendingIds.delete(game.id);

        if (isMyTurn && wasKnown) {
          // Turn switched to me (opponent made their move)
          const opponent =
            game.challenger?.id === this.myUserId
              ? game.opponent
              : game.challenger;
          notifyYourTurn(game.id, opponent?.username || "Opponent");
        }
      }
    }

    // ── Game over detection ──
    // The poll endpoint returns active_games (status='active').
    // When a game finishes, it disappears from active_games.
    // We detect this by checking which known active IDs are now missing.
    if (data.active_games && this._prevMyTurnCount >= 0) {
      const currentActiveIds = new Set(data.active_games.map((g) => g.id));
      for (const id of this._knownActiveIds) {
        if (!currentActiveIds.has(id) && !this._knownFinishedIds.has(id)) {
          this._knownFinishedIds.add(id);
          // Fetch the finished game to determine winner
          this._checkFinishedGame(id);
        }
      }
    }

    // ── Update my-turn count for badge tracking ──
    this._prevMyTurnCount = data.my_turn_count ?? 0;
  }

  async _checkFinishedGame(gameId) {
    try {
      const token = typeof getToken === "function" ? getToken() : null;
      if (!token) return;
      const resp = await fetch(`/game/api/games/${gameId}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!resp.ok) return;
      const game = await resp.json();
      if (game.status !== "finished") return;

      const won = game.winner_id === this.myUserId;
      const opponent =
        game.challenger?.id === this.myUserId
          ? game.opponent
          : game.challenger;
      notifyGameOver(won, opponent?.username || "Opponent", gameId);
    } catch {
      // Silent — notification is best-effort
    }
  }

  /** Reset state (e.g. on logout). */
  reset() {
    this._prevMyTurnCount = -1;
    this._knownPendingIds.clear();
    this._knownActiveIds.clear();
    this._knownFinishedIds.clear();
  }
}


// ──────────────────────────────────────────────
// Web Push outline (not implemented)
// ──────────────────────────────────────────────
//
// For notifications when the tab is fully closed, you'd need:
//
// Flask side (pywebpush + VAPID):
// ─────────────────────────────────
//   pip install pywebpush
//
//   # Generate VAPID keys once:
//   # vapid --gen → creates private_key.pem + public_key
//
//   VAPID_PRIVATE_KEY = os.environ['VAPID_PRIVATE_KEY']
//   VAPID_PUBLIC_KEY  = os.environ['VAPID_PUBLIC_KEY']
//   VAPID_CLAIMS      = { "sub": "mailto:you@example.com" }
//
//   # New table: push_subscriptions (user_id, endpoint, p256dh, auth)
//
//   @game.route('/game/api/push/subscribe', methods=['POST'])
//   @require_game_session
//   def push_subscribe():
//       sub = request.get_json()
//       db.execute('INSERT INTO push_subscriptions ...', (...))
//       db.commit()
//       return jsonify({'status': 'subscribed'})
//
//   # After game state changes, send push:
//   from pywebpush import webpush, WebPushException
//   def send_push(subscription_info, payload):
//       webpush(subscription_info, json.dumps(payload),
//               vapid_private_key=VAPID_PRIVATE_KEY,
//               vapid_claims=VAPID_CLAIMS)
//
// Client side (Service Worker):
// ──────────────────────────────
//   // Register SW:
//   navigator.serviceWorker.register('/sw.js')
//
//   // Subscribe:
//   const sub = await reg.pushManager.subscribe({
//     userVisibleOnly: true,
//     applicationServerKey: VAPID_PUBLIC_KEY
//   });
//   await fetch('/game/api/push/subscribe', {
//     method: 'POST', body: JSON.stringify(sub), ...
//   });
//
//   // In sw.js:
//   self.addEventListener('push', (e) => {
//     const data = e.data.json();
//     e.waitUntil(self.registration.showNotification(data.title, {
//       body: data.body, tag: data.tag, data: data
//     }));
//   });
//   self.addEventListener('notificationclick', (e) => {
//     e.notification.close();
//     e.waitUntil(clients.openWindow(e.notification.data.url));
//   });
