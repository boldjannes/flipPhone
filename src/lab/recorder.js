"use strict";

import { computeOrientations, getQAtTime, computeHeightFactors, getHeightAtTime, createPhoneScene, startCanvasAnim, stopCanvasAnim } from "../shared/phone-animation.js";
import { SensorKit } from "../shared/sensor.js";
import { fetchSettings } from "../shared/settings.js";

// ─── State ─────────────────────────────────────
export let TRICKS = [];
export let references = {};
export let recordingCounts = {};

export const state = {
  selectedTrick:    null,
  sensorReady:      false,
  pendingRecording: null,
  activationThreshold: 15,
};

// ─── DOM ───────────────────────────────────────
export const $ = id => document.getElementById(id);

// ─── Auth ──────────────────────────────────────
export function getToken() { return localStorage.getItem('fp_game_token') || ''; }

// ─── Tricks ────────────────────────────────────
export async function loadTricks() {
  try {
    const r = await fetch('/game/api/tricks');
    if (r.ok) {
      const all = await r.json();
      TRICKS = all.map(t => t.name);
    }
  } catch (_) {}

  if (!TRICKS.length) {
    TRICKS = ['Kickflip','Heelflip','FS Shuvit','FS 360 Shuvit',
              'BS Shuvit','BS 360 Shuvit','Treflip','Late Kickflip'];
  }
}

export async function loadRecordingCounts() {
  try {
    const r = await fetch('/lab/api/recordings/counts');
    if (r.ok) recordingCounts = await r.json();
  } catch (_) {}
}

export function buildTrickGrid() {
  const grid = $('trick-grid');
  grid.innerHTML = '';
  TRICKS.forEach(trick => {
    const btn = document.createElement('button');
    btn.className = 'trick-btn' + (trick === state.selectedTrick ? ' selected' : '');
    btn.dataset.trick = trick;
    const count = recordingCounts[trick] || 0;
    btn.innerHTML = `<span class="trick-btn-name">${trick}</span><span class="trick-btn-count">${count > 0 ? count : '–'}</span>`;
    btn.addEventListener('click', () => selectTrick(trick));
    grid.appendChild(btn);
  });
}

export function selectTrick(trick) {
  state.selectedTrick = trick;
  window._selectedTrick = trick;
  $('selected-trick').textContent = trick;
  document.querySelectorAll('.trick-btn').forEach(b =>
    b.classList.toggle('selected', b.dataset.trick === trick));
  showRefAnimation(trick);
  if (state.sensorReady) _startActivation();
}

// ─── Sensor + Activation ───────────────────────
export function initSensors() {
  SensorKit.init({
    onReady: () => {
      state.sensorReady = true;
      $('perm-banner').classList.add('hidden');
      _setStatus('Trick wählen und Handy werfen!');
      if (state.selectedTrick) _startActivation();
    },
    onPermissionNeeded: () => {
      $('perm-banner').classList.remove('hidden');
      _setStatus('"Sensoren aktivieren" tippen.');
    },
    onError: (reason) => {
      _setStatus(reason);
      $('sensor-hint').classList.remove('hidden');
    },
  });
}

export async function requestPermission() {
  try {
    await SensorKit.requestPermission();
    state.sensorReady = true;
    $('perm-banner').classList.add('hidden');
    _setStatus('Trick wählen und Handy werfen!');
    if (state.selectedTrick) _startActivation();
  } catch (e) {
    showToast('Permission denied.');
  }
}

function _startActivation() {
  SensorKit.activate(
    { threshold: state.activationThreshold, preBufMs: 200, postMs: 1400, cooldownMs: 1800 },
    {
      onCapture: (samples) => {
        if (!state.selectedTrick) return;
        const now = Date.now();
        const durationMs = samples[samples.length - 1].t;
        const sampleRateHz = Math.round((samples.length / durationMs) * 1000);
        state.pendingRecording = {
          id:          crypto.randomUUID ? crypto.randomUUID() : now.toString(36),
          trick:       state.selectedTrick,
          timestamp:   new Date(now - durationMs).toISOString(),
          durationMs:  Math.round(durationMs),
          sampleCount: samples.length,
          sampleRateHz,
          samples,
        };
        openReview(state.pendingRecording);
      },
      onPhase: (phase) => {
        const labels = { idle: 'Listening…', capturing: 'Aufnahme!', cooldown: 'Cooldown…' };
        _setStatus(labels[phase] ?? phase);
        const badge = $('act-phase-badge');
        if (badge) { badge.textContent = labels[phase] ?? phase; badge.dataset.phase = phase; }
      },
      onMag: (mag) => {
        const fill = $('act-meter-fill');
        const val  = $('act-meter-val');
        if (fill) fill.style.width = Math.min((mag / 50) * 100, 100) + '%';
        if (val)  val.textContent  = mag.toFixed(1);
      },
    },
  );
}

function _setStatus(msg) {
  const el = $('status-msg');
  if (el) el.textContent = msg;
}

// ─── 3D Animation ──────────────────────────────
export const anim = { orientations:[], heightFactors:[], samples:[], playing:false, currentTime:0,
                totalTime:0, speed:0.5, rafId:null, lastFrame:null, scene:null };

export function renderAnimFrame() {
  if (!anim.scene || anim.orientations.length < 2) return;
  const q = getQAtTime(anim.samples, anim.orientations, anim.currentTime);
  const h = getHeightAtTime(anim.samples, anim.heightFactors, anim.currentTime);
  anim.scene.render(q, h);
}

export function animLoop() {
  if (!anim.playing) return;
  const now = performance.now(), dt = now - anim.lastFrame;
  anim.lastFrame = now;
  anim.currentTime += dt * anim.speed;
  if (anim.currentTime >= anim.totalTime) {
    anim.currentTime = anim.totalTime;
    renderAnimFrame();
    stopAnim(); return;
  }
  $('anim-scrubber').value = (anim.currentTime / anim.totalTime) * 100;
  $('anim-time').textContent = (anim.currentTime / 1000).toFixed(2) + 's';
  renderAnimFrame();
  anim.rafId = requestAnimationFrame(animLoop);
}

export function startAnim() {
  if (anim.currentTime >= anim.totalTime) anim.currentTime = 0;
  anim.playing = true; anim.lastFrame = performance.now();
  $('anim-play').textContent = '⏸'; animLoop();
}

export function stopAnim() {
  anim.playing = false; $('anim-play').textContent = '▶';
  if (anim.rafId) { cancelAnimationFrame(anim.rafId); anim.rafId = null; }
}

export async function initAnim(samples) {
  if (anim.scene) { anim.scene.dispose(); anim.scene = null; }
  anim.samples = samples;
  anim.orientations = computeOrientations(samples);
  anim.heightFactors = computeHeightFactors(samples);
  anim.totalTime = samples.length > 0 ? samples[samples.length-1].t : 0;
  anim.currentTime = 0; anim.playing = false; anim.lastFrame = null;

  anim.scene = await createPhoneScene($('anim-canvas'));
  anim.speed = parseFloat($('anim-speed').value);
  renderAnimFrame();

  const scrubber = $('anim-scrubber');
  $('anim-play').onclick = () => anim.playing ? stopAnim() : startAnim();
  scrubber.oninput = () => {
    anim.currentTime = (parseFloat(scrubber.value) / 100) * anim.totalTime;
    $('anim-time').textContent = (anim.currentTime / 1000).toFixed(2) + 's';
    if (!anim.playing) renderAnimFrame();
  };
  $('anim-speed').onchange = () => { anim.speed = parseFloat($('anim-speed').value); };
}

// ─── References ────────────────────────────────
export async function loadReferences() {
  try {
    const r = await fetch('/lab/api/references', {
      headers: { Authorization: 'Bearer ' + getToken() },
    });
    if (r.ok) references = await r.json();
  } catch (_) {}
}

export async function showRefAnimation(trick) {
  stopRefAnimation();
  const card = $('ref-card');
  const ref = references[trick];
  if (!ref || !ref.samples || ref.samples.length < 2) {
    card.classList.add('hidden');
    return;
  }
  $('ref-trick-label').textContent = trick;
  card.classList.remove('hidden');
  await startCanvasAnim($('ref-canvas'), ref.samples);
}

export function stopRefAnimation() {
  stopCanvasAnim($('ref-canvas'));
}

// ─── Review sheet ──────────────────────────────
export function openReview(rec) {
  $('review-trick').textContent = rec.trick;
  $('review-meta').textContent =
    `${(rec.durationMs/1000).toFixed(2)}s · ${rec.sampleCount} samples · ${rec.sampleRateHz} Hz`;
  $('review-overlay').classList.remove('hidden');
  document.body.style.overflow = 'hidden';
  initAnim(rec.samples);
}

export function closeReview() {
  stopAnim();
  if (anim.scene) { anim.scene.dispose(); anim.scene = null; }
  $('review-overlay').classList.add('hidden');
  document.body.style.overflow = '';
  state.pendingRecording = null;
  $('status-msg').textContent = 'Ready – select a trick and record!';
}

// ─── Save ──────────────────────────────────────
export async function saveRecording() {
  const rec = state.pendingRecording;
  if (!rec) { closeReview(); return; }
  const btn = $('btn-save');
  btn.disabled = true; btn.textContent = 'Saving…';
  try {
    const r = await fetch('/lab/api/recordings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + getToken() },
      body: JSON.stringify(rec),
    });
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      throw new Error(err.error || `HTTP ${r.status}`);
    }
    showToast('Recording saved!');
    await loadRecordingCounts();
    buildTrickGrid();
    selectTrick(state.pendingRecording?.trick || state.selectedTrick);
  } catch (e) {
    showToast('Save failed: ' + e.message);
  } finally {
    btn.disabled = false; btn.textContent = 'Save';
    closeReview();
  }
}

// ─── Toast ─────────────────────────────────────
export let toastTimer = null;
export function showToast(msg) {
  const t = $('toast');
  t.textContent = msg; t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2500);
}

// ─── Init ──────────────────────────────────────
export async function init() {
  const [settings] = await Promise.all([
    fetchSettings(),
    loadTricks(), loadReferences(), loadRecordingCounts(),
  ]);
  state.activationThreshold = settings.activation_threshold ?? 15;

  state.selectedTrick = TRICKS[0];
  buildTrickGrid();
  $('selected-trick').textContent = state.selectedTrick;
  showRefAnimation(state.selectedTrick);
  initSensors();

  // Threshold slider
  const slider = $('act-threshold');
  const sliderVal = $('act-threshold-val');
  if (slider) {
    slider.value = state.activationThreshold;
    if (sliderVal) sliderVal.textContent = state.activationThreshold;
    slider.addEventListener('input', () => {
      state.activationThreshold = +slider.value;
      if (sliderVal) sliderVal.textContent = slider.value;
      const marker = $('act-meter-marker');
      if (marker) marker.style.left = Math.min((+slider.value / 50) * 100, 100) + '%';
      if (state.sensorReady && state.selectedTrick) _startActivation();
    });
    // Initial marker
    const marker = $('act-meter-marker');
    if (marker) marker.style.left = Math.min((state.activationThreshold / 50) * 100, 100) + '%';
  }

  $('perm-btn').addEventListener('click', requestPermission);
  $('btn-save').addEventListener('click', saveRecording);
  $('btn-discard').addEventListener('click', () => {
    showToast('Recording verworfen.');
    closeReview();
  });
}

// Expose for cross-script use
window.loadReferences  = loadReferences;
window.showRefAnimation = showRefAnimation;

document.addEventListener('DOMContentLoaded', init);
