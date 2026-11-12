"""Recommendation service for Bookly.

Builds suggestions from the user's preferences (genres, languages, format,
favorite authors) using Gutendex (topic + languages), LibriVox (search terms
derived from genres) and favorite authors. Books already in the library are
excluded. Results are cached in SQLite for 24 hours keyed by the preference
hash. The Gutenberg OPDS catalogue is used as a fallback when Gutendex is
unreachable (same behaviour as the search service).
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import re
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional

import httpx

from backend.config import ARCHIVE_BASE, GUTENDEX_BASE, LIBRIVOX_BASE, cfg
from backend.db import get_connection, list_books
from backend.services.search import (
    fetch_gutenberg_opds_sync,
    merge_results,
    openlibrary_cover_url,
)

CACHE_TTL_HOURS = 24

# Canonical genre keys stored in prefs; each maps to search topics.
GENRE_TOPICS = {
    "fiction": ["fiction"],
    "romance": ["romance"],
    "detective": ["detective and mystery stories"],
    "scifi": ["science fiction"],
    "fantasy": ["fantasy"],
    "adventure": ["adventure stories"],
    "poetry": ["poetry"],
    "drama": ["drama"],
    "classics": ["classics"],
    "history": ["history"],
    "philosophy": ["philosophy"],
    "children": ["children's literature"],
    "other": [],
}

DEFAULT_PREFS: Dict[str, Any] = {
    "ui_language": "auto",
    "genres": [],
    "book_languages": [],
    "format": "both",  # audio | text | both
    "authors": [],
    "onboarded": False,
}


def _now_utc() -> datetime:
    return datetime.now(timezone.utc)


def prefs_hash(prefs: Dict[str, Any]) -> str:
    """Stable hash of the preference payload used as cache key."""
    canonical = json.dumps(prefs, sort_keys=True, ensure_ascii=False)
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def _genres_to_queries(prefs: Dict[str, Any]) -> List[str]:
    """Turn selected genres into short search queries."""
    queries: List[str] = []
    for genre in prefs.get("genres", []):
        topics = GENRE_TOPICS.get(genre, [])
        queries.extend(topics)
    return queries or ["classics"]


# --- Per-source fetchers ------------------------------------------------------

async def fetch_gutendex_topic(client: httpx.AsyncClient, topic: str, languages: List[str]) -> List[Dict[str, Any]]:
    """Gutendex books matching a topic and language list."""
    params = {"search": topic, "limit": 20}
    if languages:
        params["languages"] = ",".join(languages)
    resp = await client.get(f"{GUTENDEX_BASE}/books", params=params)
    resp.raise_for_status()
    data = resp.json()
    items: List[Dict[str, Any]] = []
    for b in data.get("results", []):
        items.append({
            "source": "gutenberg",
            "source_id": str(b.get("id", "")),
            "title": (b.get("title") or "").strip(),
            "author": (b.get("author") or "").strip() or None,
            "language": b.get("language") or None,
            "url": b.get("bookshelf") or "",
            "cover_url": b.get("cover") or "",
            "has_audio": False,
            "has_text": True,
        })
    return items


async def fetch_librivox_topic(client: httpx.AsyncClient, topic: str) -> List[Dict[str, Any]]:
    """LibriVox audiobooks matching a genre/topic term."""
    params = {"format": "json", "search": topic, "limit": 20}
    resp = await client.get(f"{LIBRIVOX_BASE}/api/feed/audiobooks", params=params)
    resp.raise_for_status()
    data = resp.json()
    items: List[Dict[str, Any]] = []
    for b in data.get("books", []):
        authors = b.get("authors") or []
        author = " ".join(
            f"{a.get('first_name', '')} {a.get('last_name', '')}".strip()
            for a in authors if isinstance(a, dict)
        ) or None
        items.append({
            "source": "librivox",
            "source_id": str(b.get("id", "")),
            "title": (b.get("title") or "").strip(),
            "author": author,
            "language": str(b.get("language") or "").lower() or None,
            "url": b.get("url_librivox") or b.get("url_project") or "",
            "cover_url": "",
            "has_audio": True,
            "has_text": False,
        })
    return items


async def fetch_gutendex_author(client: httpx.AsyncClient, author: str) -> List[Dict[str, Any]]:
    """Gutendex books by a favorite author."""
    resp = await client.get(f"{GUTENDEX_BASE}/books", params={"search": author, "limit": 10})
    resp.raise_for_status()
    data = resp.json()
    items: List[Dict[str, Any]] = []
    for b in data.get("results", []):
        items.append({
            "source": "gutenberg",
            "source_id": str(b.get("id", "")),
            "title": (b.get("title") or "").strip(),
            "author": (b.get("author") or "").strip() or None,
            "language": b.get("language") or None,
            "url": b.get("bookshelf") or "",
            "cover_url": b.get("cover") or "",
            "has_audio": False,
            "has_text": True,
        })
    return items


# --- Cache ------------------------------------------------------------------

def _cache_get(p_hash: str, db_path: Optional[Any] = None) -> Optional[Dict[str, Any]]:
    conn = get_connection(db_path)
    try:
        row = conn.execute(
            "SELECT payload, cached_at FROM rec_cache WHERE prefs_hash = ?", (p_hash,)
        ).fetchone()
        if not row:
            return None
        cached_at = datetime.fromisoformat(row["cached_at"])
        if _now_utc() - cached_at <= timedelta(hours=CACHE_TTL_HOURS):
            return json.loads(row["payload"])
        conn.execute("DELETE FROM rec_cache WHERE prefs_hash = ?", (p_hash,))
        conn.commit()
        return None
    finally:
        conn.close()


def _cache_set(p_hash: str, payload: Dict[str, Any], db_path: Optional[Any] = None) -> None:
    conn = get_connection(db_path)
    try:
        conn.execute(
            """INSERT INTO rec_cache (prefs_hash, payload, cached_at)
               VALUES (?, ?, ?)
               ON CONFLICT(prefs_hash) DO UPDATE SET payload = excluded.payload, cached_at = excluded.cached_at""",
            (p_hash, json.dumps(payload), _now_utc().isoformat(timespec="seconds")),
        )
        conn.commit()
    finally:
        conn.close()


# --- Library exclusion --------------------------------------------------------

def library_keys(db_path: Optional[Any] = None) -> set:
    """Normalized title|author keys of books already in the library."""
    from backend.services.search import normalize_key

    keys = set()
    for book in list_books(limit=1000, db_path=db_path):
        keys.add(normalize_key(book.get("title", ""), book.get("author")))
    return keys


def _in_library(item: Dict[str, Any], keys: set) -> bool:
    from backend.services.search import normalize_key

    return normalize_key(item.get("title", ""), item.get("author")) in keys


# --- Public entry point -------------------------------------------------------

async def get_recommendations(
    prefs: Dict[str, Any],
    db_path: Optional[Any] = None,
    client: Optional[httpx.AsyncClient] = None,
) -> Dict[str, Any]:
    """Return grouped recommendations honoring genres, languages, format and authors."""
    p_hash = prefs_hash(prefs)
    cached = _cache_get(p_hash, db_path)
    if cached is not None:
        cached["cached"] = True
        return cached

    queries = _genres_to_queries(prefs)
    languages = [l for l in prefs.get("book_languages", []) if l]
    authors = [a for a in prefs.get("authors", []) if a]

    tasks: Dict[str, asyncio.Task] = {}
    own_client = client is None
    if own_client:
        client = httpx.AsyncClient(timeout=float(cfg("source_timeout_sec", 10)),
                                  headers={"User-Agent": "Bookly/0.1 (personal library app)"})
    errors: Dict[str, str] = {}
    raw_items: List[Dict[str, Any]] = []

    try:
        async def _safe(name: str, coro):
            try:
                return name, await asyncio.wait_for(coro, timeout=float(cfg("source_timeout_sec", 10)))
            except Exception as exc:
                return name, exc

        coros = []
        for topic in queries:
            coros.append(_safe(f"gutenberg:{topic}", fetch_gutendex_topic(client, topic, languages)))
            coros.append(_safe(f"librivox:{topic}", fetch_librivox_topic(client, topic)))
        for author in authors:
            coros.append(_safe(f"author:{author}", fetch_gutendex_author(client, author)))

        # Tag every item with the genre/topic that produced it, so grouping is
        # accurate instead of guessed from titles.
        gathered = await asyncio.gather(*coros)
        for name, result in gathered:
            if isinstance(result, Exception):
                errors[name] = str(result)
                # OPDS fallback for failed Gutendex topic queries.
                if name.startswith("gutenberg:"):
                    topic = name.split(":", 1)[1]
                    try:
                        with httpx.Client(timeout=15.0, headers={"User-Agent": "Bookly/0.1 (personal library app)"}, follow_redirects=True) as sync_client:
                            fallback = fetch_gutenberg_opds_sync(sync_client, topic, languages[0] if languages else "en")
                            for fb in fallback:
                                fb["_genre_tags"] = [next((g for g, topics in GENRE_TOPICS.items() if topic in topics), "other")]
                            raw_items.extend(fallback)
                    except Exception as fb_exc:
                        errors[f"{name}_opds"] = str(fb_exc)
            else:
                # name is "gutenberg:<topic>", "librivox:<topic>" or "author:<name>"
                if name.startswith(("gutenberg:", "librivox:")):
                    topic = name.split(":", 1)[1]
                    genre = next((g for g, topics in GENRE_TOPICS.items() if topic in topics), "other")
                    for item in result:
                        item.setdefault("_genre_tags", []).append(genre)
                raw_items.extend(result)
    finally:
        if own_client:
            await client.aclose()

    merged = merge_results(raw_items)
    lib_keys = library_keys(db_path)
    merged = [m for m in merged if not _in_library(m, lib_keys)]

    format_pref = prefs.get("format", "both")
    if format_pref == "audio":
        merged = [m for m in merged if m["has_audio"]]
    elif format_pref == "text":
        merged = [m for m in merged if m["has_text"]]

    # Tag each item with the genre(s) whose query produced it. A source url is
    # only present for items fetched by that query, so we re-run attribution by
    # matching title/author against nothing reliable; instead each fetcher tags
    # its own items. Simpler: keep a mapping from source_id -> genres during
    # collection (see _safe loop above).
    for item in merged:
        item["genres"] = list(item.get("_genre_tags", []))

    # Group by genre for carousels.
    groups: Dict[str, List[Dict[str, Any]]] = {}
    for item in merged:
        for genre in (item["genres"] or ["other"]):
            groups.setdefault(genre, [])
            if item not in groups[genre]:
                groups[genre].append(item)

    payload = {
        "prefs_hash": p_hash,
        "results": merged[:100],
        "groups": {g: items[:20] for g, items in groups.items()},
        "errors": errors,
        "cached": False,
    }
    _cache_set(p_hash, payload, db_path)
    return payload
