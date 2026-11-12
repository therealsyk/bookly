// IndexedDB store mirroring the SQLite schema of the legacy backend.
// Stores: books, audio_tracks, progress, prefs, search_cache, pages, jobs.
// (pages is the IndexedDB counterpart of data/books/<id>_pages.json.)

import { CONFIG } from "./config.js";

const DB_NAME = "bookly";
const DB_VERSION = 1;

let db = null;

export function openDb() {
  if (db) return Promise.resolve(db);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (ev) => {
      const d = ev.target.result;
      if (!d.objectStoreNames.contains("books")) {
        const s = d.createObjectStore("books", { keyPath: "id", autoIncrement: true });
        s.createIndex("source_key", ["source", "source_id"], { unique: false });
        s.createIndex("title", "title");
      }
      if (!d.objectStoreNames.contains("audio_tracks")) {
        const s = d.createObjectStore("audio_tracks", { keyPath: "id", autoIncrement: true });
        s.createIndex("book_id", "book_id");
      }
      if (!d.objectStoreNames.contains("progress")) {
        // Composite key (book_id, mode) encoded as a single string "book_id|mode"
        // so fake-indexeddb and all browsers derive it unambiguously.
        d.createObjectStore("progress", { keyPath: "id" });
      }
      if (!d.objectStoreNames.contains("prefs")) {
        d.createObjectStore("prefs", { keyPath: "key" });
      }
      if (!d.objectStoreNames.contains("search_cache")) {
        d.createObjectStore("search_cache", { keyPath: ["q", "lang"] });
      }
      if (!d.objectStoreNames.contains("pages")) {
        // {book_id, pages: [string...]} - one record per book.
        d.createObjectStore("pages", { keyPath: "book_id" });
      }
      if (!d.objectStoreNames.contains("jobs")) {
        d.createObjectStore("jobs", { keyPath: "id", autoIncrement: true });
      }
    };
    req.onsuccess = (ev) => {
      db = ev.target.result;
      resolve(db);
    };
    req.onerror = (ev) => reject(ev.target.error);
  });
}

function tx(store, mode = "readonly") {
  return db.transaction(store, mode).objectStore(store);
}

function put(store, value) {
  return new Promise((resolve, reject) => {
    const r = tx(store, "readwrite").put(value);
    r.onsuccess = () => resolve(r.result);
    r.onerror = (e) => reject(e.target.error);
  });
}

function getOne(store, key) {
  return new Promise((resolve, reject) => {
    const r = tx(store).get(key);
    r.onsuccess = () => resolve(r.result ?? null);
    r.onerror = (e) => reject(e.target.error);
  });
}

function getAll(store) {
  return new Promise((resolve, reject) => {
    const r = tx(store).getAll();
    r.onsuccess = () => resolve(r.result || []);
    r.onerror = (e) => reject(e.target.error);
  });
}

function del(store, key) {
  return new Promise((resolve, reject) => {
    const r = tx(store, "readwrite").delete(key);
    r.onsuccess = () => resolve();
    r.onerror = (e) => reject(e.target.error);
  });
}

function nowIso() {
  return new Date().toISOString();
}

// --- Books CRUD ---------------------------------------------------------------

export async function addBook({ source, source_id, title, author = "", language = "en", kind = "text", cover_url = null }) {
  const book = {
    // No id: autoIncrement assigns it (fake-indexeddb rejects an explicit
    // undefined key, real browsers accept it - omitting is correct per spec).
    source,
    source_id,
    title,
    author,
    language,
    cover_url, // served URL or remote URL (Open Library fallback)
    kind, // audio | text | both
    added_at: nowIso(),
  };
  // Return the full book object (with the auto-increment id) so callers can
  // use book.id directly.
  const key = await put("books", book);
  return { ...book, id: key };
}

export async function getBook(id) {
  return getOne("books", id);
}

export async function findBookBySource(source, source_id) {
  const books = await getAll("books");
  return books.find((b) => b.source === source && String(b.source_id) === String(source_id)) || null;
}

export async function findBookByTitle(title) {
  const needle = normalizeKey(title);
  const books = await getAll("books");
  return books.find((b) => normalizeKey(b.title) === needle) || null;
}

export async function listBooks({ search = "", kind = "", language = "" } = {}) {
  const books = await getAll("books");
  const progress = await getAll("progress");
  const progMap = new Map(progress.map((p) => [`${p.book_id}|${p.mode}`, p]));
  return books
    .filter((b) => {
      if (kind && b.kind !== kind) return false;
      if (language && b.language !== language) return false;
      if (search && !(b.title + " " + b.author).toLowerCase().includes(search.toLowerCase())) return false;
      return true;
    })
    .map((b) => {
      const read = progMap.get(`${b.id}|read`);
      const listen = progMap.get(`${b.id}|listen`);
      return { ...b, progress: read || listen || null };
    })
    .sort((a, b) => (b.added_at || "").localeCompare(a.added_at || ""));
}

export async function updateBook(id, fields) {
  const book = await getBook(id);
  if (!book) return null;
  Object.assign(book, fields);
  return put("books", book);
}

export async function deleteBook(id) {
  await del("books", id);
  await del("pages", id);
  const tracks = await getAll("audio_tracks");
  for (const tr of tracks) if (tr.book_id === id) await del("audio_tracks", tr.id);
  const progress = await getAll("progress");
  for (const p of progress) if (p.book_id === id) await del("progress", p.id);
}

// --- Progress ---------------------------------------------------------------

export async function saveProgress(book_id, mode, { position = 0, chapter_index = 0, percent = 0 }) {
  return put("progress", { id: `${book_id}|${mode}`, book_id, mode, position, chapter_index, percent, updated_at: nowIso() });
}

export async function getProgress(book_id) {
  const all = await getAll("progress");
  return all.filter((p) => p.book_id === book_id);
}

// --- Pages ---------------------------------------------------------------

export async function savePages(book_id, pages) {
  return put("pages", { book_id, pages, saved_at: nowIso() });
}

export async function getPages(book_id) {
  const rec = await getOne("pages", book_id);
  return rec ? rec.pages : [];
}

// --- Audio tracks ---------------------------------------------------------

export async function addTrack({ book_id, chapter_index = 0, title = "", url, duration_sec = null }) {
  return put("audio_tracks", { book_id, chapter_index, title, url, duration_sec });
}

export async function listTracks(book_id) {
  const tracks = await getAll("audio_tracks");
  return tracks.filter((t) => t.book_id === book_id).sort((a, b) => a.chapter_index - b.chapter_index);
}

// --- Prefs ---------------------------------------------------------------

const DEFAULT_PREFS = {
  ui_language: "auto",
  genres: [],
  book_languages: [],
  format: "both",
  authors: [],
  onboarded: false,
  sleep_minutes: null,
  speed: 1,
  reader: { font_size: 16, font_family: "serif", theme: "light" },
  personal_sources: { ispsn: false },
};

export async function getPrefs() {
  const rec = await getOne("prefs", "prefs");
  return { ...DEFAULT_PREFS, ...(rec ? rec.value : {}) };
}

export async function savePrefs(payload) {
  const current = await getPrefs();
  // Merge like the backend does: unknown/invalid keys are dropped, nested reader kept.
  const merged = { ...current };
  for (const key of Object.keys(DEFAULT_PREFS)) {
    if (key in payload && payload[key] !== undefined) merged[key] = payload[key];
  }
  await put("prefs", { key: "prefs", value: merged, updated_at: nowIso() });
  return merged;
}

// --- Search cache ---------------------------------------------------------

export async function cacheGet(q, lang) {
  const rec = await getOne("search_cache", [q, lang]);
  if (!rec) return null;
  if (Date.now() - new Date(rec.cached_at).getTime() > CONFIG.SEARCH_CACHE_TTL_MS) {
    await del("search_cache", [q, lang]);
    return null;
  }
  return rec.payload;
}

export async function cachePut(q, lang, payload) {
  return put("search_cache", { q, lang, payload, cached_at: nowIso() });
}

// --- Jobs (download progress) -------------------------------------------

export async function createJob(book_id, meta) {
  const job = { book_id, status: "queued", total_items: 0, done_items: 0, percent: 0, error: null, created_at: nowIso(), updated_at: nowIso(), ...meta };
  return put("jobs", job);
}

export async function getJob(id) {
  return getOne("jobs", id);
}

export async function updateJob(id, fields) {
  const job = await getJob(id);
  if (!job) return null;
  Object.assign(job, fields, { updated_at: nowIso() });
  return put("jobs", job);
}

export function normalizeKey(title) {
  // Same normalization as the backend merge key: lowercase, strip punctuation.
  return String(title || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}
