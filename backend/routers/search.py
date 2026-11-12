"""Search router: GET /api/search?q=...&lang=pt."""

from __future__ import annotations

from fastapi import APIRouter, Query

from backend.services.search import search_books

router = APIRouter(prefix="/api", tags=["search"])


@router.get("/search")
async def api_search(
    q: str = Query(..., min_length=1, description="Search query"),
    lang: str = Query("pt", description="Language filter (ISO code)"),
) -> dict:
    """Search LibriVox, Gutendex and Internet Archive in parallel."""
    return await search_books(q=q, lang=lang)
