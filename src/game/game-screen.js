"use strict";

import { getToken, getCachedUser } from "./auth.js";
import { GameRecorder } from "./game-recorder.js";
import { SensorKit } from "../shared/sensor.js";

/**
 * Game Screen — fullscreen overlay for active gameplay.
 *
 * Sub-screens:
 *   A. Setter  — record 1-3 tricks to set a line
 *   B. Matcher — replicate the opponent's line
 *   C. Waiting — opponent is playing, poll for updates
 *
 * Depends on: auth.js (getToken, getCachedUser), game-recorder.js (GameRecorder),
 *             shared/sensor.js (SensorKit), poller.js (gamePoller)
 */

// ──────────────────────────────────────────────
// Trick reference hints (matcher screen)
// ──────────────────────────────────────────────
export const TRICK_HINTS = {
  kickflip:       "Fuß an der Nose-Seite. Kick nach vorne-außen — Board dreht über die Längsachse.",
  heelflip:       "Ferse schiebt nach vorne-innen — Board dreht zur Heel-Seite (entgegengesetzt zum Kickflip).",
  fs_shuvit:      "Kein Flip. Board dreht 180° backside (Nose nach vorne). Frontside Pop.",
  fs_360_shuvit:  "Kein Flip. Board dreht 360° backside. Voller Umlauf.",
  bs_shuvit:      "Kein Flip. Board dreht 180° frontside (Nose nach hinten). Backside Pop.",
  bs_360_shuvit:  "Kein Flip. Board dreht 360° frontside. Voller Umlauf.",
  treflip:        "360° Backside Shuvit + Kickflip gleichzeitig — auch Tre-Flip oder 360 Flip.",
  late_kickflip:  "Kickflip erst nach dem Absprung — spät, kurz vor der Landung.",
};

// ──────────────────────────────────────────────
// State
// ──────────────────────────────────────────────
export let _gsGameId = null;
export let _gsGame = null;
export let _gsRecorder = null;
export let _gsLine = [];
export let _gsRecording = false;
export let _gsSubmitting = false;
export let _gsWaitTimer = null;

export const GS = {
  overlay: () => document.getElementById("game-screen"),
  content: () => document.getElementById("gs-content"),
};

// ──────────────────────────────────────────────
// DOM helpers
// ──────────────────────────────────────────────
export function _gs(tag, cls, text) {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text !== undefined) el.textContent = text;
  return el;
}

export function _gsAvatar(user) {
  const name = user.display_name || user.username;
  const el = _gs("div", "gs-avatar");
  el.textContent = name.slice(0, 2).toUpperCase();
  return el;
}

export function _gsMyId() {
  const u = getCachedUser();
  return u ? u.id : null;
}

export function _gsOpponent(game) {
  const me = _gsMyId();
  return game.challenger.id === me ? game.opponent : game.challenger;
}

export function _gsMyLetters(game) {
  const me = _gsMyId();
  return game.challenger.id === me ? game.challenger_letters : game.opponent_letters;
}

export function _gsOppLetters(game) {
  const me = _gsMyId();
  return game.challenger.id === me ? game.opponent_letters : game.challenger_letters;
}

// ──────────────────────────────────────────────
// SKATE stand bar (shared by all sub-screens)
// ──────────────────────────────────────────────
export function _gsSkateBar(game) {
  const bar = _gs("div", "gs-skate-bar");
  const me = getCachedUser();
  const opp = _gsOpponent(game);

  // My side
  const myWrap = _gs("div", "gs-skate-side");
  myWrap.appendChild(_gs("div", "gs-skate-name gs-skate-me", "Du"));
  myWrap.appendChild(_gsSkateLetters(_gsMyLetters(game)));
  bar.appendChild(myWrap);

  // VS
  bar.appendChild(_gs("div", "gs-vs", "vs"));

  // Opponent side
  const oppWrap = _gs("div", "gs-skate-side");
  oppWrap.appendChild(_gs("div", "gs-skate-name", opp.display_name || opp.username));
  oppWrap.appendChild(_gsSkateLetters(_gsOppLetters(game)));
  bar.appendChild(oppWrap);

  return bar;
}

export function _gsSkateLetters(letters) {
  const wrap = _gs("div", "gs-skate-letters");
  const word = "SKATE";
  for (let i = 0; i < word.length; i++) {
    const ch = _gs("span", "gs-skate-ch" + (i < letters.length ? " gs-ch-active" : ""));
    ch.textContent = word[i];
    wrap.appendChild(ch);
  }
  return wrap;
}

// ──────────────────────────────────────────────
// Trick pill
// ──────────────────────────────────────────────
export function _gsTrickPill(trick, state) {
  // state: "pending" | "current" | "done" | "failed"
  const pill = _gs("div", `gs-trick-pill gs-pill-${state}`);
  const label = trick.replace(/_/g, " ");
  if (state === "done") {
    pill.innerHTML = `<span class="gs-pill-check">\u2713</span> ${_esc(label)}`;
  } else if (state === "failed") {
    pill.innerHTML = `<span class="gs-pill-x">\u2717</span> ${_esc(label)}`;
  } else {
    pill.textContent = label;
  }
  return pill;
}

export function _esc(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ──────────────────────────────────────────────
// Open game screen
// ──────────────────────────────────────────────
export async function openGame(gameId) {
  _gsGameId = gameId;
  _gsLine = [];
  _gsRecording = false;
  _gsSubmitting = false;

  // Show overlay
  GS.overlay().classList.remove("hidden");
  GS.content().innerHTML = '<div class="gs-loading">Laden...</div>';

  // Fetch game state
  try {
    const token = getToken();
    const resp = await fetch(`/game/api/games/${gameId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!resp.ok) throw new Error("Game not found");
    _gsGame = await resp.json();
  } catch (err) {
    GS.content().innerHTML = `<div class="gs-loading">Fehler: ${_esc(err.message)}</div>`;
    return;
  }

  // Init recorder
  if (!_gsRecorder) {
    _gsRecorder = new GameRecorder({ confidenceThreshold: 0.70 });
    await _gsRecorder.initSensors().catch(() => {});
  }

  _gsRender();
}

export function closeGame() {
  if (_gsRecorder) _gsRecorder.abort();
  if (_gsWaitTimer) { clearInterval(_gsWaitTimer); _gsWaitTimer = null; }
  _gsGameId = null;
  _gsGame = null;
  _gsLine = [];
  _gsRecording = false;
  GS.overlay().classList.add("hidden");
  GS.content().innerHTML = "";

  // Refresh home
  if (typeof gamePoller !== "undefined" && gamePoller) gamePoller.poll();
}

// ──────────────────────────────────────────────
// Route to correct sub-screen
// ──────────────────────────────────────────────
export function _gsRender() {
  const game = _gsGame;
  if (!game) return;
  const me = _gsMyId();

  if (game.status === "finished") {
    _gsRenderFinished(game);
  } else if (game.current_turn_id !== me) {
    _gsRenderWaiting(game);
  } else if (game.current_role === "setter") {
    _gsRenderSetter(game);
  } else {
    _gsRenderMatcher(game);
  }
}

// ──────────────────────────────────────────────
// Sub-Screen A: Setter
// ──────────────────────────────────────────────
export function _gsRenderSetter(game) {
  const c = GS.content();
  c.innerHTML = "";

  // Back button
  c.appendChild(_gsBackBtn());

  // SKATE bar
  c.appendChild(_gsSkateBar(game));

  // Title
  c.appendChild(_gs("div", "gs-title", "Deine Line festlegen"));
  c.appendChild(_gs("div", "gs-subtitle", "Zeige 1\u20133 Tricks. Dein Gegner muss sie nachmachen."));

  // Trick pills area
  const pillArea = _gs("div", "gs-pill-area");
  pillArea.id = "gs-setter-pills";
  _gsLine.forEach((t) => pillArea.appendChild(_gsTrickPill(t, "done")));
  c.appendChild(pillArea);

  // Counter
  const counter = _gs("div", "gs-counter");
  counter.id = "gs-setter-counter";
  counter.textContent = `${_gsLine.length}/3 Tricks`;
  c.appendChild(counter);

  // Sensor permission banner
  if (_gsRecorder && _gsRecorder.needsPermission) {
    const banner = _gs("div", "gs-perm-banner");
    banner.textContent = "Sensoren aktivieren ";
    const permBtn = _gs("button", "gs-perm-btn", "Erlauben");
    permBtn.addEventListener("click", async () => {
      try {
        await _gsRecorder.requestPermission();
        banner.remove();
      } catch { /* */ }
    });
    banner.appendChild(permBtn);
    c.appendChild(banner);
  }

  // Status message
  const status = _gs("div", "gs-status");
  status.id = "gs-status";
  c.appendChild(status);

  // Action area
  const actions = _gs("div", "gs-actions");

  const recordBtn = _gs("button", "gs-record-btn");
  recordBtn.id = "gs-record-btn";
  recordBtn.textContent = "Trick aufnehmen";
  recordBtn.addEventListener("click", () => _gsSetterToggleRecord());
  actions.appendChild(recordBtn);

  if (_gsLine.length >= 1) {
    const submitBtn = _gs("button", "gs-submit-btn accent-btn");
    submitBtn.id = "gs-submit-line-btn";
    submitBtn.textContent = "Line absenden";
    submitBtn.addEventListener("click", () => _gsSetterSubmit());
    actions.appendChild(submitBtn);
  }

  c.appendChild(actions);
}

export async function _gsSetterToggleRecord() {
  const btn = document.getElementById("gs-record-btn");
  const status = document.getElementById("gs-status");
  if (!btn) return;

  if (!_gsRecording) {
    // Start
    try {
      _gsRecorder.startRecording();
      _gsRecording = true;
      btn.textContent = "Stoppen & Erkennen";
      btn.classList.add("gs-btn-recording");
      if (status) status.textContent = "Aufnahme l\u00e4uft \u2013 mach deinen Trick!";
    } catch (err) {
      if (status) status.textContent = err.message;
    }
  } else {
    // Stop & predict
    _gsRecording = false;
    btn.textContent = "Auswerten...";
    btn.disabled = true;
    if (status) status.textContent = "Analysiere...";

    try {
      const result = await _gsRecorder.stopAndPredict();

      if (result.confidence >= _gsRecorder.confidenceThreshold) {
        _gsLine.push(result.trick);
        _gsShowDetectFlash(result.trick, result.confidence, true);

        if (_gsLine.length >= 3) {
          await _gsSetterSubmit();
          return;
        }

        setTimeout(() => _gsRenderSetter(_gsGame), 700);
      } else {
        _gsShowDetectFlash(result.trick, result.confidence, false);
        if (status) status.textContent = "Nicht erkannt – nochmal versuchen!";
        setTimeout(() => {
          btn.textContent = "Trick aufnehmen";
          btn.disabled = false;
          btn.classList.remove("gs-btn-recording");
        }, 700);
      }
    } catch (err) {
      if (status) status.textContent = "Fehler: " + err.message;
      btn.textContent = "Trick aufnehmen";
      btn.disabled = false;
      btn.classList.remove("gs-btn-recording");
    }
  }
}

export async function _gsSetterSubmit() {
  if (_gsSubmitting || _gsLine.length === 0) return;
  _gsSubmitting = true;

  const btn = document.getElementById("gs-submit-line-btn");
  const status = document.getElementById("gs-status");
  if (btn) { btn.disabled = true; btn.textContent = "Sende..."; }
  if (status) status.textContent = "Line wird gesendet...";

  try {
    const token = getToken();
    const resp = await fetch(`/game/api/games/${_gsGameId}/set-line`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ tricks: _gsLine }),
    });
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      throw new Error(err.error || "Fehler");
    }
    _gsGame = await resp.json();
    _gsLine = [];
    _gsSubmitting = false;
    _gsRender(); // → waiting screen
  } catch (err) {
    if (status) status.textContent = "Fehler: " + err.message;
    if (btn) { btn.disabled = false; btn.textContent = "Line absenden"; }
    _gsSubmitting = false;
  }
}

// ──────────────────────────────────────────────
// Sub-Screen B: Matcher
// ──────────────────────────────────────────────
export let _gsMatchIndex = 0;
export let _gsMatchFailed = false;

export function _gsRenderMatcher(game) {
  const c = GS.content();
  c.innerHTML = "";
  _gsMatchIndex = 0;
  _gsMatchFailed = false;

  const line = game.current_line || [];

  // Back button
  c.appendChild(_gsBackBtn());

  // SKATE bar
  c.appendChild(_gsSkateBar(game));

  // Title
  const opp = _gsOpponent(game);
  c.appendChild(_gs("div", "gs-title", "Line nachmachen"));
  c.appendChild(_gs("div", "gs-subtitle", `${opp.display_name || opp.username} hat ${line.length} Trick${line.length > 1 ? "s" : ""} vorgelegt.`));

  // Line display (trick cards)
  const lineWrap = _gs("div", "gs-line-display");
  lineWrap.id = "gs-match-line";
  line.forEach((trick, i) => {
    const state = i < _gsMatchIndex ? "done" : i === _gsMatchIndex ? "current" : "pending";
    lineWrap.appendChild(_gsTrickPill(trick, state));
  });
  c.appendChild(lineWrap);

  // Sensor permission
  if (_gsRecorder && _gsRecorder.needsPermission) {
    const banner = _gs("div", "gs-perm-banner");
    banner.textContent = "Sensoren aktivieren ";
    const permBtn = _gs("button", "gs-perm-btn", "Erlauben");
    permBtn.addEventListener("click", async () => {
      try {
        await _gsRecorder.requestPermission();
        banner.remove();
      } catch { /* */ }
    });
    banner.appendChild(permBtn);
    c.appendChild(banner);
  }

  // Trick reference card for current trick
  if (line[_gsMatchIndex]) {
    c.appendChild(_gsTrickRef(line[_gsMatchIndex]));
  }

  // Status
  const status = _gs("div", "gs-status");
  status.id = "gs-status";
  c.appendChild(status);

  // Record button
  const actions = _gs("div", "gs-actions");
  const recordBtn = _gs("button", "gs-record-btn");
  recordBtn.id = "gs-record-btn";
  recordBtn.textContent = "Trick aufnehmen";
  recordBtn.addEventListener("click", () => _gsMatcherToggleRecord());
  actions.appendChild(recordBtn);
  c.appendChild(actions);
}

export function _gsTrickRef(trickId) {
  const name = trickId.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase());
  const hint = TRICK_HINTS[trickId] || "";
  const card = _gs("div", "gs-trick-ref");
  card.id = "gs-trick-ref";
  card.appendChild(_gs("div", "gs-trick-ref-label", "Aktueller Trick"));
  card.appendChild(_gs("div", "gs-trick-ref-name", name));
  if (hint) card.appendChild(_gs("div", "gs-trick-ref-hint", hint));
  return card;
}

export async function _gsMatcherToggleRecord() {
  const game = _gsGame;
  const line = game.current_line || [];
  const btn = document.getElementById("gs-record-btn");
  const status = document.getElementById("gs-status");
  if (!btn || _gsMatchFailed) return;

  if (!_gsRecording) {
    try {
      _gsRecorder.startRecording();
      _gsRecording = true;
      btn.textContent = "Stoppen & Pr\u00fcfen";
      btn.classList.add("gs-btn-recording");
      if (status) status.textContent = `Aufnahme \u2013 mach: ${line[_gsMatchIndex].replace(/_/g, " ")}`;
    } catch (err) {
      if (status) status.textContent = err.message;
    }
  } else {
    _gsRecording = false;
    btn.textContent = "Auswerten...";
    btn.disabled = true;
    if (status) status.textContent = "Analysiere...";

    try {
      const result = await _gsRecorder.stopAndPredict();
      const required = line[_gsMatchIndex];
      // Normalize both sides: predict API may return display name ("Kickflip"),
      // DB stores id ("kickflip"). normalizeTrick resolves both to id.
      const detectedId = normalizeTrick(result.trick);
      const requiredId = normalizeTrick(required);
      const matched =
        detectedId === requiredId &&
        result.confidence >= _gsRecorder.confidenceThreshold;

      if (matched) {
        _gsMatchIndex++;
        _gsUpdateMatchPills(line);
        _gsShowDetectFlash(result.trick, result.confidence, true);

        if (_gsMatchIndex >= line.length) {
          btn.remove();
          setTimeout(() => _gsMatcherSubmit(true), 800);
          return;
        }

        // Update trick reference for next trick
        setTimeout(() => {
          const refCard = document.getElementById("gs-trick-ref");
          if (refCard && line[_gsMatchIndex]) {
            const newRef = _gsTrickRef(line[_gsMatchIndex]);
            refCard.replaceWith(newRef);
          }
          btn.textContent = "Trick aufnehmen";
          btn.disabled = false;
          btn.classList.remove("gs-btn-recording");
        }, 800);
      } else {
        _gsMatchFailed = true;
        _gsUpdateMatchPills(line, _gsMatchIndex);
        _gsShowDetectFlash(result.trick, result.confidence, false);
        btn.remove();
        setTimeout(() => _gsMatcherSubmit(false), 800);
      }
    } catch (err) {
      if (status) status.textContent = "Fehler: " + err.message;
      btn.textContent = "Trick aufnehmen";
      btn.disabled = false;
      btn.classList.remove("gs-btn-recording");
    }
  }
}

export function _gsUpdateMatchPills(line, failIdx) {
  const wrap = document.getElementById("gs-match-line");
  if (!wrap) return;
  wrap.innerHTML = "";
  line.forEach((trick, i) => {
    let state;
    if (i < _gsMatchIndex) state = "done";
    else if (failIdx !== undefined && i === failIdx) state = "failed";
    else if (i === _gsMatchIndex) state = "current";
    else state = "pending";
    wrap.appendChild(_gsTrickPill(trick, state));
  });
}

export async function _gsMatcherSubmit(success) {
  if (_gsSubmitting) return;
  _gsSubmitting = true;

  const status = document.getElementById("gs-status");
  if (status) status.textContent = success ? "Sende Ergebnis..." : "Sende Ergebnis...";

  try {
    const token = getToken();
    const resp = await fetch(`/game/api/games/${_gsGameId}/submit-attempt`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        tricks: _gsGame.current_line || [],
        success,
      }),
    });
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      throw new Error(err.error || "Fehler");
    }
    const prevGame = _gsGame;
    _gsGame = await resp.json();
    _gsSubmitting = false;

    // Show result overlay
    _gsRenderResult(prevGame, _gsGame, success);
  } catch (err) {
    if (status) status.textContent = "Fehler: " + err.message;
    _gsSubmitting = false;
  }
}

// ──────────────────────────────────────────────
// Result Overlay
// ──────────────────────────────────────────────
export function _gsRenderResult(prevGame, newGame, success) {
  const c = GS.content();
  c.innerHTML = "";

  const wrap = _gs("div", "gs-result-wrap");

  // Icon
  const icon = _gs("div", "gs-result-icon");
  icon.textContent = success ? "\u2713" : "\u2717";
  icon.classList.add(success ? "gs-result-success" : "gs-result-fail");
  wrap.appendChild(icon);

  // Message
  const me = _gsMyId();
  const myOldLetters = prevGame.challenger.id === me ? prevGame.challenger_letters : prevGame.opponent_letters;
  const myNewLetters = _gsMyLetters(newGame);
  const newLetter = myNewLetters.slice(myOldLetters.length);

  if (success) {
    wrap.appendChild(_gs("div", "gs-result-title", "Geschafft!"));
    wrap.appendChild(_gs("div", "gs-result-text", "Kein Buchstabe."));
  } else {
    wrap.appendChild(_gs("div", "gs-result-title", "Nicht geschafft"));
    if (newLetter) {
      wrap.appendChild(_gs("div", "gs-result-letter", newLetter));
      wrap.appendChild(_gs("div", "gs-result-text", `Du bekommst "${newLetter}"`));
    }
  }

  // Animated SKATE stand
  const standWrap = _gs("div", "gs-result-stand");
  const word = "SKATE";
  for (let i = 0; i < word.length; i++) {
    const ch = _gs("span", "gs-skate-ch");
    ch.textContent = word[i];
    if (i < myNewLetters.length) {
      ch.classList.add("gs-ch-active");
      // Animate newly added letter
      if (i >= myOldLetters.length) {
        ch.classList.add("gs-ch-stamp");
      }
    }
    standWrap.appendChild(ch);
  }
  wrap.appendChild(standWrap);

  // Game over?
  if (newGame.status === "finished") {
    const won = newGame.winner_id === me;
    const goText = _gs("div", "gs-result-gameover");
    goText.textContent = won ? "Spiel gewonnen!" : "Spiel verloren.";
    goText.classList.add(won ? "gs-result-success" : "gs-result-fail");
    wrap.appendChild(goText);
  }

  // OK button
  const okBtn = _gs("button", "gs-ok-btn accent-btn", "OK");
  okBtn.addEventListener("click", () => closeGame());
  wrap.appendChild(okBtn);

  c.appendChild(wrap);
}

// ──────────────────────────────────────────────
// Sub-Screen C: Waiting
// ──────────────────────────────────────────────
export function _gsRenderWaiting(game) {
  const c = GS.content();
  c.innerHTML = "";

  c.appendChild(_gsBackBtn());
  c.appendChild(_gsSkateBar(game));

  const opp = _gsOpponent(game);
  const wrap = _gs("div", "gs-waiting-wrap");

  const avatar = _gs("div", "gs-waiting-avatar");
  avatar.textContent = (opp.display_name || opp.username).slice(0, 2).toUpperCase();
  wrap.appendChild(avatar);

  // Context-aware copy
  const isMatcher = game.current_role === "matcher";
  const waitText = isMatcher
    ? `@${opp.username} versucht deine Line nachzumachen...`
    : `@${opp.username} legt eine neue Line fest...`;
  wrap.appendChild(_gs("div", "gs-waiting-text", waitText));

  const pulse = _gs("div", "gs-waiting-pulse");
  for (let i = 0; i < 3; i++) {
    const dot = _gs("span", "gs-pulse-dot");
    dot.style.animationDelay = `${i * 0.3}s`;
    pulse.appendChild(dot);
  }
  wrap.appendChild(pulse);

  // Show current line if opponent is matching it
  if (isMatcher && game.current_line && game.current_line.length) {
    const ctx = _gs("div", "gs-waiting-context");
    ctx.appendChild(_gs("div", "gs-waiting-context-label", "Deine Line"));
    const pillRow = _gs("div", "gs-waiting-pills");
    game.current_line.forEach((trick) => {
      pillRow.appendChild(_gs("span", "gs-waiting-pill", trick.replace(/_/g, " ")));
    });
    ctx.appendChild(pillRow);
    wrap.appendChild(ctx);
  }

  c.appendChild(wrap);

  // Poll for updates
  if (_gsWaitTimer) clearInterval(_gsWaitTimer);
  _gsWaitTimer = setInterval(async () => {
    try {
      const token = getToken();
      const resp = await fetch(`/game/api/games/${_gsGameId}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!resp.ok) return;
      const updated = await resp.json();
      // If turn changed to me or game finished, re-render
      if (updated.current_turn_id === _gsMyId() || updated.status === "finished") {
        clearInterval(_gsWaitTimer);
        _gsWaitTimer = null;
        _gsGame = updated;
        _gsRender();
      }
    } catch { /* silent */ }
  }, 3000);
}

// ──────────────────────────────────────────────
// Sub-Screen: Finished (opened from home)
// ──────────────────────────────────────────────
export function _gsRenderFinished(game) {
  const c = GS.content();
  c.innerHTML = "";

  const me = _gsMyId();
  const won = game.winner_id === me;
  const opp = _gsOpponent(game);

  c.appendChild(_gsBackBtn());
  c.appendChild(_gsSkateBar(game));

  const wrap = _gs("div", "gs-result-wrap");

  const icon = _gs("div", "gs-result-icon");
  icon.textContent = won ? "\u2713" : "\u2717";
  icon.classList.add(won ? "gs-result-success" : "gs-result-fail");
  wrap.appendChild(icon);

  wrap.appendChild(_gs("div", "gs-result-title", won ? "Gewonnen!" : "Verloren"));
  wrap.appendChild(_gs("div", "gs-result-text", `gegen @${opp.username}`));

  const okBtn = _gs("button", "gs-ok-btn accent-btn", "OK");
  okBtn.addEventListener("click", () => closeGame());
  wrap.appendChild(okBtn);

  c.appendChild(wrap);
}

// ──────────────────────────────────────────────
// Detection feedback flash
// ──────────────────────────────────────────────
export function _gsShowDetectFlash(trick, confidence, ok) {
  const status = document.getElementById("gs-status");
  if (!status) return;

  const name = trick.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase());
  const pct  = (confidence * 100).toFixed(0);
  const cls  = ok ? "gs-detect-ok" : "gs-detect-fail";

  status.innerHTML = "";
  const flash = _gs("div", `gs-detect-flash ${cls}`);
  flash.appendChild(_gs("div", "gs-detect-trick", ok ? `✓ ${name}` : `✗ ${name}`));
  flash.appendChild(_gs("div", "gs-detect-conf", `${pct}% Konfidenz`));
  status.appendChild(flash);
}

// ──────────────────────────────────────────────
// Back button
// ──────────────────────────────────────────────
export function _gsBackBtn() {
  const btn = _gs("button", "gs-back-btn", "\u2190 Zur\u00fcck");
  btn.addEventListener("click", () => closeGame());
  return btn;
}
