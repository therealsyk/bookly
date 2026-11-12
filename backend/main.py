"""Bookly FastAPI application.

Serves the JSON API under /api and the static PWA frontend at /.
Run with: uvicorn backend.main:app  (see run.bat).
"""

from __future__ import annotations

from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from backend.config import FRONTEND_DIR, HOST, PORT
from backend.db import init_db


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Create the database and data folders on startup."""
    init_db()
    yield


app = FastAPI(title="Bookly API", version="0.1.0", lifespan=lifespan)


# --- API ------------------------------------------------------------------

@app.get("/api/health")
def health() -> dict:
    """Simple health check used by the frontend and tests."""
    return {"status": "ok", "app": "bookly"}


from backend.routers.search import router as search_router
from backend.routers.library import router as library_router

app.include_router(search_router)
app.include_router(library_router)

# More API routers (books, audio, progress, settings) are added in later
# prompts; routers/ and services/ packages are ready for them.


# --- Frontend (static PWA) ------------------------------------------------

if FRONTEND_DIR.exists():
    app.mount("/", StaticFiles(directory=str(FRONTEND_DIR), html=True), name="frontend")
else:
    @app.get("/")
    def no_frontend() -> JSONResponse:
        return JSONResponse({"error": "frontend folder not found"}, status_code=404)


def main() -> None:
    """Entry point used by run.bat."""
    import uvicorn

    uvicorn.run("backend.main:app", host=HOST, port=PORT, reload=False)


if __name__ == "__main__":
    main()
