"""Preferences router: GET/PUT /api/prefs and GET /api/recommendations.

Preferences (genres, book languages, format, favorite authors, ui_language)
are stored as a JSON blob in the settings table under key "prefs". The
ui_language setting is kept separately for the frontend language detection.
"""

from __future__ import annotations

import json
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Query

from backend.db import get_setting, set_setting
from backend.services.recommendations import DEFAULT_PREFS, get_recommendations, prefs_hash

router = APIRouter(prefix="/api", tags=["prefs"])

VALID_GENRES = {
    "fiction", "romance", "detective", "scifi", "fantasy", "adventure",
    "poetry", "drama", "classics", "history", "philosophy", "children", "other",
}
VALID_FORMATS = {"audio", "text", "both"}


def _clean_prefs(raw: Dict[str, Any]) -> Dict[str, Any]:
    """Validate and normalize a preferences payload."""
    prefs = dict(DEFAULT_PREFS)
    ui_language = get_setting("ui_language", "auto")
    prefs["ui_language"] = ui_language or "auto"

    genres = raw.get("genres")
    if isinstance(genres, list):
        prefs["genres"] = [g for g in genres if g in VALID_GENRES]

    langs = raw.get("book_languages")
    if isinstance(langs, list):
        prefs["book_languages"] = [str(l).lower() for l in langs if l]

    fmt = raw.get("format")
    if fmt in VALID_FORMATS:
        prefs["format"] = fmt

    authors = raw.get("authors")
    if isinstance(authors, list):
        prefs["authors"] = [str(a).strip() for a in authors if str(a).strip()]

    onboarded = raw.get("onboarded")
    if isinstance(onboarded, bool):
        prefs["onboarded"] = onboarded

    return prefs


@router.get("/prefs")
def api_get_prefs() -> Dict[str, Any]:
    """Return stored preferences (defaults when nothing was saved)."""
    raw = get_setting("prefs")
    if not raw:
        prefs = dict(DEFAULT_PREFS)
        prefs["ui_language"] = get_setting("ui_language", "auto") or "auto"
        return prefs
    try:
        import json

        stored = json.loads(raw)
    except (ValueError, TypeError):
        stored = {}
    return _clean_prefs(stored)


@router.put("/prefs")
def api_put_prefs(payload: Dict[str, Any]) -> Dict[str, Any]:
    """Save preferences as JSON in settings; also mirrors ui_language."""
    prefs = _clean_prefs(payload)
    set_setting("prefs", json.dumps(prefs, ensure_ascii=False))
    set_setting("ui_language", prefs["ui_language"])
    return prefs


@router.get("/recommendations")
async def api_recommendations() -> Dict[str, Any]:
    """Suggestions based on saved preferences, excluding library books, cached 24h."""
    raw = get_setting("prefs")
    prefs = _clean_prefs(json.loads(raw)) if raw else dict(DEFAULT_PREFS)
    return await get_recommendations(prefs)
