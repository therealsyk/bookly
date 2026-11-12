"""Tests for the Bookly database layer (Phase 1)."""

import sqlite3

import pytest

from backend.db import (
    add_book,
    add_track,
    delete_book,
    delete_track,
    get_all_progress,
    get_book,
    get_progress,
    get_setting,
    init_db,
    list_books,
    list_settings,
    list_tracks,
    set_progress,
    set_setting,
    update_book,
)


@pytest.fixture()
def db(tmp_path):
    path = tmp_path / "test.db"
    init_db(path)
    return path


def test_init_db_creates_tables(db):
    conn = sqlite3.connect(db)
    names = {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    conn.close()
    assert {"books", "audio_tracks", "progress", "settings"} <= names


def test_book_crud(db):
    book = add_book("The Odyssey", "gutenberg", source_id="1726", author="Homer", language="en", kind="both", db_path=db)
    assert book["id"] > 0
    assert book["title"] == "The Odyssey"
    assert book["added_at"]

    fetched = get_book(book["id"], db)
    assert fetched["author"] == "Homer"

    updated = update_book(book["id"], db, title="Odyssey", kind="audio")
    assert updated["title"] == "Odyssey" and updated["kind"] == "audio"

    assert delete_book(book["id"], db) is True
    assert get_book(book["id"], db) is None
    assert delete_book(999, db) is False


def test_list_books_filters(db):
    add_book("Dune", "local", author="Herbert", language="en", kind="text", db_path=db)
    add_book("Dom Casmurro", "gutenberg", author="Machado", language="pt", kind="audio", db_path=db)
    assert len(list_books(db_path=db)) == 2
    assert [b["title"] for b in list_books(search="casmurro", db_path=db)] == ["Dom Casmurro"]
    assert [b["title"] for b in list_books(kind="audio", db_path=db)] == ["Dom Casmurro"]
    assert len(list_books(language="en", db_path=db)) == 1


def test_tracks_crud_and_cascade(db):
    book = add_book("A", "librivox", db_path=db)
    t1 = add_track(book["id"], "data/audio/a01.mp3", chapter_index=1, title="Ch 1", duration_sec=120.5, db_path=db)
    add_track(book["id"], "data/audio/a02.mp3", chapter_index=2, db_path=db)
    tracks = list_tracks(book["id"], db)
    assert len(tracks) == 2
    assert tracks[0]["id"] == t1["id"]

    assert delete_track(t1["id"], db) is True
    assert len(list_tracks(book["id"], db)) == 1

    delete_book(book["id"], db)
    assert list_tracks(book["id"], db) == []  # cascade removed tracks


def test_progress_upsert(db):
    book = add_book("B", "local", db_path=db)
    set_progress(book["id"], "read", position=100, percent=12.5, db_path=db)
    set_progress(book["id"], "read", position=200, percent=25.0, db_path=db)  # upsert, not duplicate
    p = get_progress(book["id"], "read", db)
    assert p["position"] == 200 and p["percent"] == 25.0
    assert len(get_all_progress(book["id"], db)) == 1

    set_progress(book["id"], "listen", chapter_index=3, percent=40, db_path=db)
    assert len(get_all_progress(book["id"], db)) == 2
    assert get_progress(book["id"], "tts", db) is None


def test_settings(db):
    set_setting("theme", "dark", db)
    assert get_setting("theme", db_path=db) == "dark"
    set_setting("theme", "light", db)
    assert list_settings(db) == {"theme": "light"}
    assert get_setting("missing", default="x", db_path=db) == "x"
