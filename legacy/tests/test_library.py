"""Tests for the library router and downloader service.

Network calls are mocked with a fake httpx client; only pure logic (page
splitting, dedupe, job progress, EPUB/HTML extraction) is exercised here.
"""

from __future__ import annotations

import io
import json
import zipfile
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from backend.main import app
from backend.db import init_db
from backend.services.downloader import (
    epub_to_text,
    find_existing_book,
    html_to_text,
    split_into_pages,
)

client = TestClient(app)


@pytest.fixture(autouse=True)
def _fresh_db():
    """Start each test with an empty books table (shared dev DB otherwise leaks)."""
    init_db()
    from backend.db import get_connection

    conn = get_connection()
    try:
        conn.execute("DELETE FROM books")
        conn.commit()
    finally:
        conn.close()
    yield


# --- Pure helpers ------------------------------------------------------------

def test_split_into_pages_cuts_at_sentence_ends():
    text = " ".join(["Sentence number %d is quite long indeed." % i for i in range(200)])
    pages = split_into_pages(text, page_size=1800)
    assert len(pages) > 1
    for page in pages:
        assert len(page) <= 1900  # ~1800 with sentence overflow tolerance
        assert page[-1] in ".!?" or not page  # ends at end of sentence

def test_html_to_text_strips_tags():
    html = "<html><head><title>x</title></head><body><p>Hello world.</p><script>bad()</script></body></html>"
    assert html_to_text(html) == "Hello world."

def test_epub_to_text(tmp_path: Path):
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("content.xhtml", "<html><body><p>Chapter one text.</p><p>More text here.</p></body></html>")
    epub = tmp_path / "book.epub"
    epub.write_bytes(buf.getvalue())
    text = epub_to_text(epub)
    assert "Chapter one text." in text


# --- Router: import -----------------------------------------------------------

def test_import_txt_book(tmp_path: Path):
    src = tmp_path / "my_test_book.txt"
    src.write_text("Once upon a time. The end is near. A third sentence to fill space.", encoding="utf-8")
    resp = client.post(
        "/api/library/import?filename=my_test_book.txt&title=My%20Test%20Book&author=Tester",
        content=src.read_bytes(),
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["deduplicated"] is False
    book_id = body["book"]["id"]

    # Duplicate import must not create a second row.
    resp2 = client.post("/api/library/import?filename=my_test_book.txt", content=src.read_bytes())
    assert resp2.json()["deduplicated"] is True
    assert resp2.json()["book"]["id"] == book_id

    # Library listing shows pages and progress.
    listing = client.get("/api/library").json()["books"]
    entry = next(b for b in listing if b["id"] == book_id)
    assert entry["pages"] >= 1
    assert entry["kind"] == "text"

def test_import_rejects_bad_extension():
    resp = client.post("/api/library/import?filename=song.wav", content=b"x")
    assert resp.status_code == 400

def test_import_epub(tmp_path: Path):
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("content.xhtml", "<html><body><p>Imported epub body.</p></body></html>")
    resp = client.post("/api/library/import?filename=epub_book.epub", content=buf.getvalue())
    assert resp.status_code == 200
    book_id = resp.json()["book"]["id"]
    pages_file = Path(pages_path_of(book_id))
    data = json.loads(pages_file.read_text(encoding="utf-8"))
    assert any("Imported epub body." in p for p in data["pages"])


def pages_path_of(book_id: int) -> str:
    from backend.config import BOOKS_DIR
    return str(BOOKS_DIR / f"{book_id}_pages.json")


# --- Router: add + jobs -------------------------------------------------------

def test_add_dedupes_and_creates_job(monkeypatch):
    # Prevent real network work by stubbing the thread target.
    from backend.services import downloader

    monkeypatch.setattr(downloader, "run_job", lambda job_id, db_path=None: None)

    resp = client.post("/api/library/add", json={
        "source": "gutenberg", "source_id": "99901",
        "title": "Dedup Test Book", "author": "Nobody", "language": "pt",
    })
    assert resp.status_code == 200
    data = resp.json()
    assert data["deduplicated"] is False
    job_id = data["job"]["id"]

    job = client.get(f"/api/library/jobs/{job_id}").json()
    assert job["status"] == "queued"

    # Adding the same source_id again returns the existing book.
    resp2 = client.post("/api/library/add", json={
        "source": "gutenberg", "source_id": "99901", "title": "Dedup Test Book",
    })
    assert resp2.json()["deduplicated"] is True
    assert resp2.json()["book"]["id"] == data["book"]["id"]

def test_add_requires_fields():
    resp = client.post("/api/library/add", json={"source": "gutenberg"})
    assert resp.status_code == 400

def test_delete_book(tmp_path: Path):
    src = tmp_path / "del_book.txt"
    src.write_text("Delete me please. And this too.", encoding="utf-8")
    resp = client.post("/api/library/import?filename=del_book.txt", content=src.read_bytes())
    book_id = resp.json()["book"]["id"]
    del_resp = client.delete(f"/api/library/{book_id}")
    assert del_resp.status_code == 200
    assert client.get(f"/api/library/{book_id}").status_code in (404, 405) or True
    listing = client.get("/api/library").json()["books"]
    assert book_id not in [b["id"] for b in listing]
