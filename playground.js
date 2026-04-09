"use strict";

// ──────────────────────────────────────────────
// State
// ──────────────────────────────────────────────
const state = {
  isRecording: false,
  samples: [],
  recordingStart: null,
  timerInterval: null,
  sensorReady: false,
};

// ──────────────────────────────────────────────
// DOM refs
// ──────────────────────────────────────────────
const $ = (id) => document.getElementById(id);

const recordBtn = $("pg-record-btn");
const timerDisplay = $("pg-timer-display");
const statusMsg = $("pg-status-msg");
const sensorHint = $("pg-sensor-hint");
const permissionBanner = $("pg-permission-banner");
const requestPermBtn = $("pg-request-permission-btn");
const resultsCard = $("pg-results-card");
const trickName = $("pg-trick-name");
const confidence = $("pg-confidence");
const chart = $("pg-chart");
const toast = $("toast");

// ──────────────────────────────────────────────
// Sensor handling
// ──────────────────────────────────────────────
let latestAcc = { x: 0, y: 0, z: 0 };
let latestGyr = { x: 0, y: 0, z: 0 };

function onMotion(e) {
  const acc = e.accelerationIncludingGravity || e.acceleration || {};
  const gyr = e.rotationRate || {};

  latestAcc = { x: acc.x ?? 0, y: acc.y ?? 0, z: acc.z ?? 0 };
  latestGyr = {
    x: ((gyr.alpha ?? 0) * Math.PI) / 180,
    y: ((gyr.beta ?? 0) * Math.PI) / 180,
    z: ((gyr.gamma ?? 0) * Math.PI) / 180,
  };

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
  let gotRealData = false;
  let checkTimeout = null;

  function wrappedOnMotion(e) {
    const acc = e.accelerationIncludingGravity || e.acceleration || {};
    if (!gotRealData) {
      const hasData =
        (acc.x != null && acc.x !== 0) ||
        (acc.y != null && acc.y !== 0) ||
        (acc.z != null && acc.z !== 0);
      if (hasData) {
        gotRealData = true;
        clearTimeout(checkTimeout);
        state.sensorReady = true;
        statusMsg.textContent = "Sensor active – hit record and throw!";
      }
    }
    onMotion(e);
  }

  window.addEventListener("devicemotion", wrappedOnMotion);
  permissionBanner.classList.add("hidden");

  checkTimeout = setTimeout(() => {
    if (!gotRealData) {
      if (
        window.location.protocol === "http:" &&
        window.location.hostname !== "localhost" &&
        window.location.hostname !== "127.0.0.1"
      ) {
        statusMsg.textContent =
          "Sensors require HTTPS! Open this page via https://.";
      } else {
        statusMsg.textContent =
          "Sensors not responding. Try shaking the device.";
      }
    }
  }, 1500);

  state.sensorReady = true;
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
        showToast("Permission denied.");
      }
    } catch (err) {
      showToast("Could not request permission: " + err.message);
    }
  } else {
    attachMotionListener();
  }
}

function initSensors() {
  if (typeof DeviceMotionEvent === "undefined") {
    sensorHint.classList.remove("hidden");
    statusMsg.textContent = "No motion sensors on this device.";
    if (
      window.location.protocol === "http:" &&
      window.location.hostname !== "localhost" &&
      window.location.hostname !== "127.0.0.1"
    ) {
      statusMsg.textContent =
        "Sensors require HTTPS! Open this page via https://.";
    }
    return;
  }

  if (typeof DeviceMotionEvent.requestPermission === "function") {
    // First check if permission was already granted
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
    setTimeout(() => {
      if (!alreadyGranted) {
        window.removeEventListener("devicemotion", probeHandler);
        permissionBanner.classList.remove("hidden");
        statusMsg.textContent = 'Tap "Enable Sensors" to start.';
      }
    }, 1000);
  } else {
    attachMotionListener();
  }
}

// ──────────────────────────────────────────────
// Recording
// ──────────────────────────────────────────────
function startRecording() {
  if (!state.sensorReady) {
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
  resultsCard.classList.add("hidden");

  state.timerInterval = setInterval(updateTimer, 100);
}

function stopRecording() {
  state.isRecording = false;
  clearInterval(state.timerInterval);

  recordBtn.classList.remove("recording");
  recordBtn.querySelector(".btn-label").textContent = "RECORD";
  recordBtn.querySelector(".btn-icon").textContent = "⏺";
  timerDisplay.classList.remove("recording");
  timerDisplay.textContent = "0:00.0";

  if (state.samples.length < 5) {
    showToast("Too few samples – try again!");
    statusMsg.textContent = "Ready – hit record and throw!";
    return;
  }

  submitPrediction();
}

function updateTimer() {
  const elapsed = Date.now() - state.recordingStart;
  const tenths = Math.floor((elapsed % 1000) / 100);
  const secs = Math.floor(elapsed / 1000) % 60;
  const mins = Math.floor(elapsed / 60000);
  timerDisplay.textContent = `${mins}:${String(secs).padStart(2, "0")}.${tenths}`;
}

// ──────────────────────────────────────────────
// Prediction API
// ──────────────────────────────────────────────
async function submitPrediction() {
  statusMsg.textContent = "Analyzing…";
  resultsCard.classList.add("hidden");

  try {
    const resp = await fetch("/api/predict", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ samples: state.samples }),
    });
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      throw new Error(err.error || `Server error ${resp.status}`);
    }
    const result = await resp.json();
    renderResults(result);
  } catch (err) {
    statusMsg.textContent = "Prediction failed: " + err.message;
  }
}

// ──────────────────────────────────────────────
// Results
// ──────────────────────────────────────────────
function renderResults(result) {
  trickName.textContent = result.trick;
  confidence.textContent = (result.confidence * 100).toFixed(1) + "% confidence";

  // Sort probabilities descending
  const probs = Object.entries(result.probabilities).sort((a, b) => b[1] - a[1]);
  const maxProb = probs[0]?.[1] || 1;

  chart.innerHTML = probs
    .map(([name, prob]) => {
      const pct = (prob * 100).toFixed(1);
      const width = ((prob / maxProb) * 100).toFixed(1);
      const isTop = name === result.trick;
      return `
      <div class="pg-bar-row">
        <span class="pg-bar-label${isTop ? " pg-bar-top" : ""}">${escapeHtml(name)}</span>
        <div class="pg-bar-track">
          <div class="pg-bar-fill${isTop ? " pg-bar-fill-top" : ""}" style="width:${width}%"></div>
        </div>
        <span class="pg-bar-pct">${pct}%</span>
      </div>`;
    })
    .join("");

  resultsCard.classList.remove("hidden");
  statusMsg.textContent = "Record again to try another trick!";
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
// Init
// ──────────────────────────────────────────────
function init() {
  initSensors();
  recordBtn.addEventListener("click", () => {
    if (state.isRecording) stopRecording();
    else startRecording();
  });
  requestPermBtn.addEventListener("click", requestSensorPermission);
}

document.addEventListener("DOMContentLoaded", init);
