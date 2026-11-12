# Bookly

Read and listen to public-domain books (LibriVox, Project Gutenberg via Gutendex,
Internet Archive) plus your own imported files. Backend: Python + FastAPI + SQLite.
Frontend: plain HTML/CSS/JS PWA (no frameworks, no build step).

## Structure

- `backend/` — FastAPI app (`main.py`), SQLite layer (`db.py`), config (`config.py`),
  `routers/` and `services/` packages for later phases.
- `frontend/` — PWA shell (index.html, app.js, styles.css, manifest.json, sw.js,
  `pages/`, `locales/` with pt-PT and en).
- `data/` — books/, covers/, audio/ and the SQLite database `bookly.db`.
- `tests/` — pytest suite.

## Setup

```bat
python -m venv .venv
.venv\Scripts\pip install -r requirements.txt
```

Configuration lives in `config.json` (or environment variables like `PORT`).
No API keys are needed: all sources are public and legal.

## Run

```bat
run.bat
```

Then open http://127.0.0.1:8000 and check http://127.0.0.1:8000/api/health.

## Test

```bat
pytest tests
```
