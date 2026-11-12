# tools/export_db.py - exports the legacy SQLite DB to JSON for migration
# into IndexedDB. Run: python tools/export_db.py
import json
import sqlite3
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent  # project root, no absolute paths
DB_PATH = ROOT / "data" / "bookly.db"


def export():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    out = {
        "books": [dict(r) for r in conn.execute("SELECT * FROM books")],
        "audio_tracks": [dict(r) for r in conn.execute("SELECT * FROM audio_tracks")],
        "progress": [dict(r) for r in conn.execute("SELECT * FROM progress")],
        "prefs": [dict(r) for r in conn.execute("SELECT * FROM settings WHERE key='prefs'")],
        "pages": {},
    }
    for book in out["books"]:
        pages_file = ROOT / "data" / "books" / f"{book['id']}_pages.json"
        if pages_file.exists():
            out["pages"][str(book["id"])] = json.loads(pages_file.read_text(encoding="utf-8")).get("pages", [])
    Path(ROOT / "data" / "export.json").write_text(json.dumps(out, ensure_ascii=False), encoding="utf-8")
    print(f"Exported {len(out['books'])} books to data/export.json")


if __name__ == "__main__":
    export()
