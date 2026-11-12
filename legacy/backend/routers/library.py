"""Library router: add, list, delete, job progress and local import.

Endpoints:
  POST   /api/library/add              {source, source_id, title?, author?, language?}
  GET    /api/library/jobs/{job_id}    background download progress
  GET    /api/library                  list with cover, progress %, current page
  DELETE /api/library/{book_id}        remove book + its files
  POST   /api/library/import           upload epub/txt/mp3/m4b from the user
"""

from __future__ import annotations

import json
import re
from pathlib import Path
from urllib.parse import quote
from typing import Optional

from fastapi import APIRouter, HTTPException, Query, Request

from backend.config import AUDIO_DIR, BOOKS_DIR, COVERS_DIR
from backend.db import delete_book, get_connection, list_books
from backend.services.downloader import (
    IMPORT_EXTENSIONS,
    add_book_from_source,
    get_job,
    import_local_file,
)

router = APIRouter(prefix="/api/library", tags=["library"])


def _progress_for(book_id: int, db_path: Optional[Path] = None) -> dict:
    """Best available progress across read/listen/tts modes."""
    conn = get_connection(db_path)
    try:
        rows = conn.execute(
            "SELECT mode, position, chapter_index, percent FROM progress WHERE book_id = ?",
            (book_id,),
        ).fetchall()
    finally:
        conn.close()
    best = {"mode": None, "position": 0.0, "chapter_index": 0, "percent": 0.0}
    for r in rows:
        if r["percent"] > best["percent"]:
            best = {"mode": r["mode"], "position": r["position"],
                   "chapter_index": r["chapter_index"], "percent": r["percent"]}
    return best


def _page_count(book_id: int) -> int:
    pages_file = BOOKS_DIR / f"{book_id}_pages.json"
    if pages_file.exists():
        try:
            return len(json.loads(pages_file.read_text(encoding="utf-8")).get("pages", []))
        except (json.JSONDecodeError, OSError):
            return 0
    return 0


@router.post("/add")
def api_add(payload: dict) -> dict:
    """Add a book from a search result and start background downloads."""
    source = payload.get("source")
    source_id = payload.get("source_id")
    if not source or not source_id:
        raise HTTPException(status_code=400, detail="source and source_id are required")
    result = add_book_from_source(
        source=source,
        source_id=str(source_id),
        title=payload.get("title") or "Untitled",
        author=payload.get("author"),
        language=payload.get("language"),
    )
    return result


@router.get("/jobs/{job_id}")
def api_job(job_id: int) -> dict:
    job = get_job(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="job not found")
    return job


@router.get("")
def api_library(search: Optional[str] = None, kind: Optional[str] = None,
                language: Optional[str] = None) -> dict:
    books = list_books(search=search, kind=kind, language=language)
    out = []
    for book in books:
        prog = _progress_for(book["id"])
        # Serve covers through /covers/<file> so the frontend never needs an
        # absolute path.
        if book.get("cover_path"):
            cover = f"/covers/{Path(book['cover_path']).name}"
        elif book.get("source_id"):
            # Open Library fallback so the library grid always shows a cover.
            cover = (f"https://covers.openlibrary.org/b/gutenberg/{book['source_id']}-M.jpg?default=false"
                     if book.get("source") == "gutenberg"
                     else f"https://covers.openlibrary.org/b/title/{quote(book['title'])}-M.jpg?default=false")
        else:
            cover = None
        out.append({
            "id": book["id"],
            "title": book["title"],
            "author": book["author"],
            "source": book["source"],
            "kind": book["kind"],
            "language": book["language"],
            "cover_url": cover,
            "pages": _page_count(book["id"]),
            "progress_percent": prog["percent"],
            "current_page": int(prog["position"]),
            "chapter_index": prog["chapter_index"],
            "position": prog["position"],
            "mode": prog["mode"],
            "added_at": book["added_at"],
        })
    return {"books": out}


@router.delete("/{book_id}")
def api_delete(book_id: int) -> dict:
    deleted = delete_book(book_id)
    if not deleted:
        raise HTTPException(status_code=404, detail="book not found")
    # Remove the book's files (cover, text/pages, audio).
    for pattern_dir in (COVERS_DIR, BOOKS_DIR, AUDIO_DIR):
        for f in pattern_dir.glob(f"{book_id}*"):
            try:
                f.unlink()
            except OSError:
                pass
    return {"deleted": True, "id": book_id}


@router.get("/pages/{book_id}")
def api_pages(book_id: int) -> dict:
    """Paginated text for the reader, plus the saved current page."""
    pages_file = BOOKS_DIR / f"{book_id}_pages.json"
    if not pages_file.exists():
        raise HTTPException(status_code=404, detail="no text pages for this book")
    try:
        pages = json.loads(pages_file.read_text(encoding="utf-8")).get("pages", [])
    except (json.JSONDecodeError, OSError):
        raise HTTPException(status_code=500, detail="corrupted pages file")
    prog = _progress_for(book_id)
    return {"book_id": book_id, "pages": pages, "current_page": int(prog["position"])}


@router.post("/import")
async def api_import(
    request: Request,
    filename: str = Query(..., description="Original file name (epub/txt/mp3/m4b)"),
    title: Optional[str] = Query(None),
    author: Optional[str] = Query(None),
    language: Optional[str] = Query(None),
) -> dict:
    """Import a user file as raw request body (no multipart dependency).

    The PWA sends the file bytes with fetch(..., {method: 'POST', body: file}).
    """
    ext = Path(filename).suffix.lower()
    if ext not in IMPORT_EXTENSIONS:
        raise HTTPException(status_code=400, detail=f"Unsupported file type: {ext}")
    data = await request.body()
    if not data:
        raise HTTPException(status_code=400, detail="empty file body")
    safe_stem = re.sub(r"[^\w-]+", "_", Path(filename).stem)[:60]
    dest = BOOKS_DIR / f"import_{safe_stem}{ext}"
    dest.write_bytes(data)
    try:
        result = import_local_file(dest, title=title, author=author, language=language)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    return result
