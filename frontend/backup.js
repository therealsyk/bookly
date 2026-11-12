// Bookly backup/restore (Prompt 8) - export all IndexedDB data to JSON and
// import it back with schema validation and a preview. Nothing is overwritten
// until the caller confirms; ISPSN books are flagged as personal in the export.

import { openDb } from "./db.js";

const STORES = ["books", "audio_tracks", "progress", "prefs", "pages"];

function getAllFrom(db, name) {
  return new Promise((resolve, reject) => {
    const req = db.transaction(name).objectStore(name).getAll();
    req.onsuccess = (e) => resolve(e.target.result || []);
    req.onerror = (e) => reject(e.target.error);
  });
}

export async function exportBackup() {
  const db = await openDb();
  const dump = { version: 1, exported_at: new Date().toISOString() };
  for (const name of STORES) {
    dump[name] = await getAllFrom(db, name);
  }
  // Flag personal (ISPSN) books so shared backups warn about them.
  dump.books = dump.books.map((b) => ({ ...b, personal: b.source === "ispsn" ? true : !!b.personal }));
  return dump;
}

// Validate the structure of a backup file. Returns { ok, errors, preview }.
export function validateBackup(data) {
  const errors = [];
  if (!data || typeof data !== "object") {
    return { ok: false, errors: ["Ficheiro de backup inválido (não é um objeto JSON)."], preview: null };
  }
  for (const name of STORES) {
    if (!(name in data)) {
      errors.push(`Secção em falta: "${name}".`);
      continue;
    }
    if (name === "prefs") {
      if (!Array.isArray(data[name])) errors.push(`"${name}" deve ser uma lista.`);
    } else if (!Array.isArray(data[name])) {
      errors.push(`"${name}" deve ser uma lista.`);
    }
  }
  // pages can be an object keyed by book_id or a list of {book_id, pages}.
  const preview = {
    books: Array.isArray(data.books) ? data.books.length : 0,
    audio_tracks: Array.isArray(data.audio_tracks) ? data.audio_tracks.length : 0,
    progress: Array.isArray(data.progress) ? data.progress.length : 0,
    pages: data.pages ? (Array.isArray(data.pages) ? data.pages.length : Object.keys(data.pages).length) : 0,
    personal_books: Array.isArray(data.books) ? data.books.filter((b) => b.source === "ispsn" || b.personal).length : 0,
  };
  return { ok: errors.length === 0, errors, preview };
}

// Import a validated backup into IndexedDB. Replaces the existing stores.
export async function importBackup(data) {
  const validation = validateBackup(data);
  if (!validation.ok) throw new Error(validation.errors.join("; "));
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORES, "readwrite");
    // keyPath stores (id / book_id): put(record) uses the record's own key when
    // present, so ids survive the round-trip (auto-increment only applies when the
    // key is missing). "progress" has keyPath "id" and records carry it.
    for (const b of data.books || []) t.objectStore("books").put(b);
    for (const tr of data.audio_tracks || []) t.objectStore("audio_tracks").put(tr);
    for (const p of data.progress || []) t.objectStore("progress").put(p);
    for (const s of data.prefs || []) {
      const value = typeof s.value === "string" ? JSON.parse(s.value) : s.value;
      t.objectStore("prefs").put({ key: s.key, value });
    }
    const pagesObj = data.pages || {};
    if (Array.isArray(pagesObj)) {
      for (const rec of pagesObj) t.objectStore("pages").put(rec);
    } else {
      for (const [bookId, pages] of Object.entries(pagesObj)) {
        t.objectStore("pages").put({ book_id: Number(bookId), pages });
      }
    }
    t.oncomplete = () => resolve(validation.preview);
    t.onerror = (e) => reject(e.target.error);
  });
}
