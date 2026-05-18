"use strict";

import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

const PALETTE = [
  0x00e5ff, 0xff6b6b, 0x51cf66, 0xffd43b,
  0xcc5de8, 0xff922b, 0x74c0fc, 0xf783ac,
  0xa9e34b, 0x4dabf7, 0xffa94d, 0xe599f7,
];
const COLOR_SELECTED = 0xffffff;

// ─── State ────────────────────────────────────
let recordings = [];
let visibleRecordings = [];
let selected = new Set();
let trickColorIdx = {};
let hiddenTricks = new Set();
let hiddenCollectors = new Set();

let threeScene, threeCamera, threeRenderer, threeControls, threePoints;
let posArr, colorArr;

// ─── Auth ─────────────────────────────────────
function getToken() {
  return localStorage.getItem("fp_game_token") || "";
}

function redirectToLogin() {
  window.location.replace("/admin/");
}

async function apiFetch(path, opts = {}) {
  const t = getToken();
  if (!t) { redirectToLogin(); throw new Error("No token"); }
  const headers = { "Authorization": "Bearer " + t, ...(opts.headers || {}) };
  const resp = await fetch(path, { ...opts, headers });
  if (resp.status === 401 || resp.status === 403) { redirectToLogin(); throw new Error("Unauthorized"); }
  return resp;
}

// ─── Load ─────────────────────────────────────
async function loadData() {
  setStatus("Loading recordings…");
  document.getElementById("legend").classList.add("hidden");
  selected.clear();
  updateInfoPanel();

  let resp;
  try { resp = await apiFetch("/admin/api/embeddings"); }
  catch { return; }

  if (!resp.ok) { setStatus("Failed to load data."); return; }

  const data = await resp.json();

  if (!data.length) {
    setStatus("No recordings in the database yet.");
    if (threeRenderer) threeRenderer.domElement.style.opacity = "0";
    return;
  }

  const tricks = [...new Set(data.map(d => d.trick))].sort();
  trickColorIdx = {};
  tricks.forEach((t, i) => { trickColorIdx[t] = i % PALETTE.length; });

  recordings = data.map(d => ({
    id: d.id,
    trick: d.trick,
    collector: d.collector,
    duration_ms: d.duration_ms,
    sample_count: d.sample_count,
    created_at: d.created_at,
    x: d.x,
    y: d.y,
    z: d.z,
  }));

  const collectors = [...new Set(data.map(d => d.collector))].sort();

  setStatus("");
  if (!threeRenderer) buildScene();
  else rebuildPoints();

  buildLegend(tricks);
  buildFilters(tricks, collectors);
  updateInfoPanel();
  if (threeRenderer) threeRenderer.domElement.style.opacity = "1";
}

// ─── Three.js ─────────────────────────────────
function buildScene() {
  const wrapper = document.getElementById("canvas-wrapper");
  const canvas  = document.getElementById("embed-canvas");

  threeRenderer = new THREE.WebGLRenderer({ antialias: true, canvas });
  threeRenderer.setPixelRatio(window.devicePixelRatio);
  threeRenderer.setSize(wrapper.clientWidth, wrapper.clientHeight);
  threeRenderer.setClearColor(0x0d0d0d);

  threeScene = new THREE.Scene();

  threeCamera = new THREE.PerspectiveCamera(60, wrapper.clientWidth / wrapper.clientHeight, 0.01, 1000);
  threeCamera.position.set(0, 0, 8);

  threeControls = new OrbitControls(threeCamera, threeRenderer.domElement);
  threeControls.enableDamping = true;
  threeControls.dampingFactor = 0.08;

  threeScene.add(new THREE.AxesHelper(0.6));

  rebuildPoints();

  canvas.addEventListener("click", onCanvasClick);
  window.addEventListener("resize", onResize);
  animate();
}

function rebuildPoints() {
  if (threePoints) {
    threeScene.remove(threePoints);
    threePoints.geometry.dispose();
    threePoints.material.dispose();
  }

  visibleRecordings = recordings.filter(
    r => !hiddenTricks.has(r.trick) && !hiddenCollectors.has(r.collector)
  );

  const n = visibleRecordings.length;
  posArr   = new Float32Array(n * 3);
  colorArr = new Float32Array(n * 3);

  for (let i = 0; i < n; i++) {
    posArr[i*3]   = visibleRecordings[i].x;
    posArr[i*3+1] = visibleRecordings[i].y;
    posArr[i*3+2] = visibleRecordings[i].z;
    writeColor(i, false);
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(posArr, 3));
  geo.setAttribute("color",    new THREE.BufferAttribute(colorArr, 3));

  const mat = new THREE.PointsMaterial({
    size: 0.2,
    vertexColors: true,
    sizeAttenuation: true,
    transparent: true,
    opacity: 0.88,
  });

  threePoints = new THREE.Points(geo, mat);
  threeScene.add(threePoints);
}

function writeColor(i, isSelected) {
  const hex = isSelected
    ? COLOR_SELECTED
    : (PALETTE[trickColorIdx[visibleRecordings[i].trick] ?? 0]);
  colorArr[i*3]   = ((hex >> 16) & 0xff) / 255;
  colorArr[i*3+1] = ((hex >>  8) & 0xff) / 255;
  colorArr[i*3+2] = ( hex        & 0xff) / 255;
}

function refreshColors() {
  for (let i = 0; i < visibleRecordings.length; i++) {
    writeColor(i, selected.has(visibleRecordings[i].id));
  }
  if (threePoints) threePoints.geometry.attributes.color.needsUpdate = true;
}

function animate() {
  requestAnimationFrame(animate);
  threeControls.update();
  threeRenderer.render(threeScene, threeCamera);
}

function onResize() {
  const w = document.getElementById("canvas-wrapper");
  threeRenderer.setSize(w.clientWidth, w.clientHeight);
  threeCamera.aspect = w.clientWidth / w.clientHeight;
  threeCamera.updateProjectionMatrix();
}

// ─── Click / select ───────────────────────────
function onCanvasClick(e) {
  if (!threePoints) return;

  const rect  = threeRenderer.domElement.getBoundingClientRect();
  const mouse = new THREE.Vector2(
    ((e.clientX - rect.left) / rect.width)  *  2 - 1,
    ((e.clientY - rect.top)  / rect.height) * -2 + 1,
  );

  const ray = new THREE.Raycaster();
  ray.params.Points = { threshold: 0.15 };
  ray.setFromCamera(mouse, threeCamera);

  const hits = ray.intersectObject(threePoints);
  if (!hits.length) {
    if (!e.shiftKey) { selected.clear(); refreshColors(); updateInfoPanel(); }
    return;
  }

  const rec = visibleRecordings[hits[0].index];
  if (e.shiftKey) {
    if (selected.has(rec.id)) selected.delete(rec.id);
    else selected.add(rec.id);
  } else {
    if (selected.size === 1 && selected.has(rec.id)) selected.clear();
    else { selected.clear(); selected.add(rec.id); }
  }

  refreshColors();
  updateInfoPanel();
}

// ─── Legend ───────────────────────────────────
function buildLegend(tricks) {
  const el = document.getElementById("legend");
  [...el.querySelectorAll(".legend-item")].forEach(n => n.remove());

  for (const t of tricks) {
    const hex = PALETTE[trickColorIdx[t]].toString(16).padStart(6, "0");
    const item = document.createElement("div");
    item.className = "legend-item";
    item.dataset.trick = t;
    item.innerHTML = `<span class="legend-dot" style="background:#${hex}"></span><span>${esc(t)}</span>`;
    item.addEventListener("click", () => selectByTrick(t));
    el.appendChild(item);
  }

  el.classList.remove("hidden");
}

function selectByTrick(trick) {
  selected.clear();
  for (const r of visibleRecordings) if (r.trick === trick) selected.add(r.id);
  refreshColors();
  updateInfoPanel();
}

// ─── Filters ──────────────────────────────────
function buildFilters(tricks, collectors) {
  buildCheckGroup("filter-tricks", tricks, hiddenTricks, "filter-tricks-count");
  buildCheckGroup("filter-collectors", collectors, hiddenCollectors, "filter-collectors-count");
  document.getElementById("filter-toggle").classList.remove("hidden");
}

function buildCheckGroup(containerId, items, hiddenSet, countId) {
  const el = document.getElementById(containerId);
  el.innerHTML = "";

  const updateCount = () => {
    const hidden = items.filter(i => hiddenSet.has(i)).length;
    document.getElementById(countId).textContent = hidden ? `(${hidden} hidden)` : "";
  };

  for (const item of items) {
    const id = `chk-${containerId}-${item}`;
    const label = document.createElement("label");
    label.className = "filter-check-item";
    label.htmlFor = id;

    const chk = document.createElement("input");
    chk.type = "checkbox";
    chk.id = id;
    chk.checked = !hiddenSet.has(item);
    chk.addEventListener("change", () => {
      if (chk.checked) hiddenSet.delete(item);
      else { hiddenSet.add(item); selected.clear(); }
      updateCount();
      rebuildPoints();
      updateInfoPanel();
    });

    label.appendChild(chk);
    label.appendChild(document.createTextNode(item));
    el.appendChild(label);
  }

  updateCount();
}

// ─── Info panel ───────────────────────────────
function updateInfoPanel() {
  const listEl = document.getElementById("info-list");
  const btnDel = document.getElementById("btn-delete");
  const hint   = document.getElementById("info-hint");

  if (!selected.size) {
    listEl.innerHTML = "";
    btnDel.classList.add("hidden");
    hint.style.display = "";
    return;
  }

  hint.style.display = "none";
  const selRecs = recordings.filter(r => selected.has(r.id));

  listEl.innerHTML = selRecs.map(r => {
    const date = r.created_at ? r.created_at.slice(0, 10) : "?";
    return `
    <div class="info-item">
      <span class="info-trick">${esc(r.trick)}</span>
      <span class="info-meta">${esc(r.collector)} · ${(r.duration_ms / 1000).toFixed(1)}s · ${r.sample_count} samples · ${date}</span>
    </div>`;
  }).join("");

  btnDel.classList.remove("hidden");
  btnDel.textContent = `Delete ${selRecs.length} recording${selRecs.length > 1 ? "s" : ""}`;
  btnDel.disabled = false;
}

// ─── Delete ───────────────────────────────────
async function deleteSelected() {
  const ids = [...selected];
  if (!ids.length) return;

  const btn = document.getElementById("btn-delete");
  btn.disabled = true;
  btn.textContent = "Deleting…";

  let failed = 0;
  for (const id of ids) {
    try {
      const resp = await apiFetch(`/lab/api/recordings/${encodeURIComponent(id)}`, { method: "DELETE" });
      if (!resp.ok) failed++;
    } catch { failed++; }
  }

  showToast(failed
    ? `${failed} deletion${failed > 1 ? "s" : ""} failed`
    : `Deleted ${ids.length} recording${ids.length > 1 ? "s" : ""}`
  );

  await loadData();
}

// ─── Helpers ──────────────────────────────────
function setStatus(msg) {
  document.getElementById("status-bar").textContent = msg;
}

function showToast(msg) {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.classList.add("show");
  setTimeout(() => t.classList.remove("show"), 3000);
}

function esc(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// ─── Filter toggle ────────────────────────────
document.getElementById("filter-toggle").addEventListener("click", () => {
  const panel = document.getElementById("filter-panel");
  const btn   = document.getElementById("filter-toggle");
  const open  = panel.classList.toggle("hidden");
  btn.textContent = open ? "⚙ Filter" : "✕ Filter";
});

document.getElementById("btn-delete").addEventListener("click", deleteSelected);

// ─── Init ─────────────────────────────────────
async function init() {
  const t = getToken();
  if (!t) { redirectToLogin(); return; }

  const resp = await fetch("/game/api/auth/me", { headers: { "Authorization": "Bearer " + t } });
  if (!resp.ok) { redirectToLogin(); return; }

  const me = await resp.json();
  const statusEl = document.getElementById("auth-status");
  statusEl.textContent = "● " + (me.username || "admin");
  statusEl.classList.add("connected");

  await loadData();
}

init();
