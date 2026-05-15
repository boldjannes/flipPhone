"use strict";

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

// ── 3D rendering ──────────────────────────────

export function _project(p, m, cx, cy, scale, dist) {
  const rx = m[0]*p[0]+m[1]*p[1]+m[2]*p[2];
  const ry = m[3]*p[0]+m[4]*p[1]+m[5]*p[2];
  const rz = m[6]*p[0]+m[7]*p[1]+m[8]*p[2];
  const z  = dist + rz;
  const f  = dist / Math.max(z, 0.1);
  return [cx + rx*scale*f, cy - ry*scale*f, z];
}

export function drawPhone3D(ctx, W, H, q) {
  const m = qToMatrix(q);
  const cx = W/2, cy = H/2, scale = Math.min(W,H)*0.28, dist = 4;
  const pw=0.5, ph=1.0, pd=0.08;
  const hw=pw/2, hh=ph/2, hd=pd/2;
  const corners = [
    [-hw,-hh,-hd],[hw,-hh,-hd],[hw,hh,-hd],[-hw,hh,-hd],
    [-hw,-hh, hd],[hw,-hh, hd],[hw,hh, hd],[-hw,hh, hd],
  ];
  const proj = corners.map(p => _project(p, m, cx, cy, scale, dist));
  const faces = [
    {idx:[0,1,2,3], color:'#1a1a1a', screen:false},
    {idx:[4,5,6,7], color:'#2a2a2a', screen:true },
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
      const sc = [
        [-hw+inset*pw,-hh+inset*ph,hd+.001],[hw-inset*pw,-hh+inset*ph,hd+.001],
        [ hw-inset*pw, hh-inset*ph,hd+.001],[-hw+inset*pw, hh-inset*ph,hd+.001],
      ];
      const sp = sc.map(p => _project(p, m, cx, cy, scale, dist));
      ctx.beginPath(); ctx.moveTo(sp[0][0],sp[0][1]);
      for (let i=1;i<sp.length;i++) ctx.lineTo(sp[i][0],sp[i][1]);
      ctx.closePath(); ctx.fillStyle='#003344'; ctx.fill();
      const ny = -hh+inset*ph*1.5;
      const np = [[-0.04,ny,hd+.002],[0.04,ny,hd+.002]].map(p => _project(p,m,cx,cy,scale,dist));
      ctx.beginPath();
      ctx.arc((np[0][0]+np[1][0])/2, (np[0][1]+np[1][1])/2, 3, 0, Math.PI*2);
      ctx.fillStyle='#001a22'; ctx.fill();
    }
  }
}

// ── Looping per-canvas animation ──────────────

export const _canvasAnims = new Map();

export function startCanvasAnim(canvas, samples) {
  const ori = computeOrientations(samples);
  const totalTime = samples.length > 0 ? samples[samples.length-1].t : 0;
  const st = { samples, ori, totalTime, currentTime: 0, lastFrame: null, rafId: null };
  _canvasAnims.set(canvas, st);

  function frame(now) {
    if (!st.rafId) return;
    if (st.lastFrame !== null) {
      st.currentTime += (now - st.lastFrame) * 0.6;
      if (st.currentTime >= st.totalTime) st.currentTime = 0;
    }
    st.lastFrame = now;
    const W = canvas.clientWidth  || canvas.width;
    const H = canvas.clientHeight || canvas.height;
    canvas.width  = W;
    canvas.height = H;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, W, H);
    if (ori.length >= 2) drawPhone3D(ctx, W, H, getQAtTime(st.samples, st.ori, st.currentTime));
    st.rafId = requestAnimationFrame(frame);
  }
  st.rafId = requestAnimationFrame(frame);
}

export function stopCanvasAnim(canvas) {
  const st = _canvasAnims.get(canvas);
  if (st && st.rafId) { cancelAnimationFrame(st.rafId); st.rafId = null; }
  _canvasAnims.delete(canvas);
}
