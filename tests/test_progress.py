"""Tests for the progress router and the reader pages endpoint (Phase 3)."""

import json

from fastapi import FastAPI
from fastapi.testclient import TestClient

from backend.config import BOOKS_DIR
from backend.db import add_book, get_progress
from backend.routers.library import router as library_router
from backend.routers.progress import router as progress_router


def make_app() -> FastAPI:
    app = FastAPI()
    app.include_router(progress_router)
    app.include_router(library_router)
    return app


client = TestClient(make_app())


def _add_text_book(title="Test Book") -> int:
    book = add_book(source="gutenberg", source_id=f"test-{title}", title=title, kind="text")
    return book["id"]


def test_put_progress_upserts_read_mode():
    book_id = _add_text_book("Progress A")
    client.put(f"/api/progress/{book_id}", json={"mode": "read", "position": 5, "percent": 0.25})
    client.put(f"/api/progress/{book_id}", json={"mode": "read", "position": 9, "percent": 0.45})
    row = get_progress(book_id, "read")
    assert row["position"] == 9
    assert row["percent"] == 0.45


def test_put_progress_rejects_bad_mode():
    book_id = _add_text_book("Progress B")
    resp = client.put(f"/api/progress/{book_id}", json={"mode": "video", "position": 1})
    assert resp.status_code == 400


def test_get_progress_returns_rows():
    book_id = _add_text_book("Progress C")
    client.put(f"/api/progress/{book_id}", json={"mode": "read", "position": 3, "percent": 0.1})
    client.put(f"/api/progress/{book_id}", json={"mode": "listen", "position": 42.5, "chapter_index": 2, "percent": 0.3})
    data = client.get(f"/api/progress/{book_id}").json()
    modes = {r["mode"] for r in data["progress"]}
    assert modes == {"read", "listen"}


def test_pages_endpoint_returns_saved_current_page():
    book_id = _add_text_book("Pages D")
    pages_file = BOOKS_DIR / f"{book_id}_pages.json"
    pages_file.write_text(json.dumps({"pages": ["Page one.", "Page two.", "Page three."]}), encoding="utf-8")
    client.put(f"/api/progress/{book_id}", json={"mode": "read", "position": 2, "percent": 1.0})
    data = client.get(f"/api/library/pages/{book_id}").json()
    assert len(data["pages"]) == 3
    assert data["current_page"] == 2


def test_pages_endpoint_404_without_text():
    book_id = _add_text_book("No Pages E")
    resp = client.get(f"/api/library/pages/{book_id}")
    assert resp.status_code == 404
