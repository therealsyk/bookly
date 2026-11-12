"""Tests for the audio router (Phase 4): track list, Range streaming, resume.

The global conftest.py already points DATA_DIR (and therefore DB_PATH and
AUDIO_DIR in config) at a temporary folder, so no monkeypatching is needed:
we just init_db() and write into config.AUDIO_DIR.
"""

import pytest
from fastapi.testclient import TestClient

from backend.config import AUDIO_DIR
from backend.db import add_book, add_track, init_db
from backend.main import app


@pytest.fixture()
def client():
    init_db()
    with TestClient(app) as c:
        yield c


def make_book(c):
    book = add_book(
        title="Test Book", source="librivox", source_id="t1", author="Author",
        language="en", cover_path=None, kind="audio", text_path=None,
    )
    AUDIO_DIR.mkdir(parents=True, exist_ok=True)
    mp3 = AUDIO_DIR / f"{book['id']}_0.mp3"
    # A tiny payload (content is irrelevant for Range tests).
    mp3.write_bytes(b"ID3" + b"\x00" * 200)
    track = add_track(book["id"], str(mp3), 0, "Chapter 1", 120)
    return book, track


def test_tracks_list(client):
    book, track = make_book(client)
    res = client.get(f"/api/audio/{book['id']}")
    assert res.status_code == 200
    data = res.json()
    assert len(data["tracks"]) == 1
    t = data["tracks"][0]
    assert t["chapter_index"] == 0
    assert t["url"] == f"/api/audio/file/{track['id']}"
    assert t["available"] is True


def test_audio_file_supports_range(client):
    book, track = make_book(client)
    res = client.get(f"/api/audio/file/{track['id']}", headers={"Range": "bytes=0-9"})
    assert res.status_code == 206
    assert len(res.content) == 10
    assert "audio" in res.headers["content-type"]


def test_audio_file_missing(client):
    res = client.get("/api/audio/file/999")
    assert res.status_code == 404


def test_progress_listen_resume(client):
    book, _ = make_book(client)
    res = client.put(f"/api/progress/{book['id']}", json={
        "mode": "listen", "position": 37.5, "chapter_index": 0, "percent": 0.31
    })
    assert res.status_code == 200
    got = client.get(f"/api/progress/{book['id']}").json()
    listen = [p for p in got["progress"] if p["mode"] == "listen"][0]
    assert listen["position"] == 37.5
    assert listen["chapter_index"] == 0


def test_prefs_speed_and_sleep(client):
    res = client.put("/api/prefs", json={"speed": 1.25, "sleep_minutes": 30})
    assert res.status_code == 200
    prefs = res.json()
    assert prefs["speed"] == 1.25
    assert prefs["sleep_minutes"] == 30
    # Invalid values are dropped: the previously saved value is kept.
    bad = client.put("/api/prefs", json={"speed": 9, "sleep_minutes": 999}).json()
    assert bad.get("speed") == 1.25
    assert bad.get("sleep_minutes") == 30
