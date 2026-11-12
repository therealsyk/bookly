"""Quick end-to-end smoke check of the Bookly API (no pytest, just live calls)."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from fastapi.testclient import TestClient
from backend.main import app

c = TestClient(app)
print("health:", c.get("/api/health").json())

lib = c.get("/api/library").json()["books"]
print("library books:", len(lib))
for b in lib[:3]:
    bid = b["id"]
    audio = c.get(f"/api/audio/{bid}").json()
    pages = c.get(f"/api/library/pages/{bid}").json()
    prog = c.get(f"/api/progress/{bid}").json()
    print(f"- {b['title']} | kind={b['kind']} | cover={bool(b.get('cover_url'))} "
          f"| tracks={len(audio['tracks'])} | pages={pages.get('total', 0)} "
          f"| progress_modes={[p['mode'] for p in prog['progress']]}")

prefs = c.get("/api/prefs").json()
print("prefs keys:", sorted(prefs.keys()))
print("ui_language:", prefs.get("ui_language"))

# Frontend assets served?
for path in ("/", "/app.js", "/styles.css", "/pages/reader.js", "/pages/player.js",
             "/locales/pt-PT.json", "/locales/en.json", "/manifest.json"):
    print(path, "->", c.get(path).status_code)
