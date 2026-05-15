"use strict";

export const AUTH_API = "/game/api/auth";
export const TOKEN_KEY = "fp_game_token";
export const USER_KEY = "fp_game_user";

// ──────────────────────────────────────────────
// Storage
// ──────────────────────────────────────────────
export function getToken() {
  return localStorage.getItem(TOKEN_KEY);
}

export function setSession(token, user) {
  localStorage.setItem(TOKEN_KEY, token);
  localStorage.setItem(USER_KEY, JSON.stringify(user));
}

export function clearSession() {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
}

export function getCachedUser() {
  try {
    return JSON.parse(localStorage.getItem(USER_KEY));
  } catch {
    return null;
  }
}

// ──────────────────────────────────────────────
// API calls
// ──────────────────────────────────────────────
export async function authFetch(path, opts = {}) {
  const headers = { "Content-Type": "application/json", ...(opts.headers || {}) };
  const token = getToken();
  if (token) headers["Authorization"] = `Bearer ${token}`;
  return fetch(AUTH_API + path, { ...opts, headers });
}

export async function register(username, password, displayName) {
  const body = { username, password };
  if (displayName) body.display_name = displayName;
  const resp = await authFetch("/register", {
    method: "POST",
    body: JSON.stringify(body),
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error(data.error || `Error ${resp.status}`);
  setSession(data.token, data.user);
  return data;
}

export async function login(username, password) {
  const resp = await authFetch("/login", {
    method: "POST",
    body: JSON.stringify({ username, password }),
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error(data.error || `Error ${resp.status}`);
  setSession(data.token, data.user);
  return data;
}

export async function logout() {
  await authFetch("/logout", { method: "POST" }).catch(() => {});
  clearSession();
}

export async function getCurrentUser() {
  const resp = await authFetch("/me");
  if (!resp.ok) {
    clearSession();
    return null;
  }
  const user = await resp.json();
  localStorage.setItem(USER_KEY, JSON.stringify(user));
  return user;
}

export async function checkUsername(username) {
  const resp = await authFetch("/check-username", {
    method: "POST",
    body: JSON.stringify({ username }),
  });
  return resp.json();
}

export function isLoggedIn() {
  return !!getToken();
}

// ──────────────────────────────────────────────
// UI
// ──────────────────────────────────────────────
export const $ = (id) => document.getElementById(id);

export function showAuth() {
  $("auth-screen").classList.remove("hidden");
  $("app-shell").classList.add("hidden");
  switchTab("login");
}

export function switchTab(tab) {
  document.querySelectorAll(".auth-tab-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.tab === tab);
  });
  $("login-form").classList.toggle("hidden", tab !== "login");
  $("register-form").classList.toggle("hidden", tab !== "register");
  clearErrors();
}

export function clearErrors() {
  document.querySelectorAll(".auth-error").forEach((el) => (el.textContent = ""));
}

export function setError(formId, msg) {
  const el = document.querySelector(`#${formId} .auth-error`);
  if (el) el.textContent = msg;
}

export function setLoading(btn, loading) {
  btn.disabled = loading;
  btn.dataset.origText = btn.dataset.origText || btn.textContent;
  btn.textContent = loading ? "..." : btn.dataset.origText;
}

// ──────────────────────────────────────────────
// Username live check (debounced)
// ──────────────────────────────────────────────
export let checkTimer = null;
export function setupUsernameCheck() {
  const input = $("reg-username");
  const hint = $("reg-username-hint");
  if (!input || !hint) return;

  input.addEventListener("input", () => {
    const val = input.value.trim().toLowerCase();
    clearTimeout(checkTimer);
    hint.textContent = "";
    hint.className = "field-hint";

    if (val.length < 3) {
      if (val.length > 0) {
        hint.textContent = "Min. 3 characters";
        hint.classList.add("hint-error");
      }
      return;
    }
    if (!/^[a-z0-9_]+$/.test(val)) {
      hint.textContent = "Only a-z, 0-9, _";
      hint.classList.add("hint-error");
      return;
    }
    if (val.length > 20) {
      hint.textContent = "Max. 20 characters";
      hint.classList.add("hint-error");
      return;
    }

    hint.textContent = "Checking...";
    checkTimer = setTimeout(async () => {
      try {
        const res = await checkUsername(val);
        if (input.value.trim().toLowerCase() !== val) return;
        if (res.available) {
          hint.textContent = "Available";
          hint.classList.add("hint-ok");
        } else {
          hint.textContent = res.reason || "Taken";
          hint.classList.add("hint-error");
        }
      } catch {
        hint.textContent = "";
      }
    }, 400);
  });
}

// ──────────────────────────────────────────────
// Form handlers
// ──────────────────────────────────────────────
export function setupForms() {
  // Tab switching
  document.querySelectorAll(".auth-tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => switchTab(btn.dataset.tab));
  });

  // Login
  $("login-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    clearErrors();
    const btn = $("login-btn");
    const username = $("login-username").value.trim();
    const password = $("login-password").value;
    if (!username || !password) {
      setError("login-form", "Fill in all fields");
      return;
    }
    setLoading(btn, true);
    try {
      await login(username, password);
      loadApp();
    } catch (err) {
      setError("login-form", err.message);
    } finally {
      setLoading(btn, false);
    }
  });

  // Register
  $("register-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    clearErrors();
    const btn = $("register-btn");
    const username = $("reg-username").value.trim();
    const password = $("reg-password").value;
    const confirm = $("reg-confirm").value;
    const displayName = $("reg-display-name").value.trim();

    if (!username || !password) {
      setError("register-form", "Fill in all fields");
      return;
    }
    if (password !== confirm) {
      setError("register-form", "Passwords don't match");
      return;
    }
    if (password.length < 8) {
      setError("register-form", "Password must be at least 8 characters");
      return;
    }

    setLoading(btn, true);
    try {
      await register(username, password, displayName || null);
      loadApp();
    } catch (err) {
      setError("register-form", err.message);
    } finally {
      setLoading(btn, false);
    }
  });

  setupUsernameCheck();
}

// ──────────────────────────────────────────────
// App shell
// ──────────────────────────────────────────────
export function loadApp() {
  $("auth-screen").classList.add("hidden");
  $("app-shell").classList.remove("hidden");

  const user = getCachedUser();
  const nameEl = $("user-display-name");
  if (nameEl && user) {
    nameEl.textContent = user.display_name || user.username;
  }
}

export async function init() {
  setupForms();

  if (!isLoggedIn()) {
    showAuth();
    return;
  }

  // Verify stored token
  const user = await getCurrentUser();
  if (!user) {
    showAuth();
    return;
  }

  loadApp();
}

document.addEventListener("DOMContentLoaded", init);
