"use strict";

// ─── State ─────────────────────────────────────
let TRICKS = [];
let references = {};

const state = {
  selectedTrick: null,
  isRecording: false,
  samples: [],
  recordingStart: null,
  timerInterval: null,
  sensorReady: false,
  pendingRecording: null,
};

// ─── DOM ───────────────────────────────────────
const $ = id => document.getElementById(id);

// ─── Auth ──────────────────────────────────────
function getToken() { return localStorage.getItem('fp_game_token') || ''; }

// ─── Tricks ────────────────────────────────────
async function loadTricks() {
  try {
    const r = await fetch('/game/api/tricks');
    if (r.ok) TRICKS = (await r.json()).map(t => t.name);
  } catch (_) {}
  if (!TRICKS.length) {
    TRICKS = ['Kickflip','Heelflip','FS Shuvit','FS 360 Shuvit',
              'BS Shuvit','BS 360 Shuvit','Treflip','Late Kickflip'];
  }
}

function buildTrickGrid() {
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

function selectTrick(trick) {
  if (state.isRecording) return;
  state.selectedTrick = trick;
  $('selected-trick').textContent = trick;
  document.querySelectorAll('.trick-btn').forEach(b =>
    b.classList.toggle('selected', b.textContent === trick));
  showRefAnimation(trick);
}

// ─── Sensor ────────────────────────────────────
let latestAcc = { x: 0, y: 0, z: 0 };
let latestGyr = { x: 0, y: 0, z: 0 };

function onMotion(e) {
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

function attachMotionListener() {
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

async function requestPermission() {
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

function initSensors() {
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
function startRecording() {
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

function stopRecording() {
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

function updateTimer() {
  const e = Date.now() - state.recordingStart;
  const t = Math.floor((e % 1000) / 100);
  const s = Math.floor(e / 1000) % 60;
  const m = Math.floor(e / 60000);
  $('timer-display').textContent = `${m}:${String(s).padStart(2,'0')}.${t}`;
}

// ─── 3D Animation ──────────────────────────────
const anim = { orientations:[], samples:[], playing:false, currentTime:0,
                totalTime:0, speed:0.5, rafId:null, lastFrame:null };

function qMul(a,b) {
  return [a[0]*b[0]-a[1]*b[1]-a[2]*b[2]-a[3]*b[3],
          a[0]*b[1]+a[1]*b[0]+a[2]*b[3]-a[3]*b[2],
          a[0]*b[2]-a[1]*b[3]+a[2]*b[0]+a[3]*b[1],
          a[0]*b[3]+a[1]*b[2]-a[2]*b[1]+a[3]*b[0]];
}
function qNorm(q) {
  const l = Math.sqrt(q[0]*q[0]+q[1]*q[1]+q[2]*q[2]+q[3]*q[3]);
  return l < 1e-10 ? [1,0,0,0] : [q[0]/l,q[1]/l,q[2]/l,q[3]/l];
}
function qToMatrix(q) {
  const [w,x,y,z] = q;
  return [1-2*(y*y+z*z), 2*(x*y-z*w), 2*(x*z+y*w),
            2*(x*y+z*w), 1-2*(x*x+z*z), 2*(y*z-x*w),
            2*(x*z-y*w), 2*(y*z+x*w), 1-2*(x*x+y*y)];
}

function computeOrientations(samples) {
  const out = [[1,0,0,0]];
  for (let i = 1; i < samples.length; i++) {
    const dt = (samples[i].t - samples[i-1].t) / 1000;
    const {gx,gy,gz} = samples[i];
    const angle = Math.sqrt(gx*gx+gy*gy+gz*gz) * dt;
    let dq;
    if (angle < 1e-8) { dq = [1,0,0,0]; }
    else {
      const ha = angle/2, sinHa = Math.sin(ha), omega = angle/dt;
      dq = [Math.cos(ha), gx/omega*sinHa, gy/omega*sinHa, gz/omega*sinHa];
    }
    out.push(qNorm(qMul(out[i-1], dq)));
  }
  return out;
}

function project(p, m, cx, cy, scale, dist) {
  const rx = m[0]*p[0]+m[1]*p[1]+m[2]*p[2];
  const ry = m[3]*p[0]+m[4]*p[1]+m[5]*p[2];
  const rz = m[6]*p[0]+m[7]*p[1]+m[8]*p[2];
  const z  = dist + rz;
  const f  = dist / Math.max(z, 0.1);
  return [cx + rx*scale*f, cy - ry*scale*f, z];
}

function drawPhone(ctx, W, H, q) {
  const m = qToMatrix(q);
  const cx = W/2, cy = H/2, scale = Math.min(W,H)*0.28, dist = 4;
  const [pw,ph,pd] = [0.5, 1.0, 0.08];
  const [hw,hh,hd] = [pw/2, ph/2, pd/2];
  const corners = [
    [-hw,-hh,-hd],[hw,-hh,-hd],[hw,hh,-hd],[-hw,hh,-hd],
    [-hw,-hh, hd],[hw,-hh, hd],[hw,hh, hd],[-hw,hh, hd],
  ];
  const proj = corners.map(p => project(p, m, cx, cy, scale, dist));
  const faces = [
    {idx:[0,1,2,3], color:'#1a1a1a', screen:false},
    {idx:[4,5,6,7], color:'#2a2a2a', screen:true},
    {idx:[0,1,5,4], color:'#222',    screen:false},
    {idx:[2,3,7,6], color:'#222',    screen:false},
    {idx:[0,3,7,4], color:'#252525', screen:false},
    {idx:[1,2,6,5], color:'#252525', screen:false},
  ].map(f => {
    const ps = f.idx.map(i => proj[i]);
    const avgZ = ps.reduce((s,p) => s+p[2], 0) / ps.length;
    const cross = (ps[1][0]-ps[0][0])*(ps[3][1]-ps[0][1]) -
                  (ps[1][1]-ps[0][1])*(ps[3][0]-ps[0][0]);
    return {...f, ps, avgZ, cross};
  }).sort((a,b) => a.avgZ - b.avgZ);

  for (const f of faces) {
    ctx.beginPath();
    ctx.moveTo(f.ps[0][0], f.ps[0][1]);
    for (let i = 1; i < f.ps.length; i++) ctx.lineTo(f.ps[i][0], f.ps[i][1]);
    ctx.closePath();
    ctx.fillStyle = f.color; ctx.fill();
    ctx.strokeStyle = '#444'; ctx.lineWidth = 1; ctx.stroke();
    if (f.screen && f.cross < 0) {
      const inset = 0.07;
      const sc = [[-hw+inset*pw,-hh+inset*ph,hd+.001],[hw-inset*pw,-hh+inset*ph,hd+.001],
                  [hw-inset*pw, hh-inset*ph,hd+.001],[-hw+inset*pw, hh-inset*ph,hd+.001]];
      const sp = sc.map(p => project(p, m, cx, cy, scale, dist));
      ctx.beginPath(); ctx.moveTo(sp[0][0],sp[0][1]);
      for (let i=1;i<sp.length;i++) ctx.lineTo(sp[i][0],sp[i][1]);
      ctx.closePath(); ctx.fillStyle='#003344'; ctx.fill();
      const ny = -hh+inset*ph*1.5;
      const np = [[-0.04,ny,hd+.002],[0.04,ny,hd+.002]].map(p => project(p,m,cx,cy,scale,dist));
      ctx.beginPath();
      ctx.arc((np[0][0]+np[1][0])/2,(np[0][1]+np[1][1])/2, 3, 0, Math.PI*2);
      ctx.fillStyle='#001a22'; ctx.fill();
    }
  }
}

function getQAtTime(samples, orientations, time) {
  let idx = 0;
  for (let i=0; i<samples.length-1; i++) { if (samples[i+1].t >= time) { idx=i; break; } idx=i; }
  const t0=samples[idx].t, t1=idx+1<samples.length?samples[idx+1].t:t0;
  const frac = t1>t0 ? (time-t0)/(t1-t0) : 0;
  const q0=orientations[idx], q1=idx+1<orientations.length?orientations[idx+1]:q0;
  const sign = q0[0]*q1[0]+q0[1]*q1[1]+q0[2]*q1[2]+q0[3]*q1[3] < 0 ? -1 : 1;
  return qNorm([q0[0]+(sign*q1[0]-q0[0])*frac, q0[1]+(sign*q1[1]-q0[1])*frac,
                q0[2]+(sign*q1[2]-q0[2])*frac, q0[3]+(sign*q1[3]-q0[3])*frac]);
}

function renderAnimFrame() {
  const canvas = $('anim-canvas');
  const ctx = canvas.getContext('2d');
  const W = canvas.clientWidth, H = canvas.clientHeight;
  canvas.width = W; canvas.height = H;
  ctx.clearRect(0, 0, W, H);
  if (anim.orientations.length < 2) return;
  drawPhone(ctx, W, H, getQAtTime(anim.samples, anim.orientations, anim.currentTime));
}

function animLoop() {
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

function startAnim() {
  if (anim.currentTime >= anim.totalTime) anim.currentTime = 0;
  anim.playing = true; anim.lastFrame = performance.now();
  $('anim-play').textContent = '⏸'; animLoop();
}

function stopAnim() {
  anim.playing = false; $('anim-play').textContent = '▶';
  if (anim.rafId) { cancelAnimationFrame(anim.rafId); anim.rafId = null; }
}

function initAnim(samples) {
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
async function loadReferences() {
  try {
    const r = await fetch('/lab/api/references', {
      headers: { Authorization: 'Bearer ' + getToken() },
    });
    if (r.ok) references = await r.json();
  } catch (_) {}
}

const refAnim = { orientations:[], samples:[], totalTime:0, currentTime:0,
                  rafId:null, lastFrame:null, active:false };

function showRefAnimation(trick) {
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

function stopRefAnimation() {
  refAnim.active = false;
  if (refAnim.rafId) { cancelAnimationFrame(refAnim.rafId); refAnim.rafId = null; }
}

function refAnimLoop() {
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
    drawPhone(ctx, W, H, getQAtTime(refAnim.samples, refAnim.orientations, refAnim.currentTime));
  }
  refAnim.rafId = requestAnimationFrame(refAnimLoop);
}

// ─── Review sheet ──────────────────────────────
function openReview(rec) {
  $('review-trick').textContent = rec.trick;
  $('review-meta').textContent =
    `${(rec.durationMs/1000).toFixed(2)}s · ${rec.sampleCount} samples · ${rec.sampleRateHz} Hz`;
  $('review-overlay').classList.remove('hidden');
  document.body.style.overflow = 'hidden';
  requestAnimationFrame(() => initAnim(rec.samples));
}

function closeReview() {
  stopAnim();
  $('review-overlay').classList.add('hidden');
  document.body.style.overflow = '';
  state.pendingRecording = null;
  $('status-msg').textContent = 'Ready – select a trick and record!';
}

// ─── Save ──────────────────────────────────────
async function saveRecording() {
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
let toastTimer = null;
function showToast(msg) {
  const t = $('toast');
  t.textContent = msg; t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2500);
}

// ─── Init ──────────────────────────────────────
async function init() {
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

document.addEventListener('DOMContentLoaded', init);
