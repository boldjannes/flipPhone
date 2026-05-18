"use strict";

const DEFAULTS = {
  activation_threshold:   15,
  activation_pre_buf_ms:  200,
  activation_post_ms:     1400,
  activation_cooldown_ms: 1800,
  confidence_threshold:   0.80,
};

let _cache = null;

export async function fetchSettings() {
  if (_cache) return _cache;
  try {
    const r = await fetch("/game/api/settings");
    if (r.ok) _cache = { ...DEFAULTS, ...(await r.json()) };
  } catch (_) {}
  return _cache || { ...DEFAULTS };
}
