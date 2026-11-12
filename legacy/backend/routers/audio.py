"""Audio router: chapter list and streaming with HTTP Range support.

Endpoints:
  GET /api/audio/{book_id}          list of tracks (chapter_index, title, url, duration)
  GET /api/audio/file/{track_id}    stream an MP3/M4B with Range requests (iOS/Safari)

FastAPI's FileResponse implements partial content (206) for Range headers
natively, which is what Safari on iOS needs to seek and pre-load chapters.
"""

from __future__ import annotations

from pathlib import Path

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse

from backend.config import AUDIO_DIR
from backend.db import list_tracks

router = APIRouter(prefix="/api/audio", tags=["audio"])


@router.get("/{book_id}")
def api_tracks(book_id: int) -> dict:
    """Return the book's audio chapters with playable URLs."""
    tracks = list_tracks(book_id)
    out = []
    for t in tracks:
        path = Path(t["file_path"])
        exists = path.exists()
        out.append({
            "id": t["id"],
            "chapter_index": t["chapter_index"],
            "title": t["title"] or f"Chapter {t['chapter_index'] + 1}",
            "duration_sec": t["duration_sec"] or 0,
            "url": f"/api/audio/file/{t['id']}",
            "available": exists,
        })
    return {"book_id": book_id, "tracks": out}


@router.get("/file/{track_id}")
def api_audio_file(track_id: int):
    """Stream one audio file honouring Range requests (206 Partial Content)."""
    conn_path = None
    # Resolve the stored path from the DB row.
    from backend.db import get_connection

    conn = get_connection()
    try:
        row = conn.execute(
            "SELECT file_path FROM audio_tracks WHERE id = ?", (track_id,)
        ).fetchone()
    finally:
        conn.close()
    if not row:
        raise HTTPException(status_code=404, detail="track not found")
    path = Path(row["file_path"])
    if not path.exists():
        raise HTTPException(status_code=404, detail="audio file not found on disk")
    # FileResponse handles Range/206 automatically for seekable responses.
    media_type = "audio/mpeg" if path.suffix.lower() in (".mp3", ".m4b") else "audio/mp4"
    return FileResponse(str(path), media_type=media_type, filename=path.name)
