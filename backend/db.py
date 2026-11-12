"""SQLite database layer for Bookly.

Schema, connection helpers and CRUD functions. All paths come from
backend.config so nothing is hardcoded. init_db() creates data/bookly.db
with the required tables: books, audio_tracks, progress, settings.
"""

from __future__ import annotations

import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

from backend.config import DB_PATH, ensure_dirs

SCHEMA = """
CREATE TABLE IF NOT EXISTS books (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    source     TEXT NOT NULL,                -- librivox | gutenberg | archive | local
    source_id  TEXT,                         -- external id when available
    title      TEXT NOT NULL,
    author     TEXT,
    language   TEXT,
    cover_path TEXT,
    kind       TEXT NOT NULL DEFAULT 'text'  -- audio | text | both
        CHECK (kind IN ('audio', 'text', 'both')),
    text_path  TEXT,
    added_at   TEXT NOT NULL                 -- ISO-8601 UTC
);

CREATE TABLE IF NOT EXISTS audio_tracks (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    book_id      INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
    chapter_index INTEGER NOT NULL DEFAULT 0,
    title        TEXT,
    file_path    TEXT NOT NULL,
    duration_sec REAL
);

CREATE TABLE IF NOT EXISTS progress (
    book_id      INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
    mode         TEXT NOT NULL                -- read | listen | tts
        CHECK (mode IN ('read', 'listen', 'tts')),
    position     REAL NOT NULL DEFAULT 0,
    chapter_index INTEGER NOT NULL DEFAULT 0,
    percent      REAL NOT NULL DEFAULT 0,
    updated_at   TEXT NOT NULL,
    PRIMARY KEY (book_id, mode)
);

CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT
);

CREATE INDEX IF NOT EXISTS idx_audio_tracks_book ON audio_tracks(book_id);
CREATE INDEX IF NOT EXISTS idx_books_title ON books(title);

CREATE TABLE IF NOT EXISTS search_cache (
    q         TEXT NOT NULL,
    lang      TEXT NOT NULL,
    payload   TEXT NOT NULL,               -- JSON search result
    cached_at TEXT NOT NULL,               -- ISO-8601 UTC
    PRIMARY KEY (q, lang)
);

CREATE TABLE IF NOT EXISTS rec_cache (
    prefs_hash TEXT PRIMARY KEY,           -- hash of the preferences payload
    payload    TEXT NOT NULL,              -- JSON recommendations result
    cached_at  TEXT NOT NULL               -- ISO-8601 UTC
);
"""


def _now_utc() -> str:
    """Current UTC time as ISO-8601 string."""
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def get_connection(db_path: Optional[Path] = None) -> sqlite3.Connection:
    """Open a connection with row factory and foreign keys enabled."""
    path = Path(db_path) if db_path else DB_PATH
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def init_db(db_path: Optional[Path] = None) -> None:
    """Create the data folders and all tables if they do not exist."""
    if db_path is None:
        ensure_dirs()
    conn = get_connection(db_path)
    try:
        conn.executescript(SCHEMA)
        conn.commit()
    finally:
        conn.close()


# --- Books CRUD ---------------------------------------------------------------

def add_book(
    title: str,
    source: str,
    source_id: Optional[str] = None,
    author: Optional[str] = None,
    language: Optional[str] = None,
    cover_path: Optional[str] = None,
    kind: str = "text",
    text_path: Optional[str] = None,
    db_path: Optional[Path] = None,
) -> Dict[str, Any]:
    """Insert a book and return it as a dict."""
    conn = get_connection(db_path)
    try:
        cur = conn.execute(
            """INSERT INTO books
               (source, source_id, title, author, language, cover_path, kind, text_path, added_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (source, source_id, title, author, language, cover_path, kind, text_path, _now_utc()),
        )
        conn.commit()
        book_id = cur.lastrowid
    finally:
        conn.close()
    return get_book(book_id, db_path)


def get_book(book_id: int, db_path: Optional[Path] = None) -> Optional[Dict[str, Any]]:
    """Return one book by id, or None."""
    conn = get_connection(db_path)
    try:
        row = conn.execute("SELECT * FROM books WHERE id = ?", (book_id,)).fetchone()
        return dict(row) if row else None
    finally:
        conn.close()


def list_books(
    search: Optional[str] = None,
    kind: Optional[str] = None,
    language: Optional[str] = None,
    limit: int = 50,
    offset: int = 0,
    db_path: Optional[Path] = None,
) -> List[Dict[str, Any]]:
    """List books with optional filters (title/author search, kind, language)."""
    clauses: List[str] = []
    params: List[Any] = []
    if search:
        clauses.append("(title LIKE ? OR author LIKE ?)")
        like = f"%{search}%"
        params.extend([like, like])
    if kind:
        clauses.append("kind = ?")
        params.append(kind)
    if language:
        clauses.append("language = ?")
        params.append(language)
    where = " WHERE " + " AND ".join(clauses) if clauses else ""
    params.extend([limit, offset])
    conn = get_connection(db_path)
    try:
        rows = conn.execute(
            f"SELECT * FROM books{where} ORDER BY added_at DESC LIMIT ? OFFSET ?",
            params,
        ).fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()


def update_book(book_id: int, db_path: Optional[Path] = None, **fields: Any) -> Optional[Dict[str, Any]]:
    """Update allowed book columns (title, author, language, cover_path, kind, text_path, source, source_id)."""
    allowed = {"source", "source_id", "title", "author", "language", "cover_path", "kind", "text_path"}
    updates = {k: v for k, v in fields.items() if k in allowed}
    if not updates:
        return get_book(book_id, db_path)
    set_clause = ", ".join(f"{k} = ?" for k in updates)
    params = list(updates.values()) + [book_id]
    conn = get_connection(db_path)
    try:
        conn.execute(f"UPDATE books SET {set_clause} WHERE id = ?", params)
        conn.commit()
    finally:
        conn.close()
    return get_book(book_id, db_path)


def delete_book(book_id: int, db_path: Optional[Path] = None) -> bool:
    """Delete a book (its tracks and progress go with it via cascade)."""
    conn = get_connection(db_path)
    try:
        cur = conn.execute("DELETE FROM books WHERE id = ?", (book_id,))
        conn.commit()
        return cur.rowcount > 0
    finally:
        conn.close()


# --- Audio tracks CRUD ------------------------------------------------------

def add_track(
    book_id: int,
    file_path: str,
    chapter_index: int = 0,
    title: Optional[str] = None,
    duration_sec: Optional[float] = None,
    db_path: Optional[Path] = None,
) -> Dict[str, Any]:
    """Insert an audio track for a book."""
    conn = get_connection(db_path)
    try:
        cur = conn.execute(
            """INSERT INTO audio_tracks (book_id, chapter_index, title, file_path, duration_sec)
               VALUES (?, ?, ?, ?, ?)""",
            (book_id, chapter_index, title, file_path, duration_sec),
        )
        conn.commit()
        row = conn.execute("SELECT * FROM audio_tracks WHERE id = ?", (cur.lastrowid,)).fetchone()
        return dict(row)
    finally:
        conn.close()


def list_tracks(book_id: int, db_path: Optional[Path] = None) -> List[Dict[str, Any]]:
    """List tracks of a book ordered by chapter index."""
    conn = get_connection(db_path)
    try:
        rows = conn.execute(
            "SELECT * FROM audio_tracks WHERE book_id = ? ORDER BY chapter_index, id",
            (book_id,),
        ).fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()


def delete_track(track_id: int, db_path: Optional[Path] = None) -> bool:
    """Delete one audio track."""
    conn = get_connection(db_path)
    try:
        cur = conn.execute("DELETE FROM audio_tracks WHERE id = ?", (track_id,))
        conn.commit()
        return cur.rowcount > 0
    finally:
        conn.close()


# --- Progress CRUD ----------------------------------------------------------

def set_progress(
    book_id: int,
    mode: str,
    position: float = 0,
    chapter_index: int = 0,
    percent: float = 0,
    db_path: Optional[Path] = None,
) -> Dict[str, Any]:
    """Upsert reading/listening/TTS progress for a book."""
    conn = get_connection(db_path)
    try:
        conn.execute(
            """INSERT INTO progress (book_id, mode, position, chapter_index, percent, updated_at)
               VALUES (?, ?, ?, ?, ?, ?)
               ON CONFLICT(book_id, mode)
               DO UPDATE SET position = excluded.position,
                             chapter_index = excluded.chapter_index,
                             percent = excluded.percent,
                             updated_at = excluded.updated_at""",
            (book_id, mode, position, chapter_index, percent, _now_utc()),
        )
        conn.commit()
    finally:
        conn.close()
    return get_progress(book_id, mode, db_path)


def get_progress(book_id: int, mode: str, db_path: Optional[Path] = None) -> Optional[Dict[str, Any]]:
    """Return progress for a book+mode, or None."""
    conn = get_connection(db_path)
    try:
        row = conn.execute(
            "SELECT * FROM progress WHERE book_id = ? AND mode = ?", (book_id, mode)
        ).fetchone()
        return dict(row) if row else None
    finally:
        conn.close()


def get_all_progress(book_id: int, db_path: Optional[Path] = None) -> List[Dict[str, Any]]:
    """Return every progress row for a book."""
    conn = get_connection(db_path)
    try:
        rows = conn.execute(
            "SELECT * FROM progress WHERE book_id = ? ORDER BY mode", (book_id,)
        ).fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()


# --- Settings CRUD ----------------------------------------------------------

def set_setting(key: str, value: str, db_path: Optional[Path] = None) -> None:
    """Insert or update a settings entry."""
    conn = get_connection(db_path)
    try:
        conn.execute(
            "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            (key, value),
        )
        conn.commit()
    finally:
        conn.close()


def get_setting(key: str, default: Optional[str] = None, db_path: Optional[Path] = None) -> Optional[str]:
    """Return a settings value, or default if missing."""
    conn = get_connection(db_path)
    try:
        row = conn.execute("SELECT value FROM settings WHERE key = ?", (key,)).fetchone()
        return row["value"] if row else default
    finally:
        conn.close()


def list_settings(db_path: Optional[Path] = None) -> Dict[str, str]:
    """Return all settings as a dict."""
    conn = get_connection(db_path)
    try:
        rows = conn.execute("SELECT key, value FROM settings ORDER BY key").fetchall()
        return {r["key"]: r["value"] for r in rows}
    finally:
        conn.close()
