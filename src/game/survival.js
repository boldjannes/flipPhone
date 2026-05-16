"use strict";

import { GameRecorder } from "./game-recorder.js";
import { startCanvasAnim, stopCanvasAnim } from "../shared/phone-animation.js";

const SKATE     = "SKATE";
const THRESHOLD = 0.80;

let _tricks   = [];  // [{id, name}] from active model
let _refs     = {};  // {trick_name: {samples}}
let _recorder = null;
let _st       = null;

const SV = {
  overlay: () => document.getElementById("survival-screen"),
  content: () => document.getElementById("sv-content"),
};

function _el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

// ── Data loading ───────────────────────────────

async function _loadData() {
  const [activeR, allR, refR] = await Promise.all([
    fetch("/api/active-tricks").catch(() => null),
    fetch("/game/api/tricks").catch(() => null),
    fetch("/lab/api/references").catch(() => null),
  ]);
  if (activeR?.ok && allR?.ok) {
    const activeIds = new Set(await activeR.json());
    const all       = await allR.json();
    _tricks = all.filter(t => activeIds.has(t.id));
  }
  if (refR?.ok) _refs = await refR.json();
}

function _pickTrick(excludeId = null) {
  const pool = excludeId ? _tricks.filter(t => t.id !== excludeId) : _tricks;
  const src  = pool.length ? pool : _tricks;
  return src[Math.floor(Math.random() * src.length)];
}

// ── Public API ─────────────────────────────────

export async function openSurvival() {
  SV.overlay().classList.remove("hidden");
  SV.content().innerHTML = "";
  SV.content().appendChild(_el("div", "gs-loading", "Laden…"));
  await _loadData();
  if (!_tricks.length) {
    SV.overlay().classList.add("hidden");
    window.showToast?.("Kein aktives Modell — Survival nicht verfügbar.");
    return;
  }
  _showStart();
}

export function closeSurvival() {
  _stopAll();
  SV.overlay().classList.add("hidden");
}

function _stopAll() {
  if (_recorder) { _recorder.abort(); }
  const canvas = document.getElementById("sv-canvas");
  if (canvas) stopCanvasAnim(canvas);
}

// ── Screens ────────────────────────────────────

function _showStart() {
  const c = SV.content();
  c.innerHTML = "";

  const wrap = _el("div", "sv-center");
  wrap.appendChild(_el("div", "sv-title", "Survival"));
  wrap.appendChild(_el("div", "sv-desc",
    "Lande zufällige Tricks. Jeder Fehlversuch bringt einen Buchstaben. Bei SKATE ist das Spiel vorbei."));

  const skateRow = _el("div", "gs-skate-letters sv-skate-preview");
  for (const ch of SKATE) {
    const span = _el("span", "gs-skate-ch");
    span.textContent = ch;
    skateRow.appendChild(span);
  }
  wrap.appendChild(skateRow);

  const startBtn = _el("button", "gs-submit-btn accent-btn", "Starten");
  startBtn.addEventListener("click", _startGame);
  wrap.appendChild(startBtn);

  const closeBtn = _el("button", "gs-back-btn", "← Zurück");
  closeBtn.addEventListener("click", closeSurvival);
  wrap.appendChild(closeBtn);

  c.appendChild(wrap);
}

async function _startGame() {
  _st = { letters: 0, landed: 0, currentTrick: null };

  if (!_recorder) {
    _recorder = new GameRecorder({ confidenceThreshold: THRESHOLD });
    await _recorder.initSensors().catch(() => {});
  }

  _nextTrick();
}

function _nextTrick() {
  const prevId = _st.currentTrick?.id ?? null;
  _st.currentTrick = _pickTrick(prevId);
  _renderPlay();
}

function _renderPlay() {
  const c = SV.content();
  c.innerHTML = "";

  const { letters, landed, currentTrick } = _st;

  // Back
  const back = _el("button", "gs-back-btn", "← Beenden");
  back.addEventListener("click", closeSurvival);
  c.appendChild(back);

  // SKATE letters
  const skateRow = _el("div", "gs-skate-letters sv-skate-row");
  for (let i = 0; i < SKATE.length; i++) {
    const ch = _el("span", "gs-skate-ch" + (i < letters ? " gs-ch-active" : ""));
    ch.textContent = SKATE[i];
    skateRow.appendChild(ch);
  }
  c.appendChild(skateRow);

  // Score
  c.appendChild(_el("div", "sv-score", `${landed} gelandet`));

  // Trick prompt
  c.appendChild(_el("div", "sv-prompt", "Lande diesen Trick:"));
  c.appendChild(_el("div", "sv-trick-name", currentTrick.name));

  // Reference animation
  const ref = _refs[currentTrick.name];
  if (ref?.samples?.length > 1) {
    const wrap = _el("div", "gs-replay-canvas-wrap");
    const canvas = document.createElement("canvas");
    canvas.className = "gs-replay-canvas";
    canvas.id = "sv-canvas";
    wrap.appendChild(canvas);
    c.appendChild(wrap);
    startCanvasAnim(canvas, ref.samples);
  }

  // Record button
  const recordBtn = _el("button", "gs-record-btn", "Aufnehmen");
  recordBtn.id = "sv-record-btn";
  recordBtn.addEventListener("click", _toggleRecord);
  c.appendChild(recordBtn);

  // Status
  c.appendChild(_el("div", "sv-status", ""));

  // Sensor permission
  if (_recorder?.needsPermission) {
    const permBtn = _el("button", "gs-submit-btn", "Sensor freigeben");
    permBtn.addEventListener("click", async () => {
      await _recorder.requestPermission();
      permBtn.remove();
    });
    c.appendChild(permBtn);
  }
}

async function _toggleRecord() {
  const btn    = document.getElementById("sv-record-btn");
  const status = document.querySelector(".sv-status");
  if (!btn) return;

  const recording = btn.classList.contains("gs-btn-recording");

  if (!recording) {
    _recorder.startRecording();
    btn.textContent = "Stoppen & Erkennen";
    btn.classList.add("gs-btn-recording");
    if (status) status.textContent = "Aufnahme läuft — mach deinen Trick!";
  } else {
    btn.textContent = "Auswerten…";
    btn.disabled = true;
    btn.classList.remove("gs-btn-recording");
    if (status) status.textContent = "Analysiere…";

    try {
      const result  = await _recorder.stopAndPredict();
      const success = result.confidence >= THRESHOLD;
      if (success) _st.landed++;
      else         _st.letters++;
      _showFlash(success, result.trick, result.confidence);
    } catch (err) {
      if (status) status.textContent = "Fehler: " + err.message;
      btn.textContent = "Aufnehmen";
      btn.disabled = false;
    }
  }
}

function _showFlash(success, trick, confidence) {
  const c = SV.content();
  const canvas = document.getElementById("sv-canvas");
  if (canvas) stopCanvasAnim(canvas);
  c.innerHTML = "";

  const flash = _el("div", "sv-flash sv-flash-" + (success ? "success" : "fail"));
  flash.appendChild(_el("div", "sv-flash-icon", success ? "✓" : "✗"));
  flash.appendChild(_el("div", "sv-flash-trick", trick.replace(/_/g, " ")));
  flash.appendChild(_el("div", "sv-flash-conf", `${(confidence * 100).toFixed(0)}%`));

  const skateRow = _el("div", "gs-skate-letters sv-skate-row");
  for (let i = 0; i < SKATE.length; i++) {
    const ch = _el("span", "gs-skate-ch gs-ch-stamp" + (i < _st.letters ? " gs-ch-active" : ""));
    ch.textContent = SKATE[i];
    skateRow.appendChild(ch);
  }
  flash.appendChild(skateRow);
  c.appendChild(flash);

  setTimeout(() => {
    if (_st.letters >= SKATE.length) _submitAndShowGameOver();
    else _nextTrick();
  }, 1400);
}

async function _submitAndShowGameOver() {
  const c = SV.content();
  c.innerHTML = "";
  c.appendChild(_el("div", "gs-loading", "Speichern…"));

  let pr = null, gr = null, rank = null, isNewPR = false;
  try {
    const { getToken } = await import("./auth.js");
    const resp = await fetch("/game/api/survival/score", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${getToken()}` },
      body: JSON.stringify({ score: _st.landed }),
    });
    if (resp.ok) {
      const data = await resp.json();
      pr       = data.pr;
      gr       = data.gr;
      rank     = data.rank;
      isNewPR  = _st.landed >= pr;
    }
  } catch (_) {}

  _showGameOver(pr, gr, rank, isNewPR);
}

function _showGameOver(pr, gr, rank, isNewPR) {
  const c = SV.content();
  c.innerHTML = "";

  const wrap = _el("div", "sv-center");
  wrap.appendChild(_el("div", "sv-title", "Game Over"));

  const skateRow = _el("div", "gs-skate-letters sv-skate-preview");
  for (const ch of SKATE) {
    const span = _el("span", "gs-skate-ch gs-ch-active");
    span.textContent = ch;
    skateRow.appendChild(span);
  }
  wrap.appendChild(skateRow);

  // Score
  const scoreEl = _el("div", "sv-final-score",
    `${_st.landed} Trick${_st.landed !== 1 ? "s" : ""}`);
  if (isNewPR && _st.landed > 0) scoreEl.appendChild(_el("span", "sv-new-pr", " PR"));
  wrap.appendChild(scoreEl);

  // PR / GR row
  if (pr !== null || gr !== null) {
    const stats = _el("div", "sv-stats-row");
    if (pr !== null)  stats.appendChild(_svStat("PR", pr));
    if (gr !== null)  stats.appendChild(_svStat("GR", gr.score, gr.name));
    if (rank !== null) stats.appendChild(_svStat("Rang", `#${rank}`));
    wrap.appendChild(stats);
  }

  const again = _el("button", "gs-submit-btn accent-btn", "Nochmal");
  again.addEventListener("click", _startGame);
  wrap.appendChild(again);

  const back = _el("button", "gs-back-btn sv-back-gap", "← Zurück");
  back.addEventListener("click", closeSurvival);
  wrap.appendChild(back);

  c.appendChild(wrap);
}

function _svStat(label, value, sub) {
  const box = _el("div", "sv-stat-box");
  box.appendChild(_el("div", "sv-stat-val", String(value)));
  box.appendChild(_el("div", "sv-stat-label", label));
  if (sub) box.appendChild(_el("div", "sv-stat-sub", sub));
  return box;
}
