"""Search service for Bookly.

Queries three legal sources in parallel with httpx (async):
  - LibriVox   (public-domain audiobooks, read API endpoint)
  - Gutendex   (Project Gutenberg texts)
  - Internet Archive (advancedsearch, public domain items)

Results for the same book (normalized title + author) are merged into one
item with has_audio / has_text flags. Each source has its own timeout; if a
source fails the others still return and the failure is reported in "errors".
Results are cached in SQLite for 24 hours (search_cache table).
"""

from __future__ import annotations

import asyncio
import json
import re
import unicodedata
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional

import httpx

from backend.config import ARCHIVE_BASE, GUTENDEX_BASE, LIBRIVOX_BASE, cfg
from backend.db import get_connection

CACHE_TTL_HOURS = 24


# --- Normalization / helpers --------------------------------------------------

def normalize_key(title: str, author: Optional[str]) -> str:
    """Normalized merge key: lowercase, accents stripped, punctuation removed."""
    text = f"{(title or '').strip()}|{(author or '').strip()}"
    text = unicodedata.normalize("NFKD", text)
    text = "".join(ch for ch in text if not unicodedata.combining(ch))
    text = re.sub(r"[^\w\s]+", " ", text).lower()
    return " ".join(text.split())


def _now_utc() -> datetime:
    return datetime.now(timezone.utc)


# --- Per-source fetchers ------------------------------------------------------

async def fetch_librivox(client: httpx.AsyncClient, q: str, lang: str) -> List[Dict[str, Any]]:
    """LibriVox audiobooks API (no key needed)."""
    params = {
        "format": "json",
        "search": q,
        "limit": 30,
    }
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
            "cover_url": "",  # LibriVox API has no cover; Open Library fallback is used
            "has_audio": True,
            "has_text": False,
        })
    return items


async def fetch_gutendex(client: httpx.AsyncClient, q: str, lang: str) -> List[Dict[str, Any]]:
    """Gutendex (Project Gutenberg search API)."""
    params = {"search": q, "languages": lang, "limit": 30}
    resp = await client.get(f"{GUTENDEX_BASE}/books", params=params)
    resp.raise_for_status()
    data = resp.json()
    items: List[Dict[str, Any]] = []
    for b in data.get("results", []):
        author_name = (b.get("author") or "").strip() or None
        items.append({
            "source": "gutenberg",
            "source_id": str(b.get("id", "")),
            "title": (b.get("title") or "").strip(),
            "author": author_name,
            "language": (b.get("language") or lang),
            "url": b.get("bookshelf") or "",
            "cover_url": b.get("cover") or "",
            "has_audio": False,
            "has_text": True,
        })
    return items


def fetch_gutenberg_opds_sync(client: httpx.Client, q: str, lang: str) -> List[Dict[str, Any]]:
    """Project Gutenberg OPDS catalogue (fallback when Gutendex is unreachable)."""
    resp = client.get("https://www.gutenberg.org/opds/search", params={"query": q})
    resp.raise_for_status()
    data = resp.json()
    items: List[Dict[str, Any]] = []
    for pub in data.get("publications", []):
        meta = pub.get("metadata", {})
        identifier = str(meta.get("identifier", "")).rstrip("/")
        source_id = identifier.rsplit("/", 1)[-1]
        author_obj = meta.get("author") or {}
        author = (author_obj.get("name") if isinstance(author_obj, dict) else str(author_obj)) or None
        images = pub.get("images") or []
        items.append({
            "source": "gutenberg",
            "source_id": source_id,
            "title": (meta.get("title") or "").strip(),
            "author": author,
            "language": meta.get("language") or lang,
            "url": identifier,
            "cover_url": images[0]["href"] if images else "",
            "has_audio": False,
            "has_text": True,
        })
    return items


async def fetch_archive(client: httpx.AsyncClient, q: str, lang: str) -> List[Dict[str, Any]]:
    """Internet Archive advancedsearch for mediatype:text (public domain)."""
    query = f"title:({q}) AND mediatype:(texts)"
    params = {
        "q": query,
        "fl": "identifier,title,creator,language,year",
        "rows": 30,
        "page": 1,
    }
    # archive.org returns an HTML page unless output=json is explicit.
    params["output"] = "json"
    resp = await client.get(f"{ARCHIVE_BASE}/advancedsearch.php", params=params)
    resp.raise_for_status()
    try:
        data = resp.json()
    except ValueError as exc:
        # Archive sometimes returns an empty/chunked body; retry once.
        resp2 = await client.get(f"{ARCHIVE_BASE}/advancedsearch.php", params=params)
        resp2.raise_for_status()
        data = resp2.json() if resp2.content else {}
        if not isinstance(data, dict):
            raise exc
    items: List[Dict[str, Any]] = []
    for doc in data.get("response", {}).get("docs", []):
        creator = doc.get("creator")
        if isinstance(creator, list):
            creator = creator[0]
        items.append({
            "source": "archive",
            "source_id": str(doc.get("identifier", "")),
            "title": (doc.get("title") or "").strip(),
            "author": (creator or "").strip() or None,
            "language": (doc.get("language") or lang),
            "url": f"{ARCHIVE_BASE}/details/{doc.get('identifier', '')}",
            "cover_url": "",
            "has_audio": False,
            "has_text": True,
        })
    return items


# --- Merging ----------------------------------------------------------------

def merge_results(raw_items: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Merge entries with the same normalized title+author into one item."""
    merged: Dict[str, Dict[str, Any]] = {}
    order: List[str] = []
    for item in raw_items:
        key = normalize_key(item.get("title", ""), item.get("author"))
        if not key:
            continue
        if key not in merged:
            merged[key] = {
                "key": key,
                "title": item.get("title", ""),
                "author": item.get("author"),
                "language": item.get("language"),
                "cover_url": item.get("cover_url", ""),
                "has_audio": bool(item.get("has_audio")),
                "has_text": bool(item.get("has_text")),
                "sources": [
                    {"source": item["source"], "source_id": item.get("source_id", ""), "url": item.get("url", "")}
                ],
            }
            order.append(key)
        else:
            entry = merged[key]
            entry["has_audio"] = entry["has_audio"] or bool(item.get("has_audio"))
            entry["has_text"] = entry["has_text"] or bool(item.get("has_text"))
            if not entry["cover_url"] and item.get("cover_url"):
                entry["cover_url"] = item["cover_url"]
            existing_ids = {s["source_id"] for s in entry["sources"]}
            if item.get("source_id") not in existing_ids:
                entry["sources"].append(
                    {"source": item["source"], "source_id": item.get("source_id", ""), "url": item.get("url", "")}
                )
    return [merged[k] for k in order]


def openlibrary_cover_url(sources: List[Dict[str, Any]], title: str) -> str:
    """Open Library Covers fallback: first Gutenberg id found, else title search."""
    for s in sources:
        if s["source"] == "gutenberg" and s.get("source_id"):
            return f"https://covers.openlibrary.org/b/gutenberg/{s['source_id']}-M.jpg?default=false"
    if title:
        return f"https://covers.openlibrary.org/b/title/{title.strip()}-M.jpg?default=false"
    return ""


# --- Cache ------------------------------------------------------------------

def _cache_get(q: str, lang: str, db_path: Optional[Any] = None) -> Optional[Dict[str, Any]]:
    conn = get_connection(db_path)
    try:
        row = conn.execute(
            "SELECT payload, cached_at FROM search_cache WHERE q = ? AND lang = ?", (q, lang)
        ).fetchone()
        if not row:
            return None
        cached_at = datetime.fromisoformat(row["cached_at"])
        if _now_utc() - cached_at <= timedelta(hours=CACHE_TTL_HOURS):
            return json.loads(row["payload"])
        conn.execute("DELETE FROM search_cache WHERE q = ? AND lang = ?", (q, lang))
        conn.commit()
        return None
    finally:
        conn.close()


def _cache_set(q: str, lang: str, payload: Dict[str, Any], db_path: Optional[Any] = None) -> None:
    conn = get_connection(db_path)
    try:
        conn.execute(
            """INSERT INTO search_cache (q, lang, payload, cached_at)
               VALUES (?, ?, ?, ?)
               ON CONFLICT(q, lang) DO UPDATE SET payload = excluded.payload, cached_at = excluded.cached_at""",
            (q, lang, json.dumps(payload), _now_utc().isoformat(timespec="seconds")),
        )
        conn.commit()
    finally:
        conn.close()


# --- Public entry point -------------------------------------------------------

async def search_books(
    q: str,
    lang: str = "pt",
    db_path: Optional[Any] = None,
    client: Optional[httpx.AsyncClient] = None,
) -> Dict[str, Any]:
    """Search all sources in parallel, merge, cache for 24h and return results."""
    q = (q or "").strip()
    if not q:
        return {"query": "", "lang": lang, "results": [], "errors": {}, "cached": False}

    cached = _cache_get(q, lang, db_path)
    if cached is not None:
        cached["cached"] = True
        return cached

    fetchers = {
        "librivox": fetch_librivox,
        "gutenberg": fetch_gutendex,
        "archive": fetch_archive,
    }
    errors: Dict[str, str] = {}
    raw_items: List[Dict[str, Any]] = []

    own_client = client is None
    if own_client:
        client = httpx.AsyncClient(timeout=10.0, headers={"User-Agent": "Bookly/0.1 (personal library app)"})
    try:
        responses = await asyncio_gather(client, fetchers, q, lang)
    finally:
        if own_client:
            await client.aclose()

    for source, resp in responses.items():
        if isinstance(resp, Exception):
            errors[source] = str(resp)
            # Gutendex down on this network: try the OPDS catalogue fallback.
            if source == "gutenberg":
                try:
                    with httpx.Client(timeout=15.0, headers={"User-Agent": "Bookly/0.1 (personal library app)"}, follow_redirects=True) as sync_client:
                        raw_items.extend(fetch_gutenberg_opds_sync(sync_client, q, lang))
                except Exception as fallback_exc:
                    errors["gutenberg_opds"] = str(fallback_exc)
        else:
            raw_items.extend(resp)

    merged = merge_results(raw_items)
    for item in merged:
        if not item["cover_url"]:
            item["cover_url"] = openlibrary_cover_url(item["sources"], item["title"])

    payload = {"query": q, "lang": lang, "results": merged, "errors": errors, "cached": False}
    _cache_set(q, lang, payload, db_path)
    return payload


async def asyncio_gather(client: httpx.AsyncClient, fetchers: Dict[str, Any], q: str, lang: str) -> Dict[str, Any]:
    """Run every fetcher concurrently; per-source failures/timeouts become exception values."""
    timeout = float(cfg("source_timeout_sec", 10))
    tasks = {
        name: asyncio.create_task(asyncio.wait_for(fetcher(client, q, lang), timeout=timeout))
        for name, fetcher in fetchers.items()
    }
    results: Dict[str, Any] = {}
    for name, task in tasks.items():
        try:
            results[name] = await task
        except Exception as exc:  # keep going: other sources still return
            results[name] = exc
    return results
