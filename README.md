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

## Run (local-first, no server)

```bat
npm install
npm run dev     # Vite dev server for the PWA
npm run build   # static dist/ ready to serve anywhere
```

The app runs entirely in the browser with IndexedDB; the old Python backend lives in `legacy/backend/` (kept for reference and parity tests).

## Test

```bat
npm run test    # Vitest (frontend parity, TTS, settings/backup, ISPSN parser)
python tools/check_locales.py         # verify every locale has all reference keys
cd legacy && python -m pytest tests   # legacy backend suite
```
