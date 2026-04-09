/**
 * FlipPhone – Sensor Data Collection App
 *
 * Data format sent per recording (ML-ready):
 * {
 *   id: string,          // UUID
 *   trick: string,       // trick name
 *   timestamp: string,   // ISO-8601 recording start time
 *   durationMs: number,  // total duration in milliseconds
 *   sampleCount: number,
 *   sampleRateHz: number, // approximate sample rate
 *   samples: [
 *     { t: number, ax: number, ay: number, az: number,  // accelerometer (m/s²)
 *                  gx: number, gy: number, gz: number }  // gyroscope (rad/s)
 *   ]
 * }
 *
 * Server responses additionally include:
 *   collector: string  // name associated with the API key
 */

"use strict";

// ──────────────────────────────────────────────
// Constants & State
// ──────────────────────────────────────────────
const TRICKS = [
  "Kickflip",
  "Heelflip",
  "FS Shuvit",
  "FS 360 Shuvit",
  "BS Shuvit",
  "BS 360 Shuvit",
  "Treflip",
  "Late Kickflip",
];

const CONFIG_KEY = "flipphone_config";

const state = {
  selectedTrick: TRICKS[0],
  isRecording: false,
  samples: [],
  recordingStart: null,
  timerInterval: null,
  sensorAvailable: false,
  sensorPermissionGranted: false,
  pendingRecording: null, // filled when review sheet opens
  isAdmin: false,
  references: {},         // trick -> recording data (loaded from server)
  datasetCache: null,     // cached recordings for re-rendering without refetch
  filterTrick: "",        // admin filter: trick name or "" for all
  filterCollector: "",    // admin filter: collector name or "" for all
};

// ──────────────────────────────────────────────
// DOM refs
// ──────────────────────────────────────────────
const $ = (id) => document.getElementById(id);

const recordBtn = $("record-btn");
const timerDisplay = $("timer-display");
const statusMsg = $("status-msg");
const permissionBanner = $("permission-banner");
const requestPermBtn = $("request-permission-btn");
const reviewOverlay = $("review-overlay");
const reviewTrickName = $("review-trick-name");
const reviewDuration = $("review-duration");
const reviewSamples = $("review-samples");
const reviewSampleRate = $("review-sample-rate");
const btnSave = $("btn-save");
const btnDiscard = $("btn-discard");
const datasetList = $("dataset-list");
const datasetCount = $("dataset-count");
const toast = $("toast");

// Sensor value elements
const sensorEls = {
  ax: $("s-ax"),
  ay: $("s-ay"),
  az: $("s-az"),
  gx: $("s-gx"),
  gy: $("s-gy"),
  gz: $("s-gz"),
};

// ──────────────────────────────────────────────
// Configuration (server URL + API key stored in localStorage)
// ──────────────────────────────────────────────
function getConfig() {
  try {
    return JSON.parse(localStorage.getItem(CONFIG_KEY)) || {};
  } catch (_) {
    return {};
  }
}

function setConfig(cfg) {
  localStorage.setItem(CONFIG_KEY, JSON.stringify(cfg));
}

function isConfigured() {
  const cfg = getConfig();
  return !!(cfg.serverUrl && cfg.apiKey);
}

// ──────────────────────────────────────────────
// Server API client
// ──────────────────────────────────────────────
async function apiFetch(path, options = {}) {
  const cfg = getConfig();
  const base = (cfg.serverUrl || "").replace(/\/$/, "");
  const headers = {
    "Content-Type": "application/json",
    "X-API-Key": cfg.apiKey || "",
    ...(options.headers || {}),
  };
  return fetch(base + path, { ...options, headers });
}

async function apiSaveRecording(rec) {
  const resp = await apiFetch("/lab/api/recordings", {
    method: "POST",
    body: JSON.stringify(rec),
  });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    throw new Error(err.error || `Server error ${resp.status}`);
  }
  return resp.json();
}

async function apiLoadRecordings() {
  const resp = await apiFetch("/lab/api/recordings");
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    throw new Error(err.error || `Server error ${resp.status}`);
  }
  return resp.json();
}

async function apiDeleteRecording(id) {
  const resp = await apiFetch(`/lab/api/recordings/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    throw new Error(err.error || `Server error ${resp.status}`);
  }
}

// Admin: create a key via API
async function apiCreateKey(name) {
  const resp = await apiFetch("/admin/api/keys", {
    method: "POST",
    body: JSON.stringify({ name }),
  });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    throw new Error(err.error || `Server error ${resp.status}`);
  }
  return resp.json();
}

// Admin: list keys via API
async function apiListKeys() {
  const resp = await apiFetch("/admin/api/keys");
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    throw new Error(err.error || `Server error ${resp.status}`);
  }
  return resp.json();
}

// Admin: revoke a key via API
async function apiRevokeKey(keyId) {
  const resp = await apiFetch(`/admin/api/keys/${encodeURIComponent(keyId)}`, {
    method: "DELETE",
  });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    throw new Error(err.error || `Server error ${resp.status}`);
  }
}

// Reference recordings
async function apiGetReferences() {
  const resp = await apiFetch("/lab/api/references");
  if (!resp.ok) return {};
  return resp.json();
}

async function apiSetReference(trick, recordingId) {
  const resp = await apiFetch(`/lab/api/references/${encodeURIComponent(trick)}`, {
    method: "PUT",
    body: JSON.stringify({ recording_id: recordingId }),
  });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    throw new Error(err.error || `Server error ${resp.status}`);
  }
  return resp.json();
}

async function apiDeleteReference(trick) {
  const resp = await apiFetch(`/lab/api/references/${encodeURIComponent(trick)}`, {
    method: "DELETE",
  });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    throw new Error(err.error || `Server error ${resp.status}`);
  }
}

// ──────────────────────────────────────────────
// Trick selector
// ──────────────────────────────────────────────
function buildTrickGrid() {
  const grid = document.querySelector(".trick-grid");
  grid.innerHTML = "";
  TRICKS.forEach((trick) => {
    const btn = document.createElement("button");
    btn.className =
      "trick-btn" + (trick === state.selectedTrick ? " selected" : "");
    btn.textContent = trick;
    btn.addEventListener("click", () => selectTrick(trick));
    grid.appendChild(btn);
  });
}

function selectTrick(trick) {
  if (state.isRecording) return;
  state.selectedTrick = trick;
  document.querySelectorAll(".trick-btn").forEach((b) => {
    b.classList.toggle("selected", b.textContent === trick);
  });
  showRefAnimation(trick);
}

// ──────────────────────────────────────────────
// Sensor handling
// ──────────────────────────────────────────────
let latestAcc = { x: 0, y: 0, z: 0 };
let latestGyr = { x: 0, y: 0, z: 0 };

function onMotion(e) {
  const acc = e.accelerationIncludingGravity || e.acceleration || {};
  const gyr = e.rotationRate || {};

  latestAcc = {
    x: acc.x ?? 0,
    y: acc.y ?? 0,
    z: acc.z ?? 0,
  };
  latestGyr = {
    // rotationRate is deg/s – convert to rad/s
    x: ((gyr.alpha ?? 0) * Math.PI) / 180,
    y: ((gyr.beta ?? 0) * Math.PI) / 180,
    z: ((gyr.gamma ?? 0) * Math.PI) / 180,
  };

  // Update live display
  sensorEls.ax.textContent = latestAcc.x.toFixed(2);
  sensorEls.ay.textContent = latestAcc.y.toFixed(2);
  sensorEls.az.textContent = latestAcc.z.toFixed(2);
  sensorEls.gx.textContent = latestGyr.x.toFixed(2);
  sensorEls.gy.textContent = latestGyr.y.toFixed(2);
  sensorEls.gz.textContent = latestGyr.z.toFixed(2);

  if (state.isRecording) {
    const t = Date.now() - state.recordingStart;
    state.samples.push({
      t,
      ax: +latestAcc.x.toFixed(4),
      ay: +latestAcc.y.toFixed(4),
      az: +latestAcc.z.toFixed(4),
      gx: +latestGyr.x.toFixed(4),
      gy: +latestGyr.y.toFixed(4),
      gz: +latestGyr.z.toFixed(4),
    });
  }
}

function attachMotionListener() {
  // Track whether we've received at least one non-null reading
  let gotRealData = false;
  let checkTimeout = null;

  function wrappedOnMotion(e) {
    const acc = e.accelerationIncludingGravity || e.acceleration || {};
    // Detect if the sensor is actually delivering data (not all nulls/zeros)
    if (!gotRealData) {
      const hasData =
        (acc.x != null && acc.x !== 0) ||
        (acc.y != null && acc.y !== 0) ||
        (acc.z != null && acc.z !== 0);
      if (hasData) {
        gotRealData = true;
        clearTimeout(checkTimeout);
        state.sensorAvailable = true;
        state.sensorPermissionGranted = true;
        statusMsg.textContent = "Sensor active – select a trick and record!";
      }
    }
    onMotion(e);
  }

  window.addEventListener("devicemotion", wrappedOnMotion);
  permissionBanner.classList.add("hidden");

  // After 1.5 s, check if we actually received real sensor data
  checkTimeout = setTimeout(() => {
    if (!gotRealData) {
      statusMsg.textContent = "Sensors detected but not delivering data.";
      // Check if this is an insecure context (HTTP)
      if (
        window.location.protocol === "http:" &&
        window.location.hostname !== "localhost" &&
        window.location.hostname !== "127.0.0.1"
      ) {
        statusMsg.textContent =
          "⚠️ Sensors require HTTPS! Open this page via https:// or localhost.";
      } else {
        statusMsg.textContent =
          "⚠️ Sensors not responding. Try shaking the device, or use a different browser.";
      }
      // Still mark as granted so recording can be attempted
      // (some devices start reporting only after first shake)
      state.sensorPermissionGranted = true;
    }
  }, 1500);

  // Optimistically set state so UI isn't blocked
  state.sensorPermissionGranted = true;
}

async function requestSensorPermission() {
  if (
    typeof DeviceMotionEvent !== "undefined" &&
    typeof DeviceMotionEvent.requestPermission === "function"
  ) {
    try {
      const result = await DeviceMotionEvent.requestPermission();
      if (result === "granted") {
        attachMotionListener();
      } else {
        showToast("Permission denied – sensor unavailable.");
      }
    } catch (err) {
      showToast("Could not request permission: " + err.message);
    }
  } else {
    // Non-iOS: no permission API needed
    attachMotionListener();
  }
}

function initSensors() {
  if (typeof DeviceMotionEvent === "undefined") {
    statusMsg.textContent = "No motion sensors detected on this device.";
    // Check insecure context
    if (
      window.location.protocol === "http:" &&
      window.location.hostname !== "localhost" &&
      window.location.hostname !== "127.0.0.1"
    ) {
      statusMsg.textContent =
        "⚠️ Sensors require HTTPS! Open this page via https:// or localhost.";
    }
    return;
  }

  // Check Permissions API (some Android Chrome versions)
  if (navigator.permissions && navigator.permissions.query) {
    navigator.permissions
      .query({ name: "accelerometer" })
      .then((result) => {
        if (result.state === "denied") {
          statusMsg.textContent =
            "⚠️ Sensor permission blocked in browser settings. Allow motion sensors for this site.";
        }
      })
      .catch(() => {
        /* Permissions API may not support this name – ignore */
      });
  }

  if (typeof DeviceMotionEvent.requestPermission === "function") {
    // iOS 13+ – first check if permission was already granted
    let alreadyGranted = false;
    function probeHandler(e) {
      const acc = e.accelerationIncludingGravity || e.acceleration || {};
      const hasData =
        (acc.x != null && acc.x !== 0) ||
        (acc.y != null && acc.y !== 0) ||
        (acc.z != null && acc.z !== 0);
      if (hasData) {
        alreadyGranted = true;
        window.removeEventListener("devicemotion", probeHandler);
        attachMotionListener();
      }
    }
    window.addEventListener("devicemotion", probeHandler);
    // Give it a moment – if no data arrives, permission is needed
    setTimeout(() => {
      if (!alreadyGranted) {
        window.removeEventListener("devicemotion", probeHandler);
        permissionBanner.classList.remove("hidden");
        statusMsg.textContent = 'Tap "Enable Sensors" to start.';
      }
    }, 1000);
  } else {
    // Android / desktop browsers – attach and verify
    attachMotionListener();
  }
}

// ──────────────────────────────────────────────
// Recording
// ──────────────────────────────────────────────
function startRecording() {
  if (
    !state.sensorPermissionGranted &&
    typeof DeviceMotionEvent !== "undefined"
  ) {
    showToast("Enable sensors first!");
    return;
  }
  stopRefAnimation();
  state.isRecording = true;
  state.samples = [];
  state.recordingStart = Date.now();

  recordBtn.classList.add("recording");
  recordBtn.querySelector(".btn-label").textContent = "STOP";
  recordBtn.querySelector(".btn-icon").textContent = "⏹";
  timerDisplay.classList.add("recording");
  statusMsg.textContent = "Recording…";

  state.timerInterval = setInterval(updateTimer, 100);
}

function stopRecording() {
  state.isRecording = false;
  clearInterval(state.timerInterval);

  const durationMs = Date.now() - state.recordingStart;

  recordBtn.classList.remove("recording");
  recordBtn.querySelector(".btn-label").textContent = "RECORD";
  recordBtn.querySelector(".btn-icon").textContent = "⏺";
  timerDisplay.classList.remove("recording");
  timerDisplay.textContent = "0:00.0";
  statusMsg.textContent = "Review your recording…";

  if (state.samples.length < 5) {
    showToast("Too few samples – try again!");
    statusMsg.textContent = "Ready – select a trick and record!";
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
  const elapsed = Date.now() - state.recordingStart;
  const tenths = Math.floor((elapsed % 1000) / 100);
  const secs = Math.floor(elapsed / 1000) % 60;
  const mins = Math.floor(elapsed / 60000);
  timerDisplay.textContent = `${mins}:${String(secs).padStart(2, "0")}.${tenths}`;
}

// ──────────────────────────────────────────────
// 3D Flip Animation (quaternion integration from gyro data)
// ──────────────────────────────────────────────
const anim = {
  canvas: null,
  ctx: null,
  orientations: [],  // precomputed quaternions per sample
  samples: [],
  playing: false,
  currentTime: 0,
  totalTime: 0,
  speed: 0.5,
  rafId: null,
  lastFrame: null,
};

// Quaternion helpers  [w, x, y, z]
function qMul(a, b) {
  return [
    a[0]*b[0] - a[1]*b[1] - a[2]*b[2] - a[3]*b[3],
    a[0]*b[1] + a[1]*b[0] + a[2]*b[3] - a[3]*b[2],
    a[0]*b[2] - a[1]*b[3] + a[2]*b[0] + a[3]*b[1],
    a[0]*b[3] + a[1]*b[2] - a[2]*b[1] + a[3]*b[0],
  ];
}

function qNorm(q) {
  const len = Math.sqrt(q[0]*q[0] + q[1]*q[1] + q[2]*q[2] + q[3]*q[3]);
  if (len < 1e-10) return [1, 0, 0, 0];
  return [q[0]/len, q[1]/len, q[2]/len, q[3]/len];
}

function qToMatrix(q) {
  const [w, x, y, z] = q;
  return [
    1-2*(y*y+z*z),   2*(x*y-z*w),   2*(x*z+y*w),
      2*(x*y+z*w), 1-2*(x*x+z*z),   2*(y*z-x*w),
      2*(x*z-y*w),   2*(y*z+x*w), 1-2*(x*x+y*y),
  ];
}

function computeOrientations(samples) {
  const orientations = [[1, 0, 0, 0]]; // identity quaternion
  for (let i = 1; i < samples.length; i++) {
    const dt = (samples[i].t - samples[i-1].t) / 1000; // seconds
    const gx = samples[i].gx;
    const gy = samples[i].gy;
    const gz = samples[i].gz;
    const angle = Math.sqrt(gx*gx + gy*gy + gz*gz) * dt;
    let dq;
    if (angle < 1e-8) {
      dq = [1, 0, 0, 0];
    } else {
      const ha = angle / 2;
      const omega = angle / dt;
      const ax = gx / omega;
      const ay = gy / omega;
      const az = gz / omega;
      const sinHa = Math.sin(ha);
      dq = [Math.cos(ha), ax * sinHa, ay * sinHa, az * sinHa];
    }
    orientations.push(qNorm(qMul(orientations[i-1], dq)));
  }
  return orientations;
}

function project(point, m, cx, cy, scale, dist) {
  // Rotate point by matrix m
  const rx = m[0]*point[0] + m[1]*point[1] + m[2]*point[2];
  const ry = m[3]*point[0] + m[4]*point[1] + m[5]*point[2];
  const rz = m[6]*point[0] + m[7]*point[1] + m[8]*point[2];
  // Perspective projection
  const z = dist + rz;
  const f = dist / Math.max(z, 0.1);
  return [cx + rx * scale * f, cy - ry * scale * f, z];
}

function drawPhone3D(ctx, W, H, q) {
  const m = qToMatrix(q);
  const cx = W / 2;
  const cy = H / 2;
  const scale = Math.min(W, H) * 0.28;
  const dist = 4;

  // Phone dimensions (normalized): width=0.5, height=1, depth=0.08
  const pw = 0.5, ph = 1.0, pd = 0.08;
  const hw = pw/2, hh = ph/2, hd = pd/2;

  // 8 corners of the phone box
  const corners = [
    [-hw, -hh, -hd], [ hw, -hh, -hd], [ hw,  hh, -hd], [-hw,  hh, -hd], // back
    [-hw, -hh,  hd], [ hw, -hh,  hd], [ hw,  hh,  hd], [-hw,  hh,  hd], // front
  ];

  const projected = corners.map(p => project(p, m, cx, cy, scale, dist));

  // 6 faces: [indices, color]
  const faces = [
    { idx: [0,1,2,3], color: "#1a1a1a", label: null },       // back
    { idx: [4,5,6,7], color: "#2a2a2a", label: "screen" },   // front (screen)
    { idx: [0,1,5,4], color: "#222",    label: null },        // bottom
    { idx: [2,3,7,6], color: "#222",    label: null },        // top
    { idx: [0,3,7,4], color: "#252525", label: null },        // left
    { idx: [1,2,6,5], color: "#252525", label: null },        // right
  ];

  // Compute face normals and sort back-to-front (painter's algorithm)
  const facesWithDepth = faces.map(f => {
    const ps = f.idx.map(i => projected[i]);
    const avgZ = ps.reduce((s, p) => s + p[2], 0) / ps.length;
    // Normal for visibility check (cross product in screen space)
    const ax = ps[1][0] - ps[0][0], ay = ps[1][1] - ps[0][1];
    const bx = ps[3][0] - ps[0][0], by = ps[3][1] - ps[0][1];
    const cross = ax * by - ay * bx;
    return { ...f, ps, avgZ, cross };
  });

  facesWithDepth.sort((a, b) => a.avgZ - b.avgZ);

  for (const face of facesWithDepth) {
    // Skip back-facing unless it's the screen (we want to see the phone from both sides)
    ctx.beginPath();
    ctx.moveTo(face.ps[0][0], face.ps[0][1]);
    for (let i = 1; i < face.ps.length; i++) {
      ctx.lineTo(face.ps[i][0], face.ps[i][1]);
    }
    ctx.closePath();
    ctx.fillStyle = face.color;
    ctx.fill();
    ctx.strokeStyle = "#444";
    ctx.lineWidth = 1;
    ctx.stroke();

    // Draw screen content on front face
    if (face.label === "screen" && face.cross < 0) {
      // Screen area (slightly inset)
      const inset = 0.07;
      const screenCorners = [
        [-hw + inset*pw, -hh + inset*ph, hd + 0.001],
        [ hw - inset*pw, -hh + inset*ph, hd + 0.001],
        [ hw - inset*pw,  hh - inset*ph, hd + 0.001],
        [-hw + inset*pw,  hh - inset*ph, hd + 0.001],
      ];
      const sp = screenCorners.map(p => project(p, m, cx, cy, scale, dist));
      ctx.beginPath();
      ctx.moveTo(sp[0][0], sp[0][1]);
      for (let i = 1; i < sp.length; i++) ctx.lineTo(sp[i][0], sp[i][1]);
      ctx.closePath();
      ctx.fillStyle = "#003344";
      ctx.fill();

      // Camera notch
      const notchY = -hh + inset*ph * 1.5;
      const notch = [
        [-0.04, notchY, hd + 0.002],
        [ 0.04, notchY, hd + 0.002],
      ];
      const np = notch.map(p => project(p, m, cx, cy, scale, dist));
      ctx.beginPath();
      ctx.arc((np[0][0]+np[1][0])/2, (np[0][1]+np[1][1])/2, 3, 0, Math.PI*2);
      ctx.fillStyle = "#001a22";
      ctx.fill();
    }
  }

}

function draw3D(ctx, W, H, q) {
  drawPhone3D(ctx, W, H, q);
}

function initAnimation(samples) {
  anim.canvas = $("anim-canvas");
  anim.ctx = anim.canvas.getContext("2d");
  anim.samples = samples;
  anim.orientations = computeOrientations(samples);
  anim.totalTime = samples.length > 0 ? samples[samples.length - 1].t : 0;
  anim.currentTime = 0;
  anim.playing = false;
  anim.lastFrame = null;

  const scrubber = $("anim-scrubber");
  const playBtn = $("anim-play");
  const speedSel = $("anim-speed");
  const timeEl = $("anim-time");

  anim.speed = parseFloat(speedSel.value);

  // Draw initial frame
  renderAnimFrame();

  // Controls
  playBtn.onclick = () => {
    if (anim.playing) {
      stopAnim();
    } else {
      startAnim();
    }
  };

  scrubber.oninput = () => {
    anim.currentTime = (parseFloat(scrubber.value) / 100) * anim.totalTime;
    timeEl.textContent = (anim.currentTime / 1000).toFixed(2) + "s";
    if (!anim.playing) renderAnimFrame();
  };

  speedSel.onchange = () => {
    anim.speed = parseFloat(speedSel.value);
  };
}

function startAnim() {
  if (anim.currentTime >= anim.totalTime) anim.currentTime = 0;
  anim.playing = true;
  anim.lastFrame = performance.now();
  $("anim-play").textContent = "⏸";
  animLoop();
}

function stopAnim() {
  anim.playing = false;
  $("anim-play").textContent = "▶";
  if (anim.rafId) cancelAnimationFrame(anim.rafId);
  anim.rafId = null;
}

function animLoop() {
  if (!anim.playing) return;
  const now = performance.now();
  const dt = now - anim.lastFrame;
  anim.lastFrame = now;
  anim.currentTime += dt * anim.speed;

  if (anim.currentTime >= anim.totalTime) {
    anim.currentTime = anim.totalTime;
    renderAnimFrame();
    stopAnim();
    return;
  }

  $("anim-scrubber").value = (anim.currentTime / anim.totalTime) * 100;
  $("anim-time").textContent = (anim.currentTime / 1000).toFixed(2) + "s";
  renderAnimFrame();
  anim.rafId = requestAnimationFrame(animLoop);
}

function getQuaternionAtTime(samples, orientations, time) {
  let idx = 0;
  for (let i = 0; i < samples.length - 1; i++) {
    if (samples[i + 1].t >= time) { idx = i; break; }
    idx = i;
  }
  const t0 = samples[idx].t;
  const t1 = idx + 1 < samples.length ? samples[idx + 1].t : t0;
  const frac = t1 > t0 ? (time - t0) / (t1 - t0) : 0;
  const q0 = orientations[idx];
  const q1 = idx + 1 < orientations.length ? orientations[idx + 1] : q0;
  let dot = q0[0]*q1[0] + q0[1]*q1[1] + q0[2]*q1[2] + q0[3]*q1[3];
  const sign = dot < 0 ? -1 : 1;
  return qNorm([
    q0[0] + (sign * q1[0] - q0[0]) * frac,
    q0[1] + (sign * q1[1] - q0[1]) * frac,
    q0[2] + (sign * q1[2] - q0[2]) * frac,
    q0[3] + (sign * q1[3] - q0[3]) * frac,
  ]);
}

function renderAnimFrame() {
  const canvas = anim.canvas;
  const ctx = anim.ctx;
  const W = canvas.clientWidth;
  const H = canvas.clientHeight;
  canvas.width = W;
  canvas.height = H;
  ctx.clearRect(0, 0, W, H);

  if (anim.orientations.length < 2) return;
  const q = getQuaternionAtTime(anim.samples, anim.orientations, anim.currentTime);
  draw3D(ctx, W, H, q);
}

// ──────────────────────────────────────────────
// Reference animation (looping in Record view)
// ──────────────────────────────────────────────
const refAnim = {
  orientations: [],
  samples: [],
  totalTime: 0,
  currentTime: 0,
  rafId: null,
  lastFrame: null,
  active: false,
};

async function loadReferences() {
  try {
    state.references = await apiGetReferences();
  } catch (_) {
    state.references = {};
  }
}

function showRefAnimation(trick) {
  stopRefAnimation();
  const card = $("ref-anim-card");
  const ref = state.references[trick];
  if (!ref || !ref.samples || ref.samples.length < 2) {
    card.classList.add("hidden");
    return;
  }
  $("ref-trick-label").textContent = trick;
  card.classList.remove("hidden");
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
  if (refAnim.rafId) cancelAnimationFrame(refAnim.rafId);
  refAnim.rafId = null;
}

function refAnimLoop() {
  if (!refAnim.active) return;
  const now = performance.now();
  const dt = now - refAnim.lastFrame;
  refAnim.lastFrame = now;
  refAnim.currentTime += dt * 0.5; // play at 0.5x speed

  // Loop
  if (refAnim.currentTime >= refAnim.totalTime) {
    refAnim.currentTime = 0;
  }

  const canvas = $("ref-anim-canvas");
  const ctx = canvas.getContext("2d");
  const W = canvas.clientWidth;
  const H = canvas.clientHeight;
  canvas.width = W;
  canvas.height = H;
  ctx.clearRect(0, 0, W, H);

  if (refAnim.orientations.length >= 2) {
    const q = getQuaternionAtTime(refAnim.samples, refAnim.orientations, refAnim.currentTime);
    draw3D(ctx, W, H, q);
  }

  refAnim.rafId = requestAnimationFrame(refAnimLoop);
}

// ──────────────────────────────────────────────
// Review sheet
// ──────────────────────────────────────────────
function openReview(rec, reviewOnly = false) {
  reviewTrickName.textContent = rec.trick;
  reviewDuration.textContent = (rec.durationMs / 1000).toFixed(2) + "s";
  reviewSamples.textContent = rec.sampleCount;
  reviewSampleRate.textContent = rec.sampleRateHz + " Hz";

  // In review-only mode (from dataset), hide save/discard buttons and show close
  if (reviewOnly) {
    btnSave.style.display = "none";
    btnDiscard.textContent = "Close";
    state.pendingRecording = null;
  } else {
    btnSave.style.display = "";
    btnDiscard.textContent = "❌ Discard";
  }

  stopRefAnimation();
  reviewOverlay.classList.remove("hidden");
  initAnimation(rec.samples);
}

function closeReview() {
  stopAnim();
  reviewOverlay.classList.add("hidden");
  state.pendingRecording = null;
  statusMsg.textContent = "Ready – select a trick and record!";
  showRefAnimation(state.selectedTrick);
}

// ──────────────────────────────────────────────
// Dataset view
// ──────────────────────────────────────────────
async function renderDataset(refetchData = true) {
  if (refetchData) {
    $("user-stats").innerHTML = '<p class="dataset-empty">Loading…</p>';

    let stats;
    try {
      const statsResp = await apiFetch("/lab/api/stats");
      if (!statsResp.ok) throw new Error("Could not load stats");
      stats = await statsResp.json();
    } catch (err) {
      stats = null;
    }

    let ds = [];
    if (state.isAdmin) {
      try {
        ds = await apiLoadRecordings();
      } catch (err) {
        ds = [];
      }
    }

    state.datasetCache = { ds, stats };
  }

  const { ds, stats } = state.datasetCache || { ds: [], stats: null };

  datasetCount.textContent = stats ? stats.total : ds.length;

  // ── User stats (always visible) ──
  renderUserStats(stats);

  // ── Admin section ──
  const adminSection = $("admin-section");
  if (state.isAdmin) {
    adminSection.classList.remove("hidden");
    renderFilters(ds, stats);
    renderRecordingList(ds);
    renderAdminPanel();
  } else {
    adminSection.classList.add("hidden");
  }
}

function renderUserStats(stats) {
  const el = $("user-stats");
  if (!stats || stats.total === 0) {
    el.innerHTML = '<p class="dataset-empty">No recordings yet. Record a trick and save it!</p>';
    return;
  }

  const pillsHtml = stats.by_trick
    .map(
      (t) =>
        `<div class="trick-stat-pill">${escapeHtml(t.trick)}: <span>${t.count}</span></div>`,
    )
    .join("");

  let html = `<div class="trick-stats">${pillsHtml}</div>`;

  // Collector stats (admin only)
  if (stats.by_collector && stats.by_collector.length > 0) {
    const collectorPills = stats.by_collector
      .map(
        (c) =>
          `<div class="trick-stat-pill">${escapeHtml(c.name)}: <span>${c.count}</span></div>`,
      )
      .join("");
    html += `<div class="card-title" style="margin-top:12px;margin-bottom:6px;">By Collector</div><div class="trick-stats">${collectorPills}</div>`;
  }

  el.innerHTML = html;
}

function renderFilters(ds, stats) {
  const trickSelect = $("filter-trick");
  const collectorSelect = $("filter-collector");

  // Populate trick filter (preserve selection)
  const tricks = stats?.by_trick?.map((t) => t.trick) || [];
  const prevTrick = state.filterTrick;
  trickSelect.innerHTML = '<option value="">All Tricks</option>' +
    tricks.map((t) => `<option value="${escapeHtml(t)}"${t === prevTrick ? " selected" : ""}>${escapeHtml(t)}</option>`).join("");

  // Populate collector filter
  const collectors = [...new Set(ds.map((r) => r.collector).filter(Boolean))].sort();
  const prevCollector = state.filterCollector;
  collectorSelect.innerHTML = '<option value="">All Collectors</option>' +
    collectors.map((c) => `<option value="${escapeHtml(c)}"${c === prevCollector ? " selected" : ""}>${escapeHtml(c)}</option>`).join("");
}

function renderRecordingList(ds) {
  const list = $("dataset-list");

  // Apply filters
  let filtered = ds;
  if (state.filterTrick) {
    filtered = filtered.filter((r) => r.trick === state.filterTrick);
  }
  if (state.filterCollector) {
    filtered = filtered.filter((r) => r.collector === state.filterCollector);
  }

  if (filtered.length === 0) {
    list.innerHTML = '<p class="dataset-empty">No recordings match the filter.</p>';
    return;
  }

  const refIds = new Set(Object.values(state.references).map((r) => r.id));

  const itemsHtml = filtered
    .map((r) => {
      const date = new Date(r.timestamp).toLocaleString();
      const collector = r.collector ? ` · ${escapeHtml(r.collector)}` : "";
      const isRef = refIds.has(r.id);
      return `
      <div class="recording-item" data-id="${escapeHtml(r.id)}">
        <div class="trick-label">
          <div class="trick-name">${escapeHtml(r.trick)}${isRef ? ' <span style="color:var(--accent);font-size:0.75rem;">★ Ref</span>' : ""}</div>
          <div class="trick-meta">${date} · ${(r.durationMs / 1000).toFixed(2)}s · ${r.sampleCount} samples${collector}</div>
        </div>
        <button class="item-play" data-id="${escapeHtml(r.id)}" aria-label="Play animation">▶</button>
        <button class="ref-btn${isRef ? " is-ref" : ""}" data-id="${escapeHtml(r.id)}" data-trick="${escapeHtml(r.trick)}">${isRef ? "★ Ref" : "Set Ref"}</button>
        <button class="item-delete" data-id="${escapeHtml(r.id)}" aria-label="Delete recording">🗑</button>
      </div>`;
    })
    .join("");

  list.innerHTML = itemsHtml;

  // Attach listeners
  list.querySelectorAll(".item-play").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      const id = e.currentTarget.dataset.id;
      const rec = ds.find((r) => r.id === id);
      if (rec) openReview(rec, true);
    });
  });

  list.querySelectorAll(".item-delete").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      const id = e.currentTarget.dataset.id;
      try {
        await apiDeleteRecording(id);
        showToast("Recording deleted.");
        renderDataset();
      } catch (err) {
        showToast("Delete failed: " + err.message);
      }
    });
  });

  list.querySelectorAll(".ref-btn").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      const id = e.currentTarget.dataset.id;
      const trick = e.currentTarget.dataset.trick;
      const isRef = e.currentTarget.classList.contains("is-ref");
      try {
        if (isRef) {
          await apiDeleteReference(trick);
          showToast(`Reference removed for ${trick}.`);
        } else {
          await apiSetReference(trick, id);
          showToast(`★ Set as reference for ${trick}!`);
        }
        await loadReferences();
        renderDataset(false);
      } catch (err) {
        showToast("Failed: " + err.message);
      }
    });
  });
}

async function renderAdminPanel() {
  const panel = $("admin-panel");
  if (!panel) return;

  let keys;
  try {
    keys = await apiListKeys();
  } catch (_) {
    return;
  }

  const rowsHtml = keys
    .map(
      (k) => `
    <div class="key-item">
      <div class="key-info">
        <span class="key-name">${escapeHtml(k.name)}${k.is_admin ? ' <span class="admin-badge">admin</span>' : ""}</span>
        <span class="key-preview">${escapeHtml(k.key_preview)}</span>
      </div>
      <button class="item-delete key-revoke" data-id="${k.id}" aria-label="Revoke key">🗑</button>
    </div>`,
    )
    .join("");

  panel.innerHTML = `
    <div class="card-title">API Keys</div>
    <div id="key-list">${rowsHtml}</div>
    <div class="create-key-row">
      <input id="new-key-name" type="text" placeholder="Friend's name…" class="key-name-input" />
      <button id="create-key-btn" class="icon-btn">+ Add key</button>
    </div>`;

  panel.querySelectorAll(".key-revoke").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      const id = parseInt(e.currentTarget.dataset.id, 10);
      if (!confirm("Revoke this key?")) return;
      try {
        await apiRevokeKey(id);
        showToast("Key revoked.");
        renderAdminPanel();
      } catch (err) {
        showToast("Revoke failed: " + err.message);
      }
    });
  });

  $("create-key-btn").addEventListener("click", async () => {
    const name = ($("new-key-name").value || "").trim();
    if (!name) {
      showToast("Enter a name first.");
      return;
    }
    try {
      const result = await apiCreateKey(name);
      showToast(`Key created for ${result.name}!`);
      $("new-key-name").value = "";
      showKeyModal(result.name, result.key);
      renderAdminPanel();
    } catch (err) {
      showToast("Create failed: " + err.message);
    }
  });
}

function showKeyModal(name, key) {
  // Remove existing modal if any
  const existing = document.getElementById("key-modal");
  if (existing) existing.remove();

  const overlay = document.createElement("div");
  overlay.id = "key-modal";
  overlay.className = "modal-overlay";
  overlay.innerHTML = `
    <div class="modal-sheet">
      <h2>🔑 Key created</h2>
      <p class="modal-desc">New key for <strong>${escapeHtml(name)}</strong>. Copy it now — it won't be shown again.</p>
      <div class="modal-field">
        <label>API Key</label>
        <div style="display:flex;gap:8px;">
          <input type="text" id="key-modal-value" value="${escapeHtml(key)}" readonly
                 style="flex:1;background:var(--surface2);border:1px solid var(--border);border-radius:10px;color:var(--accent);font-family:monospace;font-size:0.85rem;padding:11px 14px;" />
          <button id="key-modal-copy" class="modal-submit-btn" style="white-space:nowrap;padding:11px 18px;">Copy</button>
        </div>
      </div>
      <div class="modal-actions" style="grid-template-columns:1fr;">
        <button id="key-modal-close" class="modal-cancel-btn" style="width:100%;">Done</button>
      </div>
    </div>`;

  document.body.appendChild(overlay);

  document.getElementById("key-modal-copy").addEventListener("click", () => {
    const input = document.getElementById("key-modal-value");
    if (navigator.clipboard) {
      navigator.clipboard
        .writeText(key)
        .then(() => {
          showToast("✅ Key copied!");
        })
        .catch(() => {
          input.select();
          document.execCommand("copy");
          showToast("✅ Key copied!");
        });
    } else {
      input.select();
      document.execCommand("copy");
      showToast("✅ Key copied!");
    }
  });

  document.getElementById("key-modal-close").addEventListener("click", () => {
    overlay.remove();
  });
}

function escapeHtml(str) {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ──────────────────────────────────────────────
// Toast
// ──────────────────────────────────────────────
let toastTimeout = null;
function showToast(msg) {
  toast.textContent = msg;
  toast.classList.add("show");
  clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => toast.classList.remove("show"), 2500);
}

// ──────────────────────────────────────────────
// Tab navigation
// ──────────────────────────────────────────────
function switchTab(tabName) {
  document
    .querySelectorAll(".tab-btn")
    .forEach((b) => b.classList.toggle("active", b.dataset.tab === tabName));
  document
    .querySelectorAll(".view")
    .forEach((v) => v.classList.toggle("active", v.id === tabName + "-view"));

  if (tabName === "dataset") renderDataset();
}

// ──────────────────────────────────────────────
// Setup modal (API key + server URL)
// ──────────────────────────────────────────────
function openSetupModal(prefillError) {
  const modal = $("setup-modal");
  const cfg = getConfig();
  $("setup-api-key").value = cfg.apiKey || "";
  $("setup-error").textContent = prefillError || "";
  modal.classList.remove("hidden");
}

function closeSetupModal() {
  $("setup-modal").classList.add("hidden");
}

async function submitSetup() {
  const serverUrl = window.location.origin;
  const apiKey = ($("setup-api-key").value || "").trim();
  const errorEl = $("setup-error");

  if (!apiKey) {
    errorEl.textContent = "API key is required.";
    return;
  }

  const btn = $("setup-submit-btn");
  btn.disabled = true;
  btn.textContent = "Connecting…";
  errorEl.textContent = "";

  try {
    // Test the credentials against /api/me
    const resp = await fetch(serverUrl + "/lab/api/me", {
      headers: { "X-API-Key": apiKey },
    });
    if (!resp.ok) {
      const body = await resp.json().catch(() => ({}));
      throw new Error(body.error || `HTTP ${resp.status}`);
    }
    const me = await resp.json();
    setConfig({ serverUrl, apiKey });
    state.isAdmin = !!me.is_admin;
    closeSetupModal();
    showToast(`✅ Connected as ${me.name}${me.is_admin ? " (admin)" : ""}`);
    updateHeaderName(me.name, me.is_admin);
    await loadReferences();
    showRefAnimation(state.selectedTrick);
    renderDataset();
  } catch (err) {
    errorEl.textContent = "Connection failed: " + err.message;
  } finally {
    btn.disabled = false;
    btn.textContent = "Connect";
  }
}

function updateHeaderName(name, isAdmin) {
  const el = $("connected-as");
  if (el) el.textContent = name + (isAdmin ? " ★" : "");
}

// ──────────────────────────────────────────────
// Init
// ──────────────────────────────────────────────
async function init() {
  buildTrickGrid();
  initSensors();

  // Tab buttons
  document.querySelectorAll(".tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => switchTab(btn.dataset.tab));
  });

  // Record button
  recordBtn.addEventListener("click", () => {
    if (state.isRecording) stopRecording();
    else startRecording();
  });

  // Permission button
  requestPermBtn.addEventListener("click", requestSensorPermission);

  // Review actions
  btnSave.addEventListener("click", async () => {
    if (!state.pendingRecording) {
      closeReview();
      return;
    }
    btnSave.disabled = true;
    btnSave.textContent = "Saving…";
    try {
      await apiSaveRecording(state.pendingRecording);
      showToast("✅ Recording saved to server!");
      datasetCount.textContent =
        parseInt(datasetCount.textContent || "0", 10) + 1;
    } catch (err) {
      showToast("⚠️ Save failed: " + err.message);
    } finally {
      btnSave.disabled = false;
      btnSave.textContent = "✅ Save";
      closeReview();
    }
  });

  btnDiscard.addEventListener("click", () => {
    showToast("❌ Recording discarded.");
    closeReview();
  });

  // Filter dropdowns (admin)
  $("filter-trick").addEventListener("change", (e) => {
    state.filterTrick = e.target.value;
    renderDataset(false);
  });
  $("filter-collector").addEventListener("change", (e) => {
    state.filterCollector = e.target.value;
    renderDataset(false);
  });


  // Settings button (re-open setup modal)
  $("btn-settings").addEventListener("click", () => openSetupModal());

  // Setup modal submit/cancel
  $("setup-submit-btn").addEventListener("click", submitSetup);
  $("setup-cancel-btn").addEventListener("click", () => {
    if (isConfigured()) closeSetupModal();
  });
  $("setup-api-key").addEventListener("keydown", (e) => {
    if (e.key === "Enter") submitSetup();
  });

  // Check if already configured
  if (isConfigured()) {
    // Verify the stored config quietly
    try {
      const cfg = getConfig();
      const resp = await fetch(cfg.serverUrl + "/lab/api/me", {
        headers: { "X-API-Key": cfg.apiKey },
      });
      if (resp.ok) {
        const me = await resp.json();
        state.isAdmin = !!me.is_admin;
        updateHeaderName(me.name, me.is_admin);
        await loadReferences();
        showRefAnimation(state.selectedTrick);
        renderDataset();
      } else {
        openSetupModal(
          "Your key or server URL may have changed. Please reconnect.",
        );
      }
    } catch (_) {
      openSetupModal("Could not reach the server. Please check the URL.");
    }
  } else {
    openSetupModal();
  }
}

document.addEventListener("DOMContentLoaded", init);
