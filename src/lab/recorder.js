"use strict";

import { computeOrientations, getQAtTime, drawPhone3D } from "../shared/phone-animation.js";

// ─── State ─────────────────────────────────────
export let TRICKS = [];
export let references = {};

export const state = {
  selectedTrick: null,
  isRecording: false,
  samples: [],
  recordingStart: null,
  timerInterval: null,
  sensorReady: false,
  pendingRecording: null,
};

// ─── DOM ───────────────────────────────────────
export const $ = id => document.getElementById(id);

// ─── Auth ──────────────────────────────────────
export function getToken() { return localStorage.getItem('fp_game_token') || ''; }

// ─── Tricks ────────────────────────────────────
export async function loadTricks() {
  try {
    const r = await fetch('/game/api/tricks');
    if (r.ok) TRICKS = (await r.json()).map(t => t.name);
  } catch (_) {}
  if (!TRICKS.length) {
    TRICKS = ['Kickflip','Heelflip','FS Shuvit','FS 360 Shuvit',
              'BS Shuvit','BS 360 Shuvit','Treflip','Late Kickflip'];
  }
}

export function buildTrickGrid() {
  const grid = $('trick-grid');
  grid.innerHTML = '';
  TRICKS.forEach(trick => {
    const btn = document.createElement('button');
    btn.className = 'trick-btn' + (trick === state.selectedTrick ? ' selected' : '');
    btn.textContent = trick;
    btn.addEventListener('click', () => selectTrick(trick));
    grid.appendChild(btn);
  });
}

export function selectTrick(trick) {
  if (state.isRecording) return;
  state.selectedTrick = trick;
  window._selectedTrick = trick;
  $('selected-trick').textContent = trick;
  document.querySelectorAll('.trick-btn').forEach(b =>
    b.classList.toggle('selected', b.textContent === trick));
  showRefAnimation(trick);
}

// ─── Sensor ────────────────────────────────────
export let latestAcc = { x: 0, y: 0, z: 0 };
export let latestGyr = { x: 0, y: 0, z: 0 };

export function onMotion(e) {
  const acc = e.accelerationIncludingGravity || e.acceleration || {};
  const gyr = e.rotationRate || {};
  latestAcc = { x: acc.x ?? 0, y: acc.y ?? 0, z: acc.z ?? 0 };
  latestGyr = {
    x: ((gyr.alpha ?? 0) * Math.PI) / 180,
    y: ((gyr.beta  ?? 0) * Math.PI) / 180,
    z: ((gyr.gamma ?? 0) * Math.PI) / 180,
  };
  if (state.isRecording) {
    const t = Date.now() - state.recordingStart;
    state.samples.push({
      t,
      ax: +latestAcc.x.toFixed(4), ay: +latestAcc.y.toFixed(4), az: +latestAcc.z.toFixed(4),
      gx: +latestGyr.x.toFixed(4), gy: +latestGyr.y.toFixed(4), gz: +latestGyr.z.toFixed(4),
    });
  }
}

export function attachMotionListener() {
  let gotData = false;
  let timeout = null;
  function wrapped(e) {
    const acc = e.accelerationIncludingGravity || e.acceleration || {};
    if (!gotData && (acc.x || acc.y || acc.z)) {
      gotData = true;
      clearTimeout(timeout);
      state.sensorReady = true;
      $('status-msg').textContent = 'Sensor active – select a trick and record!';
    }
    onMotion(e);
  }
  window.addEventListener('devicemotion', wrapped);
  $('perm-banner').classList.add('hidden');
  timeout = setTimeout(() => {
    if (!gotData) {
      $('status-msg').textContent = window.location.protocol === 'http:' &&
        window.location.hostname !== 'localhost' && window.location.hostname !== '127.0.0.1'
        ? 'Sensors require HTTPS!'
        : 'Sensors not responding. Try shaking the device.';
    }
  }, 1500);
  state.sensorReady = true;
}

export async function requestPermission() {
  if (typeof DeviceMotionEvent !== 'undefined' &&
      typeof DeviceMotionEvent.requestPermission === 'function') {
    try {
      if (await DeviceMotionEvent.requestPermission() === 'granted') {
        attachMotionListener();
      } else {
        showToast('Permission denied.');
      }
    } catch (e) { showToast('Permission error: ' + e.message); }
  } else {
    attachMotionListener();
  }
}

export function initSensors() {
  if (typeof DeviceMotionEvent === 'undefined') {
    $('status-msg').textContent = 'No motion sensors on this device.';
    $('sensor-hint').classList.remove('hidden');
    return;
  }
  if (typeof DeviceMotionEvent.requestPermission === 'function') {
    let granted = false;
    function probe(e) {
      const acc = e.accelerationIncludingGravity || e.acceleration || {};
      if (acc.x || acc.y || acc.z) {
        granted = true;
        window.removeEventListener('devicemotion', probe);
        attachMotionListener();
      }
    }
    window.addEventListener('devicemotion', probe);
    setTimeout(() => {
      if (!granted) {
        window.removeEventListener('devicemotion', probe);
        $('perm-banner').classList.remove('hidden');
        $('status-msg').textContent = 'Tap "Enable Sensors" to start.';
      }
    }, 1000);
  } else {
    attachMotionListener();
  }
}

// ─── Recording ─────────────────────────────────
export function startRecording() {
  if (!state.selectedTrick) { showToast('Select a trick first!'); return; }
  if (!state.sensorReady)   { showToast('Enable sensors first!'); return; }
  state.isRecording = true;
  state.samples = [];
  state.recordingStart = Date.now();
  const btn = $('record-btn');
  btn.classList.add('recording');
  btn.querySelector('.btn-label').textContent = 'Stop';
  btn.querySelector('.btn-icon').textContent = '⏹';
  $('timer-display').classList.add('recording');
  $('status-msg').textContent = 'Recording…';
  state.timerInterval = setInterval(updateTimer, 100);
}

export function stopRecording() {
  state.isRecording = false;
  clearInterval(state.timerInterval);
  const durationMs = Date.now() - state.recordingStart;
  const btn = $('record-btn');
  btn.classList.remove('recording');
  btn.querySelector('.btn-label').textContent = 'Record';
  btn.querySelector('.btn-icon').textContent = '⏺';
  $('timer-display').classList.remove('recording');
  $('timer-display').textContent = '0:00.0';

  if (state.samples.length < 5) {
    showToast('Too few samples – try again!');
    $('status-msg').textContent = 'Ready – select a trick and record!';
    return;
  }

  const sampleRateHz = Math.round((state.samples.length / durationMs) * 1000);
  state.pendingRecording = {
    id: crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36),
    trick: state.selectedTrick,
    timestamp: new Date(state.recordingStart).toISOString(),
    durationMs: Math.round(durationMs),
    sampleCount: state.samples.length,
    sampleRateHz,
    samples: state.samples.slice(),
  };
  openReview(state.pendingRecording);
}

export function updateTimer() {
  const e = Date.now() - state.recordingStart;
  const t = Math.floor((e % 1000) / 100);
  const s = Math.floor(e / 1000) % 60;
  const m = Math.floor(e / 60000);
  $('timer-display').textContent = `${m}:${String(s).padStart(2,'0')}.${t}`;
}

// ─── 3D Animation ──────────────────────────────
export const anim = { orientations:[], samples:[], playing:false, currentTime:0,
                totalTime:0, speed:0.5, rafId:null, lastFrame:null };

export function renderAnimFrame() {
  const canvas = $('anim-canvas');
  const ctx = canvas.getContext('2d');
  const W = canvas.clientWidth, H = canvas.clientHeight;
  canvas.width = W; canvas.height = H;
  ctx.clearRect(0, 0, W, H);
  if (anim.orientations.length < 2) return;
  drawPhone3D(ctx, W, H, getQAtTime(anim.samples, anim.orientations, anim.currentTime));
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

export function initAnim(samples) {
  anim.samples = samples;
  anim.orientations = computeOrientations(samples);
  anim.totalTime = samples.length > 0 ? samples[samples.length-1].t : 0;
  anim.currentTime = 0; anim.playing = false; anim.lastFrame = null;

  const scrubber = $('anim-scrubber');
  anim.speed = parseFloat($('anim-speed').value);
  renderAnimFrame();

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

export const refAnim = { orientations:[], samples:[], totalTime:0, currentTime:0,
                  rafId:null, lastFrame:null, active:false };

export function showRefAnimation(trick) {
  stopRefAnimation();
  const card = $('ref-card');
  const ref = references[trick];
  if (!ref || !ref.samples || ref.samples.length < 2) {
    card.classList.add('hidden');
    return;
  }
  $('ref-trick-label').textContent = trick;
  card.classList.remove('hidden');
  refAnim.samples = ref.samples;
  refAnim.orientations = computeOrientations(ref.samples);
  refAnim.totalTime = ref.samples[ref.samples.length - 1].t;
  refAnim.currentTime = 0;
  refAnim.active = true;
  refAnim.lastFrame = performance.now();
  refAnimLoop();
}

export function stopRefAnimation() {
  refAnim.active = false;
  if (refAnim.rafId) { cancelAnimationFrame(refAnim.rafId); refAnim.rafId = null; }
}

export function refAnimLoop() {
  if (!refAnim.active) return;
  const now = performance.now(), dt = now - refAnim.lastFrame;
  refAnim.lastFrame = now;
  refAnim.currentTime += dt * 0.5;
  if (refAnim.currentTime >= refAnim.totalTime) refAnim.currentTime = 0;
  const canvas = $('ref-canvas');
  const ctx = canvas.getContext('2d');
  const W = canvas.clientWidth, H = canvas.clientHeight;
  canvas.width = W; canvas.height = H;
  ctx.clearRect(0, 0, W, H);
  if (refAnim.orientations.length >= 2) {
    drawPhone3D(ctx, W, H, getQAtTime(refAnim.samples, refAnim.orientations, refAnim.currentTime));
  }
  refAnim.rafId = requestAnimationFrame(refAnimLoop);
}

// ─── Review sheet ──────────────────────────────
export function openReview(rec) {
  $('review-trick').textContent = rec.trick;
  $('review-meta').textContent =
    `${(rec.durationMs/1000).toFixed(2)}s · ${rec.sampleCount} samples · ${rec.sampleRateHz} Hz`;
  $('review-overlay').classList.remove('hidden');
  document.body.style.overflow = 'hidden';
  requestAnimationFrame(() => initAnim(rec.samples));
}

export function closeReview() {
  stopAnim();
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
  await loadTricks();
  await loadReferences();
  state.selectedTrick = TRICKS[0];
  buildTrickGrid();
  $('selected-trick').textContent = state.selectedTrick;
  showRefAnimation(state.selectedTrick);
  initSensors();

  $('record-btn').addEventListener('click', () =>
    state.isRecording ? stopRecording() : startRecording());
  $('perm-btn').addEventListener('click', requestPermission);
  $('btn-save').addEventListener('click', saveRecording);
  $('btn-discard').addEventListener('click', () => {
    showToast('Recording discarded.');
    closeReview();
  });
}

// Expose for cross-script use
window.loadReferences  = loadReferences;
window.showRefAnimation = showRefAnimation;

document.addEventListener('DOMContentLoaded', init);
