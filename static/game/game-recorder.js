"use strict";

/**
 * GameRecorder — sensor recording + trick prediction for Game of Skate.
 *
 * Depends on:
 *   - SensorKit  (static/shared/sensor.js)
 *   - getToken() (static/game/auth.js)
 *
 * Usage:
 *   const recorder = new GameRecorder({
 *     onTrickDetected: (result) => updateUI(result),
 *     confidenceThreshold: 0.80,
 *     cooldownMs: 2000,
 *   });
 *
 *   // Setter flow
 *   const line = await recorder.recordLine(3);
 *   // → ["kickflip", "heelflip"]
 *
 *   // Matcher flow
 *   const result = await recorder.matchLine(["kickflip", "heelflip"]);
 *   // → { success: true, completedTricks: 2 }
 */
// Trick name→id mapping, loaded once from /game/api/tricks
let _trickNameToId = null;

async function _loadTrickMap() {
  if (_trickNameToId) return;
  try {
    const resp = await fetch("/game/api/tricks");
    if (resp.ok) {
      const list = await resp.json();
      _trickNameToId = {};
      list.forEach((t) => {
        _trickNameToId[t.name] = t.id;   // "Kickflip" → "kickflip"
        _trickNameToId[t.id] = t.id;     // "kickflip" → "kickflip"
      });
    }
  } catch { /* ignore */ }
}

function _normalizeTrick(raw) {
  if (!_trickNameToId) return raw;
  return _trickNameToId[raw] || raw;
}

class GameRecorder {
  constructor(options = {}) {
    this.confidenceThreshold = options.confidenceThreshold ?? 0.8;
    this.cooldownMs = options.cooldownMs ?? 2000;
    this.onTrickDetected = options.onTrickDetected || null;

    this._sensorReady = false;
    this._permissionNeeded = false;
    this._abortController = null;

    // Eagerly load trick mapping
    _loadTrickMap();
  }

  // ──────────────────────────────────────────────
  // Sensor lifecycle
  // ──────────────────────────────────────────────

  /**
   * Initialize sensors. Returns a Promise that resolves when ready
   * or rejects if sensors are unavailable.
   */
  initSensors() {
    if (this._sensorReady) return Promise.resolve();

    return new Promise((resolve, reject) => {
      SensorKit.init({
        onReady: () => {
          this._sensorReady = true;
          this._permissionNeeded = false;
          resolve();
        },
        onPermissionNeeded: () => {
          this._permissionNeeded = true;
          // Don't reject — permission can be requested later via user gesture
          resolve();
        },
        onError: (reason) => {
          reject(new Error(reason));
        },
      });

      // If SensorKit probed and already set ready synchronously
      if (SensorKit.isReady()) {
        this._sensorReady = true;
        resolve();
      }
    });
  }

  /**
   * Request iOS sensor permission (must be called from user gesture).
   */
  async requestPermission() {
    await SensorKit.requestPermission();
    this._sensorReady = true;
    this._permissionNeeded = false;
  }

  get needsPermission() {
    return this._permissionNeeded;
  }

  get sensorReady() {
    return this._sensorReady || SensorKit.isReady();
  }

  // ──────────────────────────────────────────────
  // Core recording
  // ──────────────────────────────────────────────

  /**
   * Start collecting sensor samples.
   */
  startRecording() {
    if (!this.sensorReady) throw new Error("Sensors not ready");
    SensorKit.startRecording();
  }

  /**
   * Stop recording and send samples to /api/predict.
   * Returns { trick, confidence, probabilities }.
   */
  async stopAndPredict() {
    const samples = SensorKit.stopRecording();

    if (samples.length < 5) {
      throw new Error("Too few samples — try a longer recording");
    }

    const resp = await fetch("/api/predict", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ samples }),
    });

    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      throw new Error(err.error || `Prediction failed (${resp.status})`);
    }

    const result = await resp.json();

    // Normalize trick name from predict API ("Kickflip" → "kickflip")
    result.trick = _normalizeTrick(result.trick);

    // Auto-save recording for data collection (fire-and-forget)
    this._saveRecording(samples, result.trick);

    if (this.onTrickDetected) {
      this.onTrickDetected(result);
    }

    return result;
  }

  /**
   * Fire-and-forget: save recording to server for ML training data.
   */
  _saveRecording(samples, trick) {
    const token = typeof getToken === "function" ? getToken() : null;
    if (!token) return;

    const body = {
      trick,
      samples,
      source: "game",
    };

    fetch("/game/api/recordings", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    }).catch(() => {});
  }

  // ──────────────────────────────────────────────
  // Setter flow: recordLine
  // ──────────────────────────────────────────────

  /**
   * Interactive setter loop. The caller must provide UI hooks via events.
   *
   * Returns a Promise<string[]> of trick labels.
   *
   * Flow:
   *   - Waits for user to call recorder.captureTrick()
   *   - Each capture: startRecording → stopAndPredict
   *   - If confidence >= threshold → trick added to line
   *   - If confidence < threshold → onTrickRejected callback, user retries
   *   - User calls recorder.finishLine() or maxTricks reached → resolves
   *   - User calls recorder.abort() → rejects
   *
   * Options callbacks:
   *   onTrickAdded(trick, line)      — trick was accepted into line
   *   onTrickRejected(result)        — confidence too low
   *   onCooldown(ms)                 — cooldown started
   *   onCooldownEnd()                — cooldown ended
   */
  recordLine(maxTricks = 3) {
    const line = [];

    return new Promise((resolve, reject) => {
      this._abortController = { aborted: false };
      const ac = this._abortController;

      this._captureResolve = null;
      this._finishResolve = null;

      // Called by UI when user taps "record trick"
      this._onCaptureTrick = async () => {
        if (ac.aborted) return;
        try {
          this.startRecording();
          // The UI should call stopCapture() when user taps stop
        } catch (err) {
          reject(err);
        }
      };

      // Called by UI when user taps "stop" during recording
      this._onStopCapture = async () => {
        if (ac.aborted) return;
        try {
          const result = await this.stopAndPredict();

          if (result.confidence >= this.confidenceThreshold) {
            line.push(result.trick);
            if (this.onTrickAdded) this.onTrickAdded(result.trick, [...line]);

            if (line.length >= maxTricks) {
              this._cleanup();
              resolve([...line]);
              return;
            }

            // Cooldown
            if (this.onCooldown) this.onCooldown(this.cooldownMs);
            await this._sleep(this.cooldownMs);
            if (ac.aborted) return;
            if (this.onCooldownEnd) this.onCooldownEnd();
          } else {
            if (this.onTrickRejected) this.onTrickRejected(result);
          }
        } catch (err) {
          if (this.onTrickRejected) this.onTrickRejected({ error: err.message });
        }
      };

      // Called by UI when user taps "finish line"
      this._onFinishLine = () => {
        if (ac.aborted) return;
        this._cleanup();
        resolve([...line]);
      };

      // Called to abort the whole flow
      this._onAbort = () => {
        ac.aborted = true;
        if (SensorKit.isRecording()) SensorKit.stopRecording();
        this._cleanup();
        reject(new Error("Aborted"));
      };
    });
  }

  /** Trigger a trick capture (call from UI "record" button). */
  captureTrick() {
    if (this._onCaptureTrick) this._onCaptureTrick();
  }

  /** Stop current capture and predict (call from UI "stop" button). */
  stopCapture() {
    if (this._onStopCapture) this._onStopCapture();
  }

  /** Finish the setter line early (call from UI "done" button). */
  finishLine() {
    if (this._onFinishLine) this._onFinishLine();
  }

  /** Abort any running flow. */
  abort() {
    if (this._onAbort) this._onAbort();
  }

  // ──────────────────────────────────────────────
  // Matcher flow: matchLine
  // ──────────────────────────────────────────────

  /**
   * Interactive matcher loop.
   *
   * Returns Promise<{ success: boolean, completedTricks: number }>
   *
   * For each trick in requiredLine:
   *   - Waits for user to call recorder.captureTrick() → stopCapture()
   *   - If correct trick & confidence >= threshold → next trick
   *   - If wrong trick or low confidence → fail
   *
   * Callbacks:
   *   onMatchProgress(index, total, requiredTrick)  — about to attempt trick[i]
   *   onMatchSuccess(index, result)                   — trick[i] matched
   *   onMatchFail(index, result, requiredTrick)       — trick[i] failed
   */
  matchLine(requiredLine) {
    let currentIndex = 0;

    return new Promise((resolve, reject) => {
      this._abortController = { aborted: false };
      const ac = this._abortController;

      const emitProgress = () => {
        if (this.onMatchProgress) {
          this.onMatchProgress(currentIndex, requiredLine.length, requiredLine[currentIndex]);
        }
      };

      emitProgress();

      this._onCaptureTrick = () => {
        if (ac.aborted) return;
        try {
          this.startRecording();
        } catch (err) {
          this._cleanup();
          reject(err);
        }
      };

      this._onStopCapture = async () => {
        if (ac.aborted) return;
        try {
          const result = await this.stopAndPredict();
          const required = requiredLine[currentIndex];

          if (
            result.trick === required &&
            result.confidence >= this.confidenceThreshold
          ) {
            // Match!
            if (this.onMatchSuccess) this.onMatchSuccess(currentIndex, result);
            currentIndex++;

            if (currentIndex >= requiredLine.length) {
              // All tricks matched
              this._cleanup();
              resolve({ success: true, completedTricks: currentIndex });
              return;
            }

            // Cooldown before next trick
            if (this.onCooldown) this.onCooldown(this.cooldownMs);
            await this._sleep(this.cooldownMs);
            if (ac.aborted) return;
            if (this.onCooldownEnd) this.onCooldownEnd();

            emitProgress();
          } else {
            // Failed
            if (this.onMatchFail) this.onMatchFail(currentIndex, result, required);
            this._cleanup();
            resolve({ success: false, completedTricks: currentIndex });
          }
        } catch (err) {
          this._cleanup();
          resolve({ success: false, completedTricks: currentIndex });
        }
      };

      this._onFinishLine = null; // not used in match mode

      this._onAbort = () => {
        ac.aborted = true;
        if (SensorKit.isRecording()) SensorKit.stopRecording();
        this._cleanup();
        reject(new Error("Aborted"));
      };
    });
  }

  // ──────────────────────────────────────────────
  // Internal
  // ──────────────────────────────────────────────

  _cleanup() {
    this._onCaptureTrick = null;
    this._onStopCapture = null;
    this._onFinishLine = null;
    this._onAbort = null;
    this._abortController = null;
  }

  _sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }
}
