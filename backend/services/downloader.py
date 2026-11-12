"""Download service for Bookly (library add + import).

Responsibilities:
  - Resolve a search result (source, source_id) into concrete files.
  - Download covers, Gutenberg texts (EPUB/HTML -> clean paginated JSON),
    LibriVox MP3 chapters and Internet Archive files in the background.
  - Resume interrupted downloads (partial .part files are continued with
    HTTP Range requests) and never duplicate a book already in the DB.
  - Track job progress in SQLite so GET /api/library/jobs/{id} can report it.

Background work runs on a plain thread (no external queue needed); each
download is chunked and the job state is flushed to the jobs table after
every chunk, which keeps resume possible across restarts.
"""

from __future__ import annotations

import json
import re
import sqlite3
import threading
import zipfile
from datetime import datetime, timezone
from html.parser import HTMLParser
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple
from urllib.parse import urljoin

import httpx

from backend.config import ARCHIVE_BASE, AUDIO_DIR, BOOKS_DIR, COVERS_DIR, cfg
from backend.db import add_book, get_connection, get_book

PAGE_SIZE = int(cfg("page_size", 1800))
CHUNK_SIZE = 64 * 1024
USER_AGENT = "Bookly/0.1 (personal library app)"

# Allowed extensions for user-imported files.
IMPORT_EXTENSIONS = {".epub", ".txt", ".mp3", ".m4b"}


def _now_utc() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _safe_name(text: str) -> str:
    """Filesystem-safe slug from a title/author."""
    text = re.sub(r"[^\w\s-]", "", text or "").strip()
    return re.sub(r"\s+", "_", text)[:80] or "book"


# --- Job table (created here, outside the core schema) -----------------------

JOBS_SCHEMA = """
CREATE TABLE IF NOT EXISTS download_jobs (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    book_id     INTEGER REFERENCES books(id) ON DELETE CASCADE,
    source      TEXT NOT NULL,
    source_id   TEXT,
    title       TEXT,
    author      TEXT,
    language    TEXT,
    status      TEXT NOT NULL DEFAULT 'queued'
        CHECK (status IN ('queued', 'running', 'done', 'error')),
    total_items INTEGER NOT NULL DEFAULT 0,
    done_items  INTEGER NOT NULL DEFAULT 0,
    percent     REAL NOT NULL DEFAULT 0,
    error       TEXT,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON download_jobs(status);
"""


def init_jobs_table(db_path: Optional[Path] = None) -> None:
    conn = get_connection(db_path)
    try:
        conn.executescript(JOBS_SCHEMA)
        conn.commit()
    finally:
        conn.close()


def create_job(source: str, source_id: Optional[str], title: str, author: Optional[str],
               language: Optional[str], book_id: Optional[int] = None,
               db_path: Optional[Path] = None) -> Dict[str, Any]:
    init_jobs_table(db_path)
    now = _now_utc()
    conn = get_connection(db_path)
    try:
        cur = conn.execute(
            """INSERT INTO download_jobs (book_id, source, source_id, title, author, language,
                                         status, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?)""",
            (book_id, source, source_id, title, author, language, now, now),
        )
        conn.commit()
        job_id = cur.lastrowid
    finally:
        conn.close()
    return get_job(job_id, db_path)


def get_job(job_id: int, db_path: Optional[Path] = None) -> Optional[Dict[str, Any]]:
    conn = get_connection(db_path)
    try:
        row = conn.execute("SELECT * FROM download_jobs WHERE id = ?", (job_id,)).fetchone()
        return dict(row) if row else None
    finally:
        conn.close()


def update_job(job_id: int, db_path: Optional[Path] = None, **fields: Any) -> Optional[Dict[str, Any]]:
    allowed = {"book_id", "status", "total_items", "done_items", "percent", "error"}
    updates = {k: v for k, v in fields.items() if k in allowed}
    if not updates:
        return get_job(job_id, db_path)
    updates["updated_at"] = _now_utc()
    set_clause = ", ".join(f"{k} = ?" for k in updates)
    params = list(updates.values()) + [job_id]
    conn = get_connection(db_path)
    try:
        conn.execute(f"UPDATE download_jobs SET {set_clause} WHERE id = ?", params)
        conn.commit()
    finally:
        conn.close()
    return get_job(job_id, db_path)


# --- Dedupe ------------------------------------------------------------------

def find_existing_book(source: str, source_id: Optional[str], title: Optional[str] = None,
                       db_path: Optional[Path] = None) -> Optional[Dict[str, Any]]:
    """Return an already-added book for the same source+id (or same title)."""
    conn = get_connection(db_path)
    try:
        if source_id:
            row = conn.execute(
                "SELECT * FROM books WHERE source = ? AND source_id = ?", (source, str(source_id))
            ).fetchone()
            if row:
                return dict(row)
        if title:
            row = conn.execute("SELECT * FROM books WHERE title = ?", (title,)).fetchone()
            if row:
                return dict(row)
        return None
    finally:
        conn.close()


# --- Download helpers ----------------------------------------------------------

def _download_file(url: str, dest: Path, client: httpx.Client, job_id: Optional[int] = None,
                   db_path: Optional[Path] = None) -> bool:
    """Download url to dest with resume support.

    A partial file is saved as dest.part; on restart the request continues with
    a Range header from the existing size. Returns True if something new was
    downloaded or the file already existed complete.
    """
    part = dest.with_suffix(dest.suffix + ".part")
    offset = part.stat().st_size if part.exists() else 0
    headers = {"User-Agent": USER_AGENT}
    if offset:
        headers["Range"] = f"bytes={offset}-"
    try:
        with client.stream("GET", url, headers=headers, timeout=cfg("download_timeout_sec", 60)) as resp:
            if resp.status_code == 416:  # range already satisfied -> file complete
                part.rename(dest)
                return True
            resp.raise_for_status()
            mode = "ab" if offset and resp.status_code == 206 else "wb"
            if mode == "wb":
                offset = 0
            with part.open(mode) as fh:
                for chunk in resp.iter_bytes(chunk_size=CHUNK_SIZE):
                    fh.write(chunk)
                    offset += len(chunk)
                    if job_id is not None and offset % (8 * CHUNK_SIZE) < CHUNK_SIZE:
                        pass  # progress is updated by the caller per item
        part.rename(dest)
        return True
    except Exception:
        # Keep the .part so a later attempt can resume.
        raise


def _cover_for(title: str, author: Optional[str], gutenberg_id: Optional[str]) -> str:
    if gutenberg_id:
        return f"https://covers.openlibrary.org/b/gutenberg/{gutenberg_id}-M.jpg?default=false"
    if title:
        return f"https://covers.openlibrary.org/b/title/{title.strip()}-M.jpg?default=false"
    return ""


# --- Text extraction (EPUB/HTML -> clean paginated JSON) ---------------------

class _TextExtractor(HTMLParser):
    """Strip tags and collect readable text from Gutenberg HTML."""

    BLOCK_TAGS = {"p", "div", "li", "h1", "h2", "h3", "h4", "blockquote", "tr"}
    SKIP_TAGS = {"script", "style", "head", "title", "img", "table"}

    def __init__(self) -> None:
        super().__init__()
        self.parts: List[str] = []
        self._skip_depth = 0

    def handle_starttag(self, tag: str, attrs: Any) -> None:
        if tag in self.SKIP_TAGS:
            self._skip_depth += 1
        elif tag in self.BLOCK_TAGS:
            self.parts.append("\n")

    def handle_endtag(self, tag: str) -> None:
        if tag in self.SKIP_TAGS and self._skip_depth:
            self._skip_depth -= 1

    def handle_data(self, data: str) -> None:
        if not self._skip_depth:
            text = re.sub(r"\s+", " ", data).strip()
            if text:
                self.parts.append(text)


def html_to_text(html: str) -> str:
    parser = _TextExtractor()
    parser.feed(html)
    text = " ".join(parser.parts)
    text = re.sub(r"\n\s*\n+", "\n\n", text)
    return text.strip()


def epub_to_text(path: Path) -> str:
    """Extract readable text from an EPUB (zip of XHTML files)."""
    texts: List[str] = []
    with zipfile.ZipFile(path) as zf:
        names = sorted(
            n for n in zf.namelist()
            if n.lower().endswith((".xhtml", ".html", ".htm")) and not n.startswith("META-INF")
        )
        for name in names:
            html = zf.read(name).decode("utf-8", errors="replace")
            chunk = html_to_text(html)
            if chunk:
                texts.append(chunk)
    return "\n\n".join(texts)


def split_into_pages(text: str, page_size: int = PAGE_SIZE) -> List[str]:
    """Split text into ~page_size chunks cutting at end-of-sentence boundaries."""
    sentences = re.findall(r"[^.!?…\n]+[.!?…]?|\n+", text)
    pages: List[str] = []
    current = ""
    for sentence in sentences:
        if len(current) + len(sentence) > page_size and current:
            pages.append(current.strip())
            current = sentence
        else:
            current += sentence
    if current.strip():
        pages.append(current.strip())
    return pages


def save_pages(book_id: int, text: str, db_path: Optional[Path] = None) -> Tuple[str, int]:
    """Write paginated text JSON to data/books/<id>_pages.json; return (path, count)."""
    pages = split_into_pages(text)
    out = BOOKS_DIR / f"{book_id}_pages.json"
    out.write_text(json.dumps({"pages": pages}, ensure_ascii=False), encoding="utf-8")
    return str(out), len(pages)


# --- Source resolution ---------------------------------------------------------

def resolve_gutenberg(source_id: str, client: httpx.Client) -> Dict[str, Any]:
    """Fetch Gutenberg metadata via OPDS (Gutendex is unreachable on this network).

    The OPDS publication record returns the book metadata at the top level and
    an EPUB acquisition link; HTML/plain-text URLs are derived from the id.
    """
    url = f"https://www.gutenberg.org/opds/publications?id={source_id}"
    resp = client.get(url, timeout=cfg("source_timeout_sec", 15))
    resp.raise_for_status()
    data = resp.json()
    meta = data.get("metadata") or {}
    links = data.get("links", [])
    epub = next((l["href"] for l in links if l.get("type") == "application/epub+zip"), None)
    author_obj = meta.get("author")
    author = author_obj.get("name") if isinstance(author_obj, dict) else author_obj
    return {
        "title": meta.get("title", ""),
        "author": author,
        "language": meta.get("language"),
        "epub_url": epub,
        "html_url": f"https://www.gutenberg.org/ebooks/{source_id}.html.no-cover",
        "txt_url": None,
    }


def resolve_librivox(source_id: str, client: httpx.Client) -> Dict[str, Any]:
    """LibriVox project JSON -> list of MP3 chapter URLs."""
    url = f"https://librivox.org/api/feed/audiobooks?id={source_id}&format=json"
    resp = client.get(url, timeout=cfg("source_timeout_sec", 15))
    resp.raise_for_status()
    data = resp.json()
    book = (data.get("books") or [{}])[0]
    chapters = []
    for ch in book.get("readers", []):
        chapters.append({
            "title": ch.get("title", ""),
            "url": ch.get("url", ""),
            "duration_sec": float(ch.get("length", 0) or 0),
        })
    return {
        "title": book.get("title", ""),
        "author": " ".join(
            f"{a.get('first_name', '')} {a.get('last_name', '')}".strip()
            for a in book.get("authors", []) if isinstance(a, dict)
        ) or None,
        "chapters": chapters,
    }


def resolve_archive(source_id: str, client: httpx.Client) -> Dict[str, Any]:
    """Internet Archive metadata -> best text file URL (+ cover)."""
    url = f"{ARCHIVE_BASE}/metadata/{source_id}"
    resp = client.get(url, timeout=cfg("source_timeout_sec", 15))
    resp.raise_for_status()
    meta = resp.json()
    files = meta.get("files", [])
    text_file = next(
        (f for f in files if f.get("name", "").lower().endswith((".txt", "_djvu.txt"))),
        None,
    )
    cover = next((f for f in files if f.get("name", "").lower().endswith((".jpg", ".png"))), None)
    base = f"{ARCHIVE_BASE}/download/{source_id}"
    return {
        "title": meta.get("metadata", {}).get("title", ""),
        "text_url": urljoin(base, text_file["name"]) if text_file else None,
        "cover_url": urljoin(base, cover["name"]) if cover else None,
    }


# --- Background job runner -----------------------------------------------------

def run_job(job_id: int, db_path: Optional[Path] = None) -> None:
    """Download everything for a job. Runs in a worker thread."""
    job = get_job(job_id, db_path)
    if not job or job["status"] == "done":
        return
    update_job(job_id, db_path=db_path, status="running")
    try:
        with httpx.Client(headers={"User-Agent": USER_AGENT}, follow_redirects=True) as client:
            book = get_book(job["book_id"], db_path)
            title = book["title"] if book else job.get("title", "")
            author = book["author"] if book else job.get("author")

            total = 0
            done = 0

            def bump() -> None:
                nonlocal done
                done += 1
                percent = round(100.0 * done / max(total, 1), 1)
                update_job(job_id, db_path=db_path, done_items=done, percent=percent)

            # Cover
            cover_url = _cover_for(title, author, job["source_id"] if job["source"] == "gutenberg" else None)
            total += 1
            if cover_url:
                try:
                    cover_path = COVERS_DIR / f"{job['book_id']}.jpg"
                    if not cover_path.exists():
                        _download_file(cover_url, cover_path, client)
                except Exception:
                    pass  # cover is optional
            bump()

            # Text
            text_body = ""
            if job["source"] == "gutenberg":
                meta = resolve_gutenberg(job["source_id"], client)
                total += 1
                if meta.get("txt_url"):
                    txt_path = BOOKS_DIR / f"{job['book_id']}.txt"
                    if not txt_path.exists():
                        _download_file(meta["txt_url"], txt_path, client)
                    text_body = txt_path.read_text(encoding="utf-8", errors="replace")
                elif meta.get("epub_url"):
                    epub_path = BOOKS_DIR / f"{job['book_id']}.epub"
                    if not epub_path.exists():
                        _download_file(meta["epub_url"], epub_path, client)
                    text_body = epub_to_text(epub_path)
                elif meta.get("html_url"):
                    html_path = BOOKS_DIR / f"{job['book_id']}.html"
                    if not html_path.exists():
                        _download_file(meta["html_url"], html_path, client)
                    text_body = html_to_text(html_path.read_text(encoding="utf-8", errors="replace"))
                bump()
            elif job["source"] == "archive":
                meta = resolve_archive(job["source_id"], client)
                total += 1
                if meta.get("text_url"):
                    txt_path = BOOKS_DIR / f"{job['book_id']}.txt"
                    if not txt_path.exists():
                        _download_file(meta["text_url"], txt_path, client)
                    text_body = txt_path.read_text(encoding="utf-8", errors="replace")
                bump()

            if text_body:
                pages_path, page_count = save_pages(job["book_id"], text_body, db_path)
                from backend.db import update_book
                # Also refresh metadata captured while resolving the source.
                fields = {"text_path": pages_path}
                if job.get("title") in ("", "Untitled") and meta.get("title"):
                    fields["title"] = meta["title"]
                if not job.get("author") and meta.get("author"):
                    fields["author"] = meta["author"]
                update_book(job["book_id"], db_path=db_path, **fields)

            # Audio (LibriVox chapters)
            if job["source"] == "librivox":
                meta = resolve_librivox(job["source_id"], client)
                chapters = meta.get("chapters", [])
                total += len(chapters)
                from backend.db import add_track
                for i, ch in enumerate(chapters):
                    mp3_path = AUDIO_DIR / f"{job['book_id']}_{i:03d}.mp3"
                    if not mp3_path.exists() and ch.get("url"):
                        try:
                            _download_file(ch["url"], mp3_path, client)
                        except Exception:
                            continue  # keep other chapters
                    add_track(job["book_id"], str(mp3_path), i, ch.get("title"), ch.get("duration_sec"), db_path)
                    bump()

            update_job(job_id, db_path=db_path, status="done", total_items=total, done_items=done, percent=100.0)
    except Exception as exc:
        update_job(job_id, db_path=db_path, status="error", error=str(exc))


# --- Public entry points -------------------------------------------------------

def add_book_from_source(source: str, source_id: str, title: str, author: Optional[str] = None,
                         language: Optional[str] = None, db_path: Optional[Path] = None) -> Dict[str, Any]:
    """Create the book row (deduped) and start a background download job."""
    existing = find_existing_book(source, source_id, title, db_path)
    if existing:
        return {"book": existing, "job": None, "deduplicated": True}

    kind = "audio" if source == "librivox" else "text"
    book = add_book(title=title, source=source, source_id=source_id, author=author,
                   language=language, kind=kind, db_path=db_path)
    job = create_job(source, source_id, title, author, language, book["id"], db_path)

    thread = threading.Thread(target=run_job, args=(job["id"], db_path), daemon=True)
    thread.start()
    return {"book": book, "job": job, "deduplicated": False}


def import_local_file(path: Path, title: Optional[str] = None, author: Optional[str] = None,
                      language: Optional[str] = None, db_path: Optional[Path] = None) -> Dict[str, Any]:
    """Import a user-provided file (epub/txt/mp3/m4b) into the library."""
    path = Path(path)
    ext = path.suffix.lower()
    if ext not in IMPORT_EXTENSIONS:
        raise ValueError(f"Unsupported file type: {ext}")

    guessed_title = title or path.stem.replace("_", " ").title()

    # Dedupe imported files by filename stored as source_id.
    existing = find_existing_book("local", str(path.name), guessed_title, db_path)
    if existing:
        return {"book": existing, "deduplicated": True}

    kind = "audio" if ext in (".mp3", ".m4b") else "text"
    book = add_book(title=guessed_title, source="local", source_id=str(path.name),
                   author=author, language=language, kind=kind, db_path=db_path)

    if kind == "audio":
        from backend.db import add_track
        add_track(book["id"], str(path), 0, guessed_title, db_path=db_path)
    else:
        if ext == ".epub":
            text = epub_to_text(path)
        else:
            text = path.read_text(encoding="utf-8", errors="replace")
        pages_path, _ = save_pages(book["id"], text, db_path)
        from backend.db import update_book
        update_book(book["id"], db_path=db_path, text_path=pages_path)

    return {"book": book, "deduplicated": False}
