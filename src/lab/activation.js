"use strict";

const $ = id => document.getElementById(id);

// ── Config (user-adjustable) ───────────────────
const cfg = {
  threshold:   15,   // m/s² magnitude to trigger
  preBufMs:   200,   // ms of pre-trigger samples to include
  postMs:    1400,   // ms to capture after trigger
  cooldownMs: 2000,  // ms before re-trigger allowed
};

// ── State ──────────────────────────────────────
const st = {
  sensorReady: false,
  phase: 'idle',    // idle | capturing | analyzing | cooldown
  rollingBuf: [],   // pre-buffer [{t, ax, ay, az, gx, gy, gz}]
  capture: [],
  postTimer: null,
  cooldownTimer: null,
};

// ── Sensor data ────────────────────────────────
function _onMotion(e) {
  const acc = e.accelerationIncludingGravity || e.acceleration || {};
  const gyr = e.rotationRate || {};

  const ax = acc.x ?? 0, ay = acc.y ?? 0, az = acc.z ?? 0;
  const gx = ((gyr.alpha ?? 0) * Math.PI) / 180;
  const gy = ((gyr.beta  ?? 0) * Math.PI) / 180;
  const gz = ((gyr.gamma ?? 0) * Math.PI) / 180;

  const mag = Math.sqrt(ax * ax + ay * ay + az * az);
  const now = Date.now();

  const sample = {
    t: now,
    ax: +ax.toFixed(4), ay: +ay.toFixed(4), az: +az.toFixed(4),
    gx: +gx.toFixed(4), gy: +gy.toFixed(4), gz: +gz.toFixed(4),
  };

  // Maintain rolling pre-buffer
  st.rollingBuf.push(sample);
  const cutoff = now - cfg.preBufMs - 150;
  while (st.rollingBuf.length > 0 && st.rollingBuf[0].t < cutoff) {
    st.rollingBuf.shift();
  }

  if (st.phase === 'capturing') {
    st.capture.push(sample);
  }

  if (st.phase === 'idle' && mag > cfg.threshold) {
    _trigger(now);
  }

  _updateMeter(mag);
}

// ── Activation logic ───────────────────────────
function _trigger(now) {
  st.phase = 'capturing';
  const cutoff = now - cfg.preBufMs;
  const pre = st.rollingBuf.filter(s => s.t >= cutoff);
  st.capture = [...pre];
  _setPhaseUI('capturing');

  clearTimeout(st.postTimer);
  st.postTimer = setTimeout(_finishCapture, cfg.postMs);
}

async function _finishCapture() {
  const raw = st.capture.slice();
  st.capture = [];
  _setPhaseUI('analyzing');

  if (raw.length < 5) {
    _startCooldown();
    return;
  }

  // Normalize t to start at 0
  const t0 = raw[0].t;
  const samples = raw.map(s => ({ ...s, t: s.t - t0 }));

  try {
    const resp = await fetch('/api/predict', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ samples }),
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const result = await resp.json();
    _addResult(result, samples);
  } catch (err) {
    _addError(err.message);
  }

  _startCooldown();
}

function _startCooldown() {
  st.phase = 'cooldown';
  _setPhaseUI('cooldown');
  clearTimeout(st.cooldownTimer);
  st.cooldownTimer = setTimeout(() => {
    st.phase = 'idle';
    _setPhaseUI('idle');
  }, cfg.cooldownMs);
}

// ── UI helpers ─────────────────────────────────
function _updateMeter(mag) {
  const fill    = $('act-meter-fill');
  const val     = $('act-meter-val');
  const pct     = Math.min((mag / 50) * 100, 100);
  if (fill) fill.style.width = pct + '%';
  if (val)  val.textContent  = mag.toFixed(1);
}

function _setPhaseUI(phase) {
  const el = $('act-status');
  if (!el) return;
  const labels = {
    idle:      'Listening…',
    capturing: 'Capturing!',
    analyzing: 'Analyzing…',
    cooldown:  'Cooldown…',
  };
  el.textContent  = labels[phase] ?? phase;
  el.dataset.phase = phase;
}

function _esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function _confClass(c) {
  if (c >= 0.80) return 'high';
  if (c >= 0.55) return 'mid';
  return 'low';
}

function _addResult(result, samples) {
  const feed = $('act-feed');
  if (!feed) return;

  const probs = Object.entries(result.probabilities).sort((a, b) => b[1] - a[1]);
  const top3  = probs.slice(0, 3);
  const durationMs = samples[samples.length - 1]?.t ?? 0;

  const card = document.createElement('div');
  card.className = 'act-card';
  card.innerHTML = `
    <div class="act-card-header">
      <span class="act-card-trick">${_esc(result.trick)}</span>
      <span class="act-card-conf act-conf-${_confClass(result.confidence)}">${(result.confidence * 100).toFixed(0)}%</span>
    </div>
    <div class="act-card-bars">
      ${top3.map(([name, prob]) => `
        <div class="act-bar-row">
          <span class="act-bar-label${name === result.trick ? ' act-bar-top' : ''}">${_esc(name)}</span>
          <div class="act-bar-track">
            <div class="act-bar-fill${name === result.trick ? ' act-bar-fill-top' : ''}" style="width:${(prob * 100).toFixed(0)}%"></div>
          </div>
          <span class="act-bar-pct">${(prob * 100).toFixed(0)}%</span>
        </div>
      `).join('')}
    </div>
    <div class="act-card-meta">${samples.length} Samples · ${durationMs.toFixed(0)} ms</div>
  `;
  feed.insertBefore(card, feed.firstChild);
  while (feed.children.length > 30) feed.removeChild(feed.lastChild);
}

function _addError(msg) {
  const feed = $('act-feed');
  if (!feed) return;
  const el = document.createElement('div');
  el.className = 'act-card act-card-error';
  el.textContent = 'Fehler: ' + msg;
  feed.insertBefore(el, feed.firstChild);
}

// ── Sensor init ────────────────────────────────
function _attachMotion() {
  window.addEventListener('devicemotion', _onMotion);
  st.sensorReady = true;
  $('act-permission-banner')?.classList.add('hidden');
  _setPhaseUI('idle');
}

async function _requestPermission() {
  if (typeof DeviceMotionEvent !== 'undefined' &&
      typeof DeviceMotionEvent.requestPermission === 'function') {
    try {
      const r = await DeviceMotionEvent.requestPermission();
      if (r === 'granted') _attachMotion();
    } catch (_) {}
  } else {
    _attachMotion();
  }
}

function _initSensors() {
  if (typeof DeviceMotionEvent === 'undefined') {
    _setPhaseUI('idle');
    $('act-status').textContent = 'Keine Sensoren auf diesem Gerät.';
    return;
  }
  if (typeof DeviceMotionEvent.requestPermission === 'function') {
    let probed = false;
    const probe = e => {
      const acc = e.accelerationIncludingGravity || e.acceleration || {};
      if (acc.x != null && acc.x !== 0) {
        probed = true;
        window.removeEventListener('devicemotion', probe);
        _attachMotion();
      }
    };
    window.addEventListener('devicemotion', probe);
    setTimeout(() => {
      if (!probed) {
        window.removeEventListener('devicemotion', probe);
        $('act-permission-banner')?.classList.remove('hidden');
        $('act-status').textContent = '"Sensoren aktivieren" tippen.';
      }
    }, 1000);
  } else {
    _attachMotion();
  }
}

// ── Controls ───────────────────────────────────
function _initControls() {
  function bindSlider(sliderId, valId, cfgKey, onUpdate) {
    const slider = $(sliderId);
    const display = $(valId);
    if (!slider) return;
    slider.value = cfg[cfgKey];
    if (display) display.textContent = cfg[cfgKey];
    slider.addEventListener('input', () => {
      cfg[cfgKey] = +slider.value;
      if (display) display.textContent = slider.value;
      if (onUpdate) onUpdate(+slider.value);
    });
    if (onUpdate) onUpdate(cfg[cfgKey]);
  }

  bindSlider('act-threshold', 'act-threshold-val', 'threshold', val => {
    const marker = $('act-meter-marker');
    if (marker) marker.style.left = Math.min((val / 50) * 100, 100) + '%';
  });
  bindSlider('act-prebuf',   'act-prebuf-val',   'preBufMs');
  bindSlider('act-postwin',  'act-postwin-val',  'postMs');
  bindSlider('act-cooldown', 'act-cooldown-val', 'cooldownMs');
}

// ── Bootstrap ──────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  _initControls();
  _initSensors();
  $('act-request-perm-btn')?.addEventListener('click', _requestPermission);
  $('act-clear-btn')?.addEventListener('click', () => {
    const feed = $('act-feed');
    if (feed) feed.innerHTML = '';
  });
});
