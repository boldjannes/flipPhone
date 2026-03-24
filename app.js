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
  "Shuvit",
  "360 Shuvit",
  "Treflip",
  "Hardflip",
  "Varial Kick",
  "Varial Heel",
  "Impossible",
  "Custom",
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
const reviewCanvas = $("review-canvas");
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
  const resp = await apiFetch("/api/recordings", {
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
  const resp = await apiFetch("/api/recordings");
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    throw new Error(err.error || `Server error ${resp.status}`);
  }
  return resp.json();
}

async function apiDeleteRecording(id) {
  const resp = await apiFetch(`/api/recordings/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    throw new Error(err.error || `Server error ${resp.status}`);
  }
}

// Admin: create a key via API
async function apiCreateKey(name) {
  const resp = await apiFetch("/api/keys", {
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
  const resp = await apiFetch("/api/keys");
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    throw new Error(err.error || `Server error ${resp.status}`);
  }
  return resp.json();
}

// Admin: revoke a key via API
async function apiRevokeKey(keyId) {
  const resp = await apiFetch(`/api/keys/${encodeURIComponent(keyId)}`, {
    method: "DELETE",
  });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    throw new Error(err.error || `Server error ${resp.status}`);
  }
}

// Build an export URL (includes api_key as query param for direct download)
function exportUrl(format) {
  const cfg = getConfig();
  const base = (cfg.serverUrl || "").replace(/\/$/, "");
  return `${base}/api/export/${format}?api_key=${encodeURIComponent(cfg.apiKey || "")}`;
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
  window.addEventListener("devicemotion", onMotion);
  state.sensorAvailable = true;
  state.sensorPermissionGranted = true;
  permissionBanner.classList.add("hidden");
  statusMsg.textContent = "Sensor active – select a trick and record!";
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
    return;
  }

  if (typeof DeviceMotionEvent.requestPermission === "function") {
    // iOS 13+ requires explicit permission
    permissionBanner.classList.remove("hidden");
    statusMsg.textContent = 'Tap "Enable Sensors" to start.';
  } else {
    // Android / desktop browsers
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
// Review sheet
// ──────────────────────────────────────────────
function openReview(rec) {
  reviewTrickName.textContent = rec.trick;
  reviewDuration.textContent = (rec.durationMs / 1000).toFixed(2) + "s";
  reviewSamples.textContent = rec.sampleCount;
  reviewSampleRate.textContent = rec.sampleRateHz + " Hz";

  drawChart(rec.samples, reviewCanvas);
  reviewOverlay.classList.remove("hidden");
}

function closeReview() {
  reviewOverlay.classList.add("hidden");
  state.pendingRecording = null;
  statusMsg.textContent = "Ready – select a trick and record!";
}

function drawChart(samples, canvas) {
  const ctx = canvas.getContext("2d");
  const W = canvas.clientWidth;
  const H = canvas.clientHeight;
  canvas.width = W;
  canvas.height = H;

  ctx.clearRect(0, 0, W, H);

  if (!samples || samples.length < 2) return;

  // Compute acceleration magnitude
  const mags = samples.map((s) => Math.sqrt(s.ax ** 2 + s.ay ** 2 + s.az ** 2));
  const maxMag = Math.max(...mags, 1);

  const padX = 12;
  const padY = 10;
  const w = W - padX * 2;
  const h = H - padY * 2;

  // Background grid lines
  ctx.strokeStyle = "#333";
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const y = padY + (h / 4) * i;
    ctx.beginPath();
    ctx.moveTo(padX, y);
    ctx.lineTo(padX + w, y);
    ctx.stroke();
  }

  // Chart line
  ctx.strokeStyle = "#00e5ff";
  ctx.lineWidth = 2;
  ctx.lineJoin = "round";
  ctx.beginPath();
  samples.forEach((_, i) => {
    const x = padX + (i / (samples.length - 1)) * w;
    const y = padY + h - (mags[i] / maxMag) * h;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();

  // Fill under the line
  ctx.lineTo(padX + w, padY + h);
  ctx.lineTo(padX, padY + h);
  ctx.closePath();
  ctx.fillStyle = "rgba(0,229,255,0.08)";
  ctx.fill();

  // Axis label
  ctx.fillStyle = "#888";
  ctx.font = "10px system-ui";
  ctx.fillText("|a| m/s²", padX + 2, padY + 10);
}

// ──────────────────────────────────────────────
// Dataset view
// ──────────────────────────────────────────────
async function renderDataset() {
  datasetList.innerHTML = '<p class="dataset-empty">Loading…</p>';

  // Hide export buttons for non-admins
  $("btn-export-json").style.display = state.isAdmin ? "" : "none";
  $("btn-export-csv").style.display = state.isAdmin ? "" : "none";

  // Load stats (per-trick counts) from the dedicated endpoint
  let stats;
  try {
    const statsResp = await apiFetch("/api/stats");
    if (!statsResp.ok) throw new Error("Could not load stats");
    stats = await statsResp.json();
  } catch (err) {
    stats = null;
  }

  let ds;
  try {
    ds = await apiLoadRecordings();
  } catch (err) {
    datasetList.innerHTML = `<p class="dataset-empty">⚠️ Could not load recordings.<br><small>${escapeHtml(err.message)}</small></p>`;
    return;
  }

  datasetCount.textContent = stats ? stats.total : ds.length;

  if (ds.length === 0 && (!stats || stats.total === 0)) {
    datasetCount.textContent = 0;
    datasetList.innerHTML =
      '<p class="dataset-empty">No recordings yet.<br>Record a trick and save it!</p>';
    if (state.isAdmin) {
      const panel = $("admin-panel");
      if (panel) panel.classList.remove("hidden");
      renderAdminPanel();
    }
    return;
  }

  // Trick count summary from /api/stats
  let statsHtml = "";
  if (stats && stats.by_trick.length > 0) {
    const pillsHtml = stats.by_trick
      .map(
        (t) =>
          `<div class="trick-stat-pill">${escapeHtml(t.trick)}: <span>${t.count}</span></div>`,
      )
      .join("");
    statsHtml = `<div class="trick-stats">${pillsHtml}</div>`;
  }

  const itemsHtml = ds
    .map((r) => {
      const date = new Date(r.timestamp).toLocaleString();
      const collector = r.collector ? ` · ${escapeHtml(r.collector)}` : "";
      return `
      <div class="recording-item" data-id="${escapeHtml(r.id)}">
        <div class="trick-label">
          <div class="trick-name">${escapeHtml(r.trick)}</div>
          <div class="trick-meta">${date} · ${(r.durationMs / 1000).toFixed(2)}s · ${r.sampleCount} samples · ${r.sampleRateHz} Hz${collector}</div>
        </div>
        <button class="item-delete" data-id="${escapeHtml(r.id)}" aria-label="Delete recording">🗑</button>
      </div>`;
    })
    .join("");

  datasetList.innerHTML = statsHtml + itemsHtml;

  // Attach delete listeners
  datasetList.querySelectorAll(".item-delete").forEach((btn) => {
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

  // Render admin key panel if admin
  if (state.isAdmin) {
    const panel = $("admin-panel");
    if (panel) panel.classList.remove("hidden");
    renderAdminPanel();
  }
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
      // Show the full key in a modal/alert so the admin can copy it
      alert(
        `New key for "${result.name}":\n\n${result.key}\n\nShare this key and your server URL with them.`,
      );
      renderAdminPanel();
    } catch (err) {
      showToast("Create failed: " + err.message);
    }
  });
}

function escapeHtml(str) {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ──────────────────────────────────────────────
// Export (redirect to server for download)
// ──────────────────────────────────────────────
function exportJSON() {
  window.location.href = exportUrl("json");
}

function exportCSV() {
  window.location.href = exportUrl("csv");
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
  $("setup-server-url").value = cfg.serverUrl || window.location.origin;
  $("setup-api-key").value = cfg.apiKey || "";
  $("setup-error").textContent = prefillError || "";
  modal.classList.remove("hidden");
}

function closeSetupModal() {
  $("setup-modal").classList.add("hidden");
}

async function submitSetup() {
  const serverUrl = ($("setup-server-url").value || "")
    .trim()
    .replace(/\/$/, "");
  const apiKey = ($("setup-api-key").value || "").trim();
  const errorEl = $("setup-error");

  if (!serverUrl) {
    errorEl.textContent = "Server URL is required.";
    return;
  }
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
    const resp = await fetch(serverUrl + "/api/me", {
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

  // Export buttons
  $("btn-export-json").addEventListener("click", exportJSON);
  $("btn-export-csv").addEventListener("click", exportCSV);

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
      const resp = await fetch(cfg.serverUrl + "/api/me", {
        headers: { "X-API-Key": cfg.apiKey },
      });
      if (resp.ok) {
        const me = await resp.json();
        state.isAdmin = !!me.is_admin;
        updateHeaderName(me.name, me.is_admin);
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
