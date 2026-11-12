// Bookly settings (Prompt 8) - everything stored on-device (IndexedDB prefs).
// No server URL, no environment variables. All visible strings come from the
// locale files via t() in the shell; this module only handles data + validation.

import { getPrefs, savePrefs } from "./db.js";

const FONT_SIZES = ["small", "normal", "large"];
const THEMES = ["light", "dark", "auto"];
const RATE_MIN = 0.5;
const RATE_MAX = 2;

function clampRate(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 1;
  return Math.min(RATE_MAX, Math.max(RATE_MIN, Math.round(n * 10) / 10));
}

// Normalise/validate a settings payload before persisting it.
export function validateSettings(payload) {
  const clean = {};
  if (typeof payload.ui_language === "string") clean.ui_language = payload.ui_language;
  if (Array.isArray(payload.genres)) clean.genres = payload.genres.filter((g) => typeof g === "string");
  if (Array.isArray(payload.book_languages)) clean.book_languages = payload.book_languages.filter((l) => typeof l === "string");
  if (["audio", "text", "both"].includes(payload.format)) clean.format = payload.format;
  if (Array.isArray(payload.authors)) clean.authors = payload.authors.filter((a) => typeof a === "string");

  if (payload.tts && typeof payload.tts === "object") {
    clean.tts = {
      voice_name: typeof payload.tts.voice_name === "string" ? payload.tts.voice_name : null,
      lang: typeof payload.tts.lang === "string" ? payload.tts.lang : "pt-PT",
      rate: clampRate(payload.tts.rate),
    };
  }

  if (payload.theme && THEMES.includes(payload.theme)) clean.theme = payload.theme;

  if (payload.reader && typeof payload.reader === "object") {
    const reader = {};
    if (FONT_SIZES.includes(payload.reader.font_size)) reader.font_size = payload.reader.font_size;
    if (["serif", "sans"].includes(payload.reader.font_family)) reader.font_family = payload.reader.font_family;
    if (THEMES.includes(payload.reader.theme)) reader.theme = payload.reader.theme;
    if (Object.keys(reader).length) clean.reader = reader;
  }

  if (payload.personal_sources && typeof payload.personal_sources === "object") {
    // Personal sources are OFF by default; only explicit booleans turn them on.
    clean.personal_sources = { ispsn: !!payload.personal_sources.ispsn };
  }

  if (typeof payload.onboarded === "boolean") clean.onboarded = payload.onboarded;
  return clean;
}

export async function getSettings() {
  return getPrefs();
}

export async function updateSettings(payload) {
  const clean = validateSettings(payload);
  return savePrefs(clean);
}

// Global theme (light/dark/auto). "auto" follows prefers-color-scheme.
export function resolveTheme(theme, mediaQuery) {
  if (theme === "dark") return "dark";
  if (theme === "light") return "light";
  // auto
  const prefersDark = mediaQuery && typeof mediaQuery.matches === "boolean" ? mediaQuery.matches : false;
  return prefersDark ? "dark" : "light";
}

export function applyTheme(theme) {
  const resolved = resolveTheme(theme || "auto", window.matchMedia("(prefers-color-scheme: dark)"));
  document.documentElement.dataset.theme = resolved;
  return resolved;
}

// --- Storage accounting -------------------------------------------------------

export async function storageEstimate() {
  if (!navigator.storage || !navigator.storage.estimate) return { usage: null, quota: null };
  const est = await navigator.storage.estimate();
  return { usage: est.usage ?? null, quota: est.quota ?? null };
}

// Count books and imported PDFs (source === "pdf").
export async function countBooks() {
  const { listBooks } = await import("./db.js");
  const books = await listBooks();
  return { total: books.length, pdfs: books.filter((b) => b.source === "pdf").length };
}

// Delete cached text (pages) for one book WITHOUT touching progress.
export async function clearBookText(bookId) {
  const db = await import("./db.js");
  return db.deletePagesOnly(bookId);
}

// Delete cached text for every book, keeping all progress records intact.
export async function clearAllText() {
  const db = await import("./db.js");
  return db.deleteAllPages();
}
