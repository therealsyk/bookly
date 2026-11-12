"""Tests for preferences and recommendations (mocked HTTP, no network)."""

import asyncio
import json
from datetime import datetime, timedelta, timezone

import httpx
import pytest

from backend.db import init_db, set_setting, get_setting
from backend.services.recommendations import (
    DEFAULT_PREFS,
    _cache_get,
    _cache_set,
    get_recommendations,
    library_keys,
    prefs_hash,
)
from backend.routers.prefs import _clean_prefs


@pytest.fixture()
def db(tmp_path):
    path = tmp_path / "test.db"
    init_db(path)
    return path


# --- Preference validation ---------------------------------------------------

def test_clean_prefs_validates_genres_format_and_authors():
    raw = {
        "genres": ["fiction", "scifi", "invalid-genre"],
        "book_languages": ["PT", "en"],
        "format": "audio",
        "authors": ["  Poe  ", ""],
        "onboarded": True,
    }
    prefs = _clean_prefs(raw)
    assert prefs["genres"] == ["fiction", "scifi"]
    assert prefs["book_languages"] == ["pt", "en"]
    assert prefs["format"] == "audio"
    assert prefs["authors"] == ["Poe"]
    assert prefs["onboarded"] is True


def test_clean_prefs_defaults_when_empty():
    prefs = _clean_prefs({})
    assert prefs["ui_language"] == "auto"
    assert prefs["genres"] == []
    assert prefs["format"] == "both"
    assert prefs["onboarded"] is False


# --- Mocked recommendations --------------------------------------------------

class MockClient(httpx.AsyncClient):
    """Fake async client that returns canned JSON per URL pattern."""

    def __init__(self, responses):
        super().__init__()
        self._responses = responses

    async def get(self, url, params=None, **kwargs):
        payload = self._responses.get(url)
        if payload is None:
            raise httpx.ConnectError(f"no mock for {url}")
        return httpx.Response(200, json=payload, request=httpx.Request("GET", url))

    async def aclose(self):
        pass


GUTENDEX_BOOKS = {
    "results": [
        {"id": 1234, "title": "The Adventures of Tom Sawyer", "author": "Mark Twain",
         "language": "en", "bookshelf": "https://gutenberg.org/books/1234", "cover": ""},
        {"id": 5678, "title": "The Scarlet Letter", "author": "Nathaniel Hawthorne",
         "language": "en", "bookshelf": "https://gutenberg.org/books/5678", "cover": ""},
    ]
}

LIBRIVOX_BOOKS = {
    "books": [
        {"id": 99, "title": "The Scarlet Letter", "language": "English",
         "authors": [{"first_name": "Nathaniel", "last_name": "Hawthorne"}],
         "url_librivox": "https://librivox.org/the-scarlet-letter-by-hawthorne/"},
    ]
}


def test_recommendations_merge_exclude_library_and_cache(db):
    prefs = {"genres": ["fiction"], "book_languages": [], "format": "both", "authors": [], "onboarded": True}

    # Add a library book that matches one recommendation -> it must be excluded.
    from backend.db import add_book
    add_book(title="The Scarlet Letter", source="gutenberg", source_id="5678",
            author="Nathaniel Hawthorne", db_path=db)

    responses = {
        "https://gutendex.com/books": GUTENDEX_BOOKS,
        "https://librivox.org/api/feed/audiobooks": LIBRIVOX_BOOKS,
    }
    client = MockClient(responses)
    result = asyncio.run(get_recommendations(prefs, db_path=db, client=client))

    titles = {r["title"] for r in result["results"]}
    assert "The Scarlet Letter" not in titles  # excluded: already in library
    assert "The Adventures of Tom Sawyer" in titles
    assert result["cached"] is False

    # Second call hits the cache.
    cached = asyncio.run(get_recommendations(prefs, db_path=db, client=MockClient(responses)))
    assert cached["cached"] is True


def test_recommendations_format_audio_only(db):
    prefs = {"genres": ["fiction"], "book_languages": [], "format": "audio", "authors": [], "onboarded": True}
    responses = {
        "https://gutendex.com/books": GUTENDEX_BOOKS,
        "https://librivox.org/api/feed/audiobooks": LIBRIVOX_BOOKS,
    }
    result = asyncio.run(get_recommendations(prefs, db_path=db, client=MockClient(responses)))
    assert all(r["has_audio"] for r in result["results"])
    assert any(r["title"] == "The Scarlet Letter" for r in result["results"])


def test_recommendations_cache_expires_after_24h(db):
    prefs = {"genres": ["classics"], "book_languages": [], "format": "both", "authors": [], "onboarded": True}
    p_hash = prefs_hash(prefs)
    conn_kwargs = {"db_path": db}
    _cache_set(p_hash, {"results": [], "groups": {}, "errors": {}, "cached": False}, db)
    # Force an old timestamp.
    import sqlite3

    old = (datetime.now(timezone.utc) - timedelta(hours=25)).isoformat(timespec="seconds")
    conn = sqlite3.connect(db)
    conn.execute("UPDATE rec_cache SET cached_at = ? WHERE prefs_hash = ?", (old, p_hash))
    conn.commit()
    conn.close()
    assert _cache_get(p_hash, db) is None


def test_recommendations_errors_reported_when_source_fails(db):
    prefs = {"genres": ["fiction"], "book_languages": [], "format": "both", "authors": [], "onboarded": True}
    # No mock at all: every source fails; errors must be reported, no crash.
    client = MockClient({})
    result = asyncio.run(get_recommendations(prefs, db_path=db, client=client))
    assert result["errors"]
    assert isinstance(result["results"], list)
