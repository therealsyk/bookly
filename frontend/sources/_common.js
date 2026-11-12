import { CONFIG, proxied } from "../config.js";

// Shared fetch with timeout + optional CORS proxy (only when configured).
export async function fetchJson(url, opts = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeout || CONFIG.SOURCE_TIMEOUT_MS);
  try {
    const res = await fetch(proxied(url), { signal: controller.signal, headers: opts.headers });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchText(url, opts = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeout || CONFIG.SOURCE_TIMEOUT_MS);
  try {
    const res = await fetch(proxied(url), { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

// ISO 639-1 UI language -> per-source language code.
export function langCode(iso, source) {
  const base = (iso || "en").split("-")[0];
  if (source === "archive") return base === "pt" ? "por" : base; // Archive uses ISO 639-2 for languages
  return base;
}
