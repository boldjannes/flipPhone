"use strict";

// ─── Constants ────────────────────────────────
const CONFIG_KEY = "flipphone_config";

const PALETTE = [
  0x00e5ff, 0xff6b6b, 0x51cf66, 0xffd43b,
  0xcc5de8, 0xff922b, 0x74c0fc, 0xf783ac,
  0xa9e34b, 0x4dabf7, 0xffa94d, 0xe599f7,
];
const COLOR_SELECTED = 0xffffff;

// ─── State ────────────────────────────────────
let recordings = []; // [{id, trick, collector, duration_ms, sample_count, x, y, z}]
let selected = new Set();
let trickColorIdx = {}; // trick → palette index

let threeScene, threeCamera, threeRenderer, threeControls, threePoints;
let posArr, colorArr;

// ─── Config / Auth ────────────────────────────
function getConfig() {
  try { return JSON.parse(localStorage.getItem(CONFIG_KEY)) || {}; } catch { return {}; }
}

function setConfig(patch) {
  localStorage.setItem(CONFIG_KEY, JSON.stringify({ ...getConfig(), ...patch }));
}

function getApiKey() { return getConfig().apiKey || ""; }

async function apiFetch(path, opts = {}) {
  const headers = { "X-API-Key": getApiKey(), ...(opts.headers || {}) };
  const resp = await fetch(path, { ...opts, headers });
  if (resp.status === 401 || resp.status === 403) { showAuthModal(); throw new Error("Unauthorized"); }
  return resp;
}

function showAuthModal() {
  document.getElementById("auth-modal").classList.remove("hidden");
  const inp = document.getElementById("auth-key-input");
  inp.value = getApiKey();
  inp.focus();
}

function hideAuthModal() {
  document.getElementById("auth-modal").classList.add("hidden");
}

// ─── PCA (3 principal components) ────────────
function pca3d(matrix) {
  const n = matrix.length;
  const p = matrix[0].length;
  if (n < 2) return matrix.map((_, i) => [i * 0.5, 0, 0]);

  // Z-score standardize each feature
  const mean = Array(p).fill(0);
  const std  = Array(p).fill(0);
  for (const r of matrix) for (let j = 0; j < p; j++) mean[j] += r[j];
  for (let j = 0; j < p; j++) mean[j] /= n;
  for (const r of matrix) for (let j = 0; j < p; j++) std[j] += (r[j] - mean[j]) ** 2;
  for (let j = 0; j < p; j++) std[j] = Math.sqrt(std[j] / n) || 1;

  const X = matrix.map(r => r.map((v, j) => (v - mean[j]) / std[j]));

  // Correlation matrix C[i][j] = Σ_k X[k][i]·X[k][j] / n
  const C = Array.from({ length: p }, (_, i) =>
    Array.from({ length: p }, (_, j) =>
      X.reduce((s, r) => s + r[i] * r[j], 0) / n
    )
  );

  // Power iteration + Gram-Schmidt deflation for top-3 eigenvectors
  const dims = Math.min(3, p, n - 1);
  const vecs = [];
  for (let k = 0; k < dims; k++) {
    // Deterministic but varied seed per component
    let v = Array.from({ length: p }, (_, i) => Math.sin(i * 2.3 + k * 1.7));
    const initNorm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
    v = v.map(x => x / initNorm);

    for (let iter = 0; iter < 400; iter++) {
      // w = C · v
      const w = Array(p).fill(0);
      for (let i = 0; i < p; i++) for (let j = 0; j < p; j++) w[i] += C[i][j] * v[j];
      // Gram-Schmidt: remove components along already-found eigenvectors
      for (const u of vecs) {
        const dot = u.reduce((s, x, i) => s + x * w[i], 0);
        for (let i = 0; i < p; i++) w[i] -= dot * u[i];
      }
      const norm = Math.sqrt(w.reduce((s, x) => s + x * x, 0));
      if (norm < 1e-12) break;
      v = w.map(x => x / norm);
    }
    vecs.push(v);
  }

  // Project standardised data onto eigenvectors
  return X.map(r => {
    const proj = vecs.map(v => v.reduce((s, x, j) => s + x * r[j], 0));
    while (proj.length < 3) proj.push(0);
    return proj;
  });
}

// ─── Load + compute ───────────────────────────
async function loadData() {
  setStatus("Loading recordings…");
  document.getElementById("legend").classList.add("hidden");
  selected.clear();
  updateInfoPanel();

  let resp;
  try { resp = await apiFetch("/lab/api/embeddings"); }
  catch { return; }

  if (!resp.ok) { setStatus("Failed to load data."); return; }

  const data = await resp.json();

  if (!data.length) {
    setStatus("No recordings in the database yet.");
    if (threeRenderer) threeRenderer.domElement.style.opacity = "0";
    return;
  }

  setStatus(`Computing PCA for ${data.length} recording${data.length > 1 ? "s" : ""}…`);

  // Assign palette colors per trick
  const tricks = [...new Set(data.map(d => d.trick))].sort();
  trickColorIdx = {};
  tricks.forEach((t, i) => { trickColorIdx[t] = i % PALETTE.length; });

  // PCA
  let coords;
  try { coords = pca3d(data.map(d => d.features)); }
  catch { coords = data.map((_, i) => [i * 0.1, 0, 0]); }

  recordings = data.map((d, i) => ({
    id: d.id,
    trick: d.trick,
    collector: d.collector,
    duration_ms: d.duration_ms,
    sample_count: d.sample_count,
    x: coords[i][0],
    y: coords[i][1],
    z: coords[i][2],
  }));

  setStatus("");
  if (!threeRenderer) buildScene();
  else rebuildPoints();

  buildLegend(tricks);
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

  threeControls = new THREE.OrbitControls(threeCamera, threeRenderer.domElement);
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

  const n = recordings.length;
  posArr   = new Float32Array(n * 3);
  colorArr = new Float32Array(n * 3);

  for (let i = 0; i < n; i++) {
    posArr[i*3]   = recordings[i].x;
    posArr[i*3+1] = recordings[i].y;
    posArr[i*3+2] = recordings[i].z;
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
    : (PALETTE[trickColorIdx[recordings[i].trick] ?? 0]);
  colorArr[i*3]   = ((hex >> 16) & 0xff) / 255;
  colorArr[i*3+1] = ((hex >>  8) & 0xff) / 255;
  colorArr[i*3+2] = ( hex        & 0xff) / 255;
}

function refreshColors() {
  for (let i = 0; i < recordings.length; i++) {
    writeColor(i, selected.has(recordings[i].id));
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

  const rec = recordings[hits[0].index];
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
  const title = el.querySelector(".legend-title");
  // Remove existing items but keep title
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
  for (const r of recordings) if (r.trick === trick) selected.add(r.id);
  refreshColors();
  updateInfoPanel();
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

  listEl.innerHTML = selRecs.map(r => `
    <div class="info-item">
      <span class="info-trick">${esc(r.trick)}</span>
      <span class="info-meta">${esc(r.collector)} · ${(r.duration_ms / 1000).toFixed(1)}s · ${r.sample_count} samples</span>
    </div>
  `).join("");

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

// ─── Auth wiring ──────────────────────────────
document.getElementById("auth-submit").addEventListener("click", async () => {
  const key = document.getElementById("auth-key-input").value.trim();
  if (!key) return;
  setConfig({ apiKey: key });
  hideAuthModal();
  await init();
});

document.getElementById("auth-key-input").addEventListener("keydown", e => {
  if (e.key === "Enter") document.getElementById("auth-submit").click();
});

document.getElementById("btn-delete").addEventListener("click", deleteSelected);

// ─── Init ─────────────────────────────────────
async function init() {
  const key = getApiKey();
  if (!key) { showAuthModal(); return; }

  const resp = await fetch("/lab/api/me", { headers: { "X-API-Key": key } });
  if (!resp.ok) { showAuthModal(); return; }

  const me = await resp.json();
  const statusEl = document.getElementById("auth-status");
  statusEl.textContent = `● ${me.name}`;
  statusEl.classList.add("connected");

  await loadData();
}

init();
