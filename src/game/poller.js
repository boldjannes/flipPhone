"use strict";

import { getToken } from "./auth.js";
import { requestNotificationPermission, PollNotifier } from "./notifications.js";

/**
 * GamePoller — smart polling for Game of Skate.
 *
 * Intervals:
 *   - Active (tab visible, has active games): 3s
 *   - Idle   (tab visible, no active games):  60s
 *   - Hidden (tab in background):             30s
 *
 * Features:
 *   - Incremental: passes ?since= to only get changes
 *   - Exponential backoff on network errors (caps at 60s)
 *   - Immediate poll after own action via poll()
 *   - Visibility API integration
 *
 * Usage:
 *   const poller = new GamePoller((data) => {
 *     updateBadges(data.friend_requests_count, data.my_turn_count);
 *     renderActiveGames(data.active_games);
 *     showIncomingChallenges(data.pending_games);
 *   });
 *   poller.start();
 */
export class GamePoller {
  static INTERVAL_ACTIVE = 3000;
  static INTERVAL_IDLE = 60000;
  static INTERVAL_HIDDEN = 30000;
  static MAX_BACKOFF = 60000;

  constructor(onUpdate, myUserId) {
    this.onUpdate = onUpdate;
    this._since = "";
    this._timer = null;
    this._running = false;
    this._inflight = false;
    this._consecutiveErrors = 0;
    this._hasActiveGames = false;
    this._notifier = myUserId
      ? new PollNotifier(myUserId)
      : null;

    this._onVisibilityChange = this._onVisibilityChange.bind(this);
  }

  // ──────────────────────────────────────────────
  // Public API
  // ──────────────────────────────────────────────

  start() {
    if (this._running) return;
    this._running = true;
    this._since = "";
    this._consecutiveErrors = 0;
    if (this._notifier) this._notifier.reset();

    document.addEventListener("visibilitychange", this._onVisibilityChange);

    // Ask for notification permission (non-blocking)
    requestNotificationPermission().catch(() => {});

    this._poll();
  }

  stop() {
    this._running = false;
    clearTimeout(this._timer);
    this._timer = null;
    if (this._notifier) this._notifier.reset();
    document.removeEventListener("visibilitychange", this._onVisibilityChange);
  }

  /** Trigger an immediate poll (e.g. after making a move). */
  poll() {
    if (!this._running) return;
    clearTimeout(this._timer);
    this._poll();
  }

  /** Reset since cursor — next poll fetches everything. */
  reset() {
    this._since = "";
  }

  // ──────────────────────────────────────────────
  // Internal
  // ──────────────────────────────────────────────

  async _poll() {
    if (!this._running || this._inflight) return;
    this._inflight = true;

    try {
      const token = typeof getToken === "function" ? getToken() : null;
      if (!token) {
        this._inflight = false;
        this._scheduleNext();
        return;
      }

      const url = this._since
        ? `/game/api/poll?since=${encodeURIComponent(this._since)}`
        : "/game/api/poll";

      const resp = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` },
      });

      if (resp.status === 401) {
        // Session expired — stop polling, let auth handle it
        this._inflight = false;
        this.stop();
        return;
      }

      if (!resp.ok) {
        throw new Error(`Poll failed: ${resp.status}`);
      }

      const data = await resp.json();

      // Update cursor
      if (data.server_time) {
        this._since = data.server_time;
      }

      // Track whether there are active games (affects interval)
      this._hasActiveGames =
        (data.active_games && data.active_games.length > 0) ||
        (data.my_turn_count > 0);

      // Reset error backoff on success
      this._consecutiveErrors = 0;

      // Fire notifications for state changes (background tab only)
      if (this._notifier) {
        this._notifier.process(data);
      }

      // Notify UI callback
      if (this.onUpdate) {
        this.onUpdate(data);
      }
    } catch (err) {
      this._consecutiveErrors++;
    } finally {
      this._inflight = false;
      this._scheduleNext();
    }
  }

  _scheduleNext() {
    if (!this._running) return;
    clearTimeout(this._timer);
    const interval = this._getInterval();
    this._timer = setTimeout(() => this._poll(), interval);
  }

  _getInterval() {
    // Exponential backoff on errors
    if (this._consecutiveErrors > 0) {
      const backoff = Math.min(
        GamePoller.MAX_BACKOFF,
        1000 * Math.pow(2, this._consecutiveErrors)
      );
      return backoff;
    }

    // Tab hidden → slow poll
    if (document.hidden) {
      return GamePoller.INTERVAL_HIDDEN;
    }

    // Active games → fast poll
    if (this._hasActiveGames) {
      return GamePoller.INTERVAL_ACTIVE;
    }

    // Idle
    return GamePoller.INTERVAL_IDLE;
  }

  _onVisibilityChange() {
    if (!this._running) return;
    // When tab becomes visible again, poll immediately and reset interval
    if (!document.hidden) {
      clearTimeout(this._timer);
      this._poll();
    } else {
      // Tab hidden — reschedule with slower interval
      this._scheduleNext();
    }
  }
}
