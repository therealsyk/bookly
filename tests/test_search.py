"""Search service tests with mocked HTTP responses (no network).

A fake httpx.AsyncClient returns canned JSON per URL pattern, so the three
source fetchers run for real against simulated payloads.
"""

from __future__ import annotations

import json
import tempfile
from pathlib import Path
from typing import Any, Dict, Optional

import httpx

from backend.db import init_db
from backend.services.search import (
    fetch_archive,
    fetch_gutendex,
    fetch_librivox,
    merge_results,
    normalize_key,
    openlibrary_cover_url,
    search_books,
)

LIBRIVOX_JSON = {
    "books": [
        {
            "id": 1234,
            "title": "Dom Cazaril",
            "author": "Camilo Castelo Branco",
            "coverarturl": "https://librivox.org/img/covers/1234.jpg",
            "url": "https://librivox.org/books/dom-cazaril/",
            "language": "Portuguese",
        }
    ]
}

GUTENDEX_JSON = {
    "results": [
        {
            "id": 50001,
            "title": "Dom Cazaril",
            "author": "Camilo Castelo Branco",
            "language": "pt",
            "bookshelf": "https://www.gutenberg.org/ebooks/50001",
            "cover": "https://gutenberg.net.au/images/books/50/50001.jpg",
        }
    ]
}

ARCHIVE_JSON = {
    "response": {
        "docs": [
            {"identifier": "domcazaril00cast", "title": "Dom Cazaril", "creator": ["Camilo Castelo Branco"], "language": "por"}
        ]
    }
}


class FakeResponse:
    def __init__(self, payload: Any, status: int = 200):
        self._payload = payload
        self.status_code = status

    def raise_for_status(self) -> None:
        if self.status_code >= 400:
            raise httpx.HTTPStatusError(f"HTTP {self.status_code}", request=None, response=None)

    def json(self) -> Any:
        return self._payload


class FakeClient:
    """Minimal async client stand-in: matches URL substrings to payloads."""

    def __init__(self, mapping: Dict[str, Any], fail_sources: Optional[set] = None):
        self.mapping = mapping
        self.fail_sources = fail_sources or set()

    async def get(self, url: str, params: Any = None) -> FakeResponse:
        if "librivox" in url and "librivox" in self.fail_sources:
            raise httpx.ConnectError("simulated LibriVox failure")
        if "gutendex" in url and "gutenberg" in self.fail_sources:
            raise httpx.ConnectTimeout("simulated Gutendex timeout")
        if "archive.org" in url and "archive" in self.fail_sources:
            raise httpx.ConnectError("simulated Archive failure")
        for key, payload in self.mapping.items():
            if key in url:
                return FakeResponse(payload)
        return FakeResponse({"response": {"docs": []}})

    async def aclose(self) -> None:
        pass


def _client(**kwargs: Any) -> FakeClient:
    mapping = {"librivox": LIBRIVOX_JSON, "gutendex": GUTENDEX_JSON, "archive.org": ARCHIVE_JSON}
    return FakeClient(mapping, fail_sources=kwargs.get("fail_sources", set()))


# --- Unit tests ---------------------------------------------------------------

def test_normalize_key_strips_accents_and_punctuation():
    assert normalize_key("Dom Cazaril!", "Camilo Castelo Branco") == "dom cazaril camilo castelo branco"
    assert normalize_key("Os Lusíadas", "José Nunes de Figueiredo") == "os lusiadas jose nunes de figueiredo"


def test_merge_results_combines_same_book():
    items = [
        {"source": "librivox", "source_id": "1234", "title": "Dom Cazaril", "author": "Camilo Castelo Branco",
         "language": "portuguese", "url": "https://librivox.org/x", "cover_url": "lv.jpg", "has_audio": True, "has_text": False},
        {"source": "gutenberg", "source_id": "50001", "title": "Dom Cazaril", "author": "Camilo Castelo Branco",
         "language": "pt", "url": "https://gutenberg.org/y", "cover_url": "", "has_audio": False, "has_text": True},
    ]
    merged = merge_results(items)
    assert len(merged) == 1
    m = merged[0]
    assert m["has_audio"] and m["has_text"]
    assert {s["source"] for s in m["sources"]} == {"librivox", "gutenberg"}
    assert m["cover_url"] == "lv.jpg"


def test_openlibrary_cover_fallback():
    url = openlibrary_cover_url([{"source": "gutenberg", "source_id": "50001", "url": ""}], "Dom Cazaril")
    assert "covers.openlibrary.org/b/gutenberg/50001" in url
    url2 = openlibrary_cover_url([{"source": "archive", "source_id": "abc", "url": ""}], "Dom Cazaril")
    assert "covers.openlibrary.org/b/title/Dom%20Cazaril" in url2 or "covers.openlibrary.org/b/title/Dom Cazaril" in url2


def test_search_books_merges_and_flags():
    with tempfile.TemporaryDirectory() as tmp:
        db = Path(tmp) / "test.db"
        init_db(db)
        result = _run(search_books("Dom Cazaril", "pt", db_path=db, client=_client()))
        assert result["errors"] == {}
        assert len(result["results"]) == 1
        item = result["results"][0]
        assert item["has_audio"] is True and item["has_text"] is True
        assert len(item["sources"]) == 3
        assert item["cover_url"]  # librivox cover kept


def test_search_books_reports_errors_and_keeps_others():
    with tempfile.TemporaryDirectory() as tmp:
        db = Path(tmp) / "test.db"
        init_db(db)
        result = _run(search_books("Dom Cazaril", "pt", db_path=db, client=_client(fail_sources={"librivox"})))
        assert "librivox" in result["errors"]
        assert len(result["results"]) == 1
        item = result["results"][0]
        assert item["has_audio"] is False and item["has_text"] is True


def test_search_books_cache_24h():
    with tempfile.TemporaryDirectory() as tmp:
        db = Path(tmp) / "test.db"
        init_db(db)
        first = _run(search_books("Dracula", "pt", db_path=db, client=_client()))
        assert first["cached"] is False
        # Second call must hit the cache even with a client that would fail.
        second = _run(search_books("Dracula", "pt", db_path=db, client=_client(fail_sources={"librivox", "gutenberg", "archive"})))
        assert second["cached"] is True
        assert len(second["results"]) == len(first["results"])


def test_search_books_empty_query():
    result = _run(search_books("", "pt"))
    assert result["results"] == [] and result["errors"] == {}


def _run(coro):
    import asyncio
    return asyncio.run(coro)
