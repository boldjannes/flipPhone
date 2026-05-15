"use strict";

import { startCanvasAnim, stopCanvasAnim } from "../shared/phone-animation.js";

const TOKEN_KEY = 'fp_game_token';
function token() { return localStorage.getItem(TOKEN_KEY); }
function authH()  { return { Authorization: 'Bearer ' + token(), 'Content-Type': 'application/json' }; }
function esc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

function showLogin(err) {
  document.getElementById('login').style.display = 'flex';
  document.getElementById('app').style.display   = 'none';
  if (err) document.getElementById('login-error').textContent = err;
}
function showApp(username) {
  document.getElementById('login').style.display = 'none';
  document.getElementById('app').style.display   = 'block';
  if (username) document.getElementById('logged-in-as').textContent = username;
}
async function verifyAdmin(t) {
  const r = await fetch('/admin/api/users', { headers: { Authorization: 'Bearer ' + t } }).catch(() => null);
  return r && r.ok;
}

let pendingDelete = null;

function renderTricks(tricks) {
  document.querySelectorAll('.anim-canvas').forEach(c => stopCanvasAnim(c));
  const tbody = document.getElementById('tricks-tbody');
  if (!tricks.length) {
    tbody.innerHTML = '<tr><td colspan="5" class="table-msg">No tricks defined yet.</td></tr>';
    return;
  }
  tbody.innerHTML = tricks.map(t => `
    <tr class="trick-row" data-id="${esc(t.id)}">
      <td style="font-family:monospace;font-size:12px;color:var(--dim)">${esc(t.id)}</td>
      <td style="font-weight:700">${esc(t.name)}</td>
      <td class="cell-count">${t.recording_count}</td>
      <td class="cell-anim">
        ${t.reference
          ? `<canvas class="anim-canvas" data-trick="${esc(t.id)}" width="56" height="80"></canvas>`
          : `<div class="anim-placeholder">no ref</div>`}
      </td>
      <td style="text-align:right;padding-right:16px">
        <button class="btn btn-danger btn-sm delete-btn" data-id="${esc(t.id)}" data-name="${esc(t.name)}">Delete</button>
      </td>
    </tr>
  `).join('');
  tricks.forEach(t => {
    if (!t.reference || !t.reference.samples) return;
    const canvas = tbody.querySelector(`canvas[data-trick="${t.id}"]`);
    if (canvas) startCanvasAnim(canvas, t.reference.samples);
  });
  tbody.querySelectorAll('.delete-btn').forEach(btn => {
    btn.addEventListener('click', () => showDeleteConfirm(btn.dataset.id, btn.dataset.name));
  });
}

function showDeleteConfirm(id, name) {
  pendingDelete = id;
  document.getElementById('modal-trick-name').textContent = name;
  document.getElementById('confirm-modal').style.display = 'flex';
}
function hideModal() {
  pendingDelete = null;
  document.getElementById('confirm-modal').style.display = 'none';
}

async function loadAndRender() {
  const r = await fetch('/admin/api/tricks', { headers: authH() }).catch(() => null);
  if (r && r.ok) {
    renderTricks(await r.json());
  } else {
    document.getElementById('tricks-tbody').innerHTML =
      '<tr><td colspan="5" class="table-msg" style="color:var(--danger)">Failed to load tricks.</td></tr>';
  }
}

async function checkAuth() {
  const t = token();
  if (!t) { showLogin(); return; }
  if (await verifyAdmin(t)) {
    const me  = await fetch('/game/api/auth/me', { headers: { Authorization: 'Bearer ' + t } }).catch(() => null);
    const usr = (me && me.ok) ? (await me.json()).username : '';
    showApp(usr);
    loadAndRender();
  } else {
    localStorage.removeItem(TOKEN_KEY);
    showLogin();
  }
}

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('modal-cancel').addEventListener('click',  hideModal);
  document.getElementById('modal-cancel2').addEventListener('click', hideModal);
  document.getElementById('modal-confirm').addEventListener('click', async () => {
    if (!pendingDelete) return;
    const id = pendingDelete;
    hideModal();
    const r = await fetch(`/admin/api/tricks/${encodeURIComponent(id)}`, {
      method: 'DELETE', headers: authH(),
    }).catch(() => null);
    if (r && r.ok) {
      await loadAndRender();
    } else {
      const data = r ? await r.json().catch(()=>({})) : {};
      alert(data.error || 'Delete failed.');
    }
  });

  document.getElementById('add-form').addEventListener('submit', async e => {
    e.preventDefault();
    const errEl = document.getElementById('add-error');
    errEl.textContent = '';
    const id   = document.getElementById('new-id').value.trim();
    const name = document.getElementById('new-name').value.trim();
    if (!id || !name) { errEl.textContent = 'Both ID and Name are required.'; return; }
    const r = await fetch('/admin/api/tricks', {
      method: 'POST', headers: authH(),
      body: JSON.stringify({ id, name }),
    }).catch(() => null);
    const data = r ? await r.json().catch(()=>({})) : {};
    if (!r || !r.ok) { errEl.textContent = data.error || 'Failed to add trick.'; return; }
    document.getElementById('new-id').value   = '';
    document.getElementById('new-name').value = '';
    await loadAndRender();
  });

  document.getElementById('new-name').addEventListener('input', e => {
    const idEl = document.getElementById('new-id');
    if (!idEl.dataset.manuallyEdited) {
      idEl.value = e.target.value.trim().toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '');
    }
  });
  document.getElementById('new-id').addEventListener('input', e => {
    e.target.dataset.manuallyEdited = e.target.value ? '1' : '';
  });

  document.getElementById('login-form').addEventListener('submit', async e => {
    e.preventDefault();
    const errEl = document.getElementById('login-error');
    errEl.textContent = '';
    const fd = new FormData(e.target);
    const r  = await fetch('/game/api/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: fd.get('username'), password: fd.get('password') }),
    }).catch(() => null);
    if (!r) { errEl.textContent = 'Network error.'; return; }
    const data = await r.json();
    if (!r.ok) { errEl.textContent = data.error || 'Login failed.'; return; }
    localStorage.setItem(TOKEN_KEY, data.token);
    if (await verifyAdmin(data.token)) {
      const me = await fetch('/game/api/auth/me', { headers: { Authorization: 'Bearer ' + data.token } }).catch(() => null);
      const usr = (me && me.ok) ? (await me.json()).username : '';
      showApp(usr);
      loadAndRender();
    } else {
      localStorage.removeItem(TOKEN_KEY);
      errEl.textContent = 'Account does not have admin access.';
    }
  });

  document.getElementById('logout-btn').addEventListener('click', async () => {
    const t = token();
    if (t) {
      await fetch('/game/api/auth/logout', { method: 'POST', headers: { Authorization: 'Bearer ' + t } }).catch(() => {});
      localStorage.removeItem(TOKEN_KEY);
    }
    showLogin();
  });

  checkAuth();
});
