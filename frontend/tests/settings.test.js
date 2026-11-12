// Prompt 8 tests: settings validation, storage/cache clearing without touching
// progress, and backup export/import round-trip with schema validation.
// Run with: npm test (vitest + fake-indexeddb)

import { describe, it, expect, beforeEach } from "vitest";
import "fake-indexeddb/auto";

import { openDb, addBook, savePages, getPages, saveProgress, getProgress } from "../db.js";
import { validateSettings, updateSettings, resolveTheme } from "../settings.js";
import { exportBackup, validateBackup, importBackup } from "../backup.js";

describe("settings validation", () => {
  it("drops invalid keys and clamps the TTS rate", () => {
    const clean = validateSettings({
      ui_language: "pt-PT",
      theme: "sepia-invalid",   // not in THEMES -> dropped
      reader: { font_size: "huge", font_family: "serif" }, // huge invalid -> only family kept
      tts: { rate: 3.7, voice_name: "Google pt-PT" },      // clamped to 2
      personal_sources: { ispsn: true },
    });
    expect(clean.ui_language).toBe("pt-PT");
    expect(clean.theme).toBeUndefined();
    expect(clean.reader.font_family).toBe("serif");
    expect(clean.reader.font_size).toBeUndefined();
    expect(clean.tts.rate).toBe(2);
    expect(clean.personal_sources.ispsn).toBe(true);
  });

  it("personal sources stay OFF unless explicitly enabled", () => {
    const clean = validateSettings({ personal_sources: {} });
    expect(clean.personal_sources.ispsn).toBe(false);
  });

  it("resolveTheme maps auto to prefers-color-scheme", () => {
    expect(resolveTheme("dark", { matches: false })).toBe("dark");
    expect(resolveTheme("light", { matches: true })).toBe("light");
    expect(resolveTheme("auto", { matches: true })).toBe("dark");
    expect(resolveTheme("auto", { matches: false })).toBe("light");
  });

  it("updateSettings persists validated values in IndexedDB", async () => {
    await openDb();
    const saved = await updateSettings({ theme: "dark", tts: { rate: 1.5 } });
    expect(saved.theme).toBe("dark");
    expect(saved.tts.rate).toBe(1.5);
  });
});

describe("clearing cached text keeps progress", () => {
  beforeEach(async () => { await openDb(); });

  it("deletePagesOnly removes pages but not the read progress", async () => {
    const book = await addBook({ source: "local", source_id: "cache1", title: "Cache Test", author: "", language: "en", kind: "text" });
    await savePages(book.id, ["page one.", "page two."]);
    await saveProgress(book.id, "read", { position: 1, chapter_index: 0, percent: 1 });

    const { deletePagesOnly } = await import("../db.js");
    await deletePagesOnly(book.id);

    expect(await getPages(book.id)).toEqual([]);
    const rows = await getProgress(book.id);
    const read = rows.find((r) => r.mode === "read");
    expect(read).toBeTruthy();
    expect(read.position).toBe(1); // progress preserved after clearing text
  });

  it("deleteAllPages clears every book's text but keeps all progress", async () => {
    const a = await addBook({ source: "local", source_id: "a", title: "A", author: "", language: "en", kind: "text" });
    const b = await addBook({ source: "local", source_id: "b", title: "B", author: "", language: "en", kind: "text" });
    await savePages(a.id, ["a1."]);
    await savePages(b.id, ["b1."]);
    await saveProgress(a.id, "read", { position: 0, chapter_index: 0, percent: 1 });

    const { deleteAllPages } = await import("../db.js");
    await deleteAllPages();

    expect(await getPages(a.id)).toEqual([]);
    expect(await getPages(b.id)).toEqual([]);
    const rowsA = await getProgress(a.id);
    expect(rowsA.length).toBe(1); // progress untouched
  });
});

// fake-indexeddb keeps one "bookly" DB across tests in a file; clear stores so
// each test starts from a known state (isolation, not a change to expectations).
async function clearStores() {
  const db = await openDb();
  for (const name of ["books", "audio_tracks", "progress", "prefs", "pages"]) {
    await new Promise((res, rej) => {
      const t = db.transaction(name, "readwrite");
      t.objectStore(name).clear();
      t.oncomplete = () => res();
      t.onerror = (e) => rej(e.target.error);
    });
  }
}

describe("backup export/import round-trip", () => {
  beforeEach(async () => { await clearStores(); });

  it("export then import preserves books, pages and progress (no loss)", async () => {
    const book = await addBook({ source: "gutenberg", source_id: "1342", title: "Pride", author: "Austen", language: "en", kind: "both" });
    await savePages(book.id, ["p1.", "p2.", "p3."]);
    await saveProgress(book.id, "read", { position: 2, chapter_index: 0, percent: 1 });

    const dump = await exportBackup();
    expect(dump.books.length).toBe(1);
    // ISPSN book flagged personal; this one is not.
    expect(dump.books[0].personal).toBe(false);

    const validation = validateBackup(dump);
    expect(validation.ok).toBe(true);
    expect(validation.preview.books).toBe(1);

    await importBackup(dump);
    const pages = await getPages(book.id);
    expect(pages.length).toBe(3);
    const rows = await getProgress(book.id);
    const read = rows.find((r) => r.mode === "read");
    expect(read.position).toBe(2);
  });

  it("marks ISPSN books as personal in the export", async () => {
    const book = await addBook({ source: "ispsn", source_id: "x", title: "Personal", author: "", language: "pt", kind: "text" });
    const dump = await exportBackup();
    expect(dump.books.find((b) => b.id === book.id).personal).toBe(true);
  });

  it("rejects an invalid backup file with clear errors", () => {
    const bad = validateBackup({ books: "not-a-list" });
    expect(bad.ok).toBe(false);
    expect(bad.errors.length).toBeGreaterThan(0);

    const empty = validateBackup(null);
    expect(empty.ok).toBe(false);
  });

  it("importBackup throws on invalid data instead of wiping stores", async () => {
    await openDb();
    const book = await addBook({ source: "local", source_id: "keep", title: "Keep Me", author: "", language: "en", kind: "text" });
    let threw = false;
    try {
      await importBackup({ books: [], audio_tracks: [], progress: [], pages: [] }); // prefs missing -> invalid
    } catch (err) {
      threw = true;
    }
    expect(threw).toBe(true);
    // The original book is still there because nothing was written.
    const { getBook } = await import("../db.js");
    expect(await getBook(book.id)).toBeTruthy();
  });
});
