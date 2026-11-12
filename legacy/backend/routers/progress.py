"""Progress router: save and read reading/listening/TTS position.

Endpoints:
  PUT /api/progress/{book_id}   {mode, position, chapter_index, percent}
  GET /api/progress/{book_id}   all progress rows for a book
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException

from backend.db import get_all_progress, set_progress

router = APIRouter(prefix="/api/progress", tags=["progress"])


@router.put("/{book_id}")
def api_set_progress(book_id: int, payload: dict) -> dict:
    """Upsert progress for a book+mode (read | listen | tts)."""
    mode = payload.get("mode")
    if mode not in ("read", "listen", "tts"):
        raise HTTPException(status_code=400, detail="mode must be read, listen or tts")
    try:
        position = float(payload.get("position", 0))
        chapter_index = int(payload.get("chapter_index", 0))
        percent = float(payload.get("percent", 0))
    except (TypeError, ValueError):
        raise HTTPException(status_code=400, detail="position/percent must be numbers")
    row = set_progress(book_id, mode, position, chapter_index, percent)
    if row is None:
        raise HTTPException(status_code=404, detail="book not found")
    return row


@router.get("/{book_id}")
def api_get_progress(book_id: int) -> dict:
    """Return every progress row for a book."""
    rows = get_all_progress(book_id)
    return {"book_id": book_id, "progress": rows}
