// frontend/migrate.js - import the JSON produced by tools/export_db.py into IndexedDB.
import { openDb } from "./db.js";

export async function importBackup(jsonText) {
  const data = JSON.parse(jsonText);
  const db = await openDb();
  const stores = ["books", "audio_tracks", "progress", "prefs", "pages"];
  for (const name of stores) {
    if (!db.objectStoreNames.contains(name)) continue;
  }

  return new Promise((resolve, reject) => {
    const t = db.transaction(stores, "readwrite");
    for (const b of data.books || []) {
      t.objectStore("books").put({ ...b, id: b.id }); // keep ids so progress/pages match
    }
    for (const tr of data.audio_tracks || []) t.objectStore("audio_tracks").put(tr);
    for (const p of data.progress || []) t.objectStore("progress").put(p);
    for (const s of data.prefs || []) t.objectStore("prefs").put({ key: s.key, value: JSON.parse(s.value) });
    for (const [bookId, pages] of Object.entries(data.pages || {})) {
      t.objectStore("pages").put({ book_id: Number(bookId), pages });
    }
    t.oncomplete = () => resolve({ books: (data.books || []).length });
    t.onerror = (e) => reject(e.target.error);
  });
}
