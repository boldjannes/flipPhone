"use strict";

import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

// ── Quaternion math [w, x, y, z] ──────────────

export function qMul(a, b) {
  return [
    a[0]*b[0]-a[1]*b[1]-a[2]*b[2]-a[3]*b[3],
    a[0]*b[1]+a[1]*b[0]+a[2]*b[3]-a[3]*b[2],
    a[0]*b[2]-a[1]*b[3]+a[2]*b[0]+a[3]*b[1],
    a[0]*b[3]+a[1]*b[2]-a[2]*b[1]+a[3]*b[0],
  ];
}

export function qNorm(q) {
  const l = Math.sqrt(q[0]*q[0]+q[1]*q[1]+q[2]*q[2]+q[3]*q[3]);
  return l < 1e-10 ? [1,0,0,0] : [q[0]/l, q[1]/l, q[2]/l, q[3]/l];
}

export function qToMatrix(q) {
  const [w,x,y,z] = q;
  return [
    1-2*(y*y+z*z),   2*(x*y-z*w),   2*(x*z+y*w),
      2*(x*y+z*w), 1-2*(x*x+z*z),   2*(y*z-x*w),
      2*(x*z-y*w),   2*(y*z+x*w), 1-2*(x*x+y*y),
  ];
}

// ── Gyro integration ──────────────────────────

export function computeOrientations(samples) {
  const out = [[1,0,0,0]];
  for (let i = 1; i < samples.length; i++) {
    const dt = (samples[i].t - samples[i-1].t) / 1000;
    const {gx, gy, gz} = samples[i];
    const angle = Math.sqrt(gx*gx+gy*gy+gz*gz) * dt;
    let dq;
    if (angle < 1e-8) {
      dq = [1,0,0,0];
    } else {
      const ha = angle/2, sinHa = Math.sin(ha), omega = angle/dt;
      dq = [Math.cos(ha), gx/omega*sinHa, gy/omega*sinHa, gz/omega*sinHa];
    }
    out.push(qNorm(qMul(out[i-1], dq)));
  }
  return out;
}

export function getQAtTime(samples, orientations, time) {
  let idx = 0;
  for (let i = 0; i < samples.length-1; i++) {
    if (samples[i+1].t >= time) { idx = i; break; }
    idx = i;
  }
  const t0 = samples[idx].t;
  const t1 = idx+1 < samples.length ? samples[idx+1].t : t0;
  const frac = t1 > t0 ? (time-t0)/(t1-t0) : 0;
  const q0 = orientations[idx];
  const q1 = idx+1 < orientations.length ? orientations[idx+1] : q0;
  const sign = q0[0]*q1[0]+q0[1]*q1[1]+q0[2]*q1[2]+q0[3]*q1[3] < 0 ? -1 : 1;
  return qNorm([
    q0[0]+(sign*q1[0]-q0[0])*frac,
    q0[1]+(sign*q1[1]-q0[1])*frac,
    q0[2]+(sign*q1[2]-q0[2])*frac,
    q0[3]+(sign*q1[3]-q0[3])*frac,
  ]);
}

function _applyQ(pivot, q) {
  pivot.quaternion.set(q[1], q[2], q[3], q[0]);
}

// ── Three.js shared GLB ────────────────────────

const MODEL_URL = '/static/models/skateboard.glb';
let _gltfPromise = null;

function _loadModel() {
  if (!_gltfPromise) {
    const loader = new GLTFLoader();
    _gltfPromise = new Promise((resolve, reject) =>
      loader.load(MODEL_URL, resolve, undefined, reject)
    );
  }
  return _gltfPromise;
}

function _buildRenderer(canvas) {
  const W = canvas.clientWidth  || canvas.offsetWidth  || 200;
  const H = canvas.clientHeight || canvas.offsetHeight || 200;

  const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true, premultipliedAlpha: false });
  renderer.setClearColor(0x000000, 0);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(W, H);

  const scene = new THREE.Scene();

  const camera = new THREE.PerspectiveCamera(42, W / H, 0.01, 100);
  camera.position.set(0, 0.6, 4);
  camera.lookAt(0, 0, 0);

  scene.add(new THREE.AmbientLight(0xffffff, 1.2));
  const key = new THREE.DirectionalLight(0xffffff, 1.8);
  key.position.set(2, 4, 3);
  scene.add(key);
  const fill = new THREE.DirectionalLight(0xffffff, 0.5);
  fill.position.set(-3, -1, -2);
  scene.add(fill);

  return { renderer, scene, camera };
}

// MODEL_ROTATION: adjust until board appears in correct neutral pose.
const MODEL_ROTATION = new THREE.Euler(Math.PI / 2, 0, 0);

function _cloneModel(gltf, scene) {
  const pivot = new THREE.Group();

  const model = gltf.scene.clone(true);
  const box   = new THREE.Box3().setFromObject(model);
  const size  = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const scale = 2.2 / Math.max(size.x, size.y, size.z);
  model.scale.setScalar(scale);
  model.position.copy(center.negate().multiplyScalar(scale));
  model.rotation.copy(MODEL_ROTATION);

  pivot.add(model);
  scene.add(pivot);
  return pivot;
}

// ── Controlled scene (review overlay / scrubbing) ─

export async function createPhoneScene(canvas) {
  const gltf = await _loadModel();
  const { renderer, scene, camera } = _buildRenderer(canvas);
  const model = _cloneModel(gltf, scene);

  return {
    render(q) {
      _applyQ(model, q);
      renderer.render(scene, camera);
    },
    resize() {
      const W = canvas.clientWidth  || canvas.offsetWidth;
      const H = canvas.clientHeight || canvas.offsetHeight;
      if (!W || !H) return;
      renderer.setSize(W, H);
      camera.aspect = W / H;
      camera.updateProjectionMatrix();
    },
    dispose() {
      renderer.dispose();
    },
  };
}

// ── Looping per-canvas animation ──────────────

export const _canvasAnims = new Map();

export async function startCanvasAnim(canvas, samples) {
  stopCanvasAnim(canvas);

  const gltf = await _loadModel();
  const { renderer, scene, camera } = _buildRenderer(canvas);
  const model = _cloneModel(gltf, scene);

  const orientations = computeOrientations(samples);
  const totalTime = samples.length > 0 ? samples[samples.length-1].t : 0;

  const st = {
    renderer, scene, camera, model,
    samples, orientations, totalTime,
    currentTime: 0, lastFrame: null, rafId: null,
  };
  _canvasAnims.set(canvas, st);

  function frame(now) {
    if (!_canvasAnims.has(canvas)) return;
    if (st.lastFrame !== null) {
      st.currentTime += (now - st.lastFrame) * 0.6;
      if (st.currentTime >= st.totalTime) st.currentTime = 0;
    }
    st.lastFrame = now;
    _applyQ(st.model, getQAtTime(st.samples, st.orientations, st.currentTime));
    st.renderer.render(st.scene, st.camera);
    st.rafId = requestAnimationFrame(frame);
  }
  st.rafId = requestAnimationFrame(frame);
}

export function stopCanvasAnim(canvas) {
  const st = _canvasAnims.get(canvas);
  if (st) {
    if (st.rafId) cancelAnimationFrame(st.rafId);
    st.renderer.dispose();
    _canvasAnims.delete(canvas);
  }
}
