# Bookly

A 100% local PWA to read and listen to public-domain books (LibriVox, Project
Gutenberg via Gutendex, Internet Archive, Google Books) plus your own imported
PDFs. Everything runs in the browser using IndexedDB — **no server, no backend,
no API keys**. Install it on your iPhone from any static HTTPS host (GitHub
Pages or Cloudflare Pages).

## Run (local-first, no server)

```bat
npm install
npm run dev     # Vite dev server for the PWA
npm run build   # static dist/ ready to serve anywhere (GitHub/Cloudflare Pages)
```

The app is entirely client-side. The old Python backend lives in `legacy/backend/`
(kept for reference and parity tests; it can be deleted whenever you want).

## Test

```bat
npm run test                       # Vitest: pagination, search merge, progress round-trip,
                                   # PDF import, Google Books filter, language mapping,
                                   # TTS, settings/backup, ISPSN parser, PWA/offline
python tools/check_locales.py      # every locale must have all reference keys (exit 1 if missing)
node tools/check_cors.mjs          # live CORS probe of each source (see table below)
cd legacy && python -m pytest tests  # legacy backend suite (optional)
```

## Publish (HTTPS)

**Option A — GitHub Pages:** the repo already includes `.github/workflows/pages.yml`.
Push to `main`; the workflow runs `npm ci`, the Vitest suite, the locale check and
`npm run build`, then publishes `dist/`. Enable *Pages* in the repository settings.

**Option B — Cloudflare Pages:** connect the repository, set the build command to
`npm run build` and the output directory to `dist`. Both serve over HTTPS and the
manifest + Service Worker work at the published URL (all paths are relative).

## Install on the iPhone

1. Open the app in **Safari** on the iPhone (must be Safari; Chrome can't install PWAs).
2. Tap **Share** → **Add to Home Screen**.
3. It appears as a standalone icon (opens fullscreen, no browser bar).

Notes:
- Offline works only after the app has been opened **with network** at least once
  (the Service Worker precaches the shell).
- Books and PDFs already downloaded live in IndexedDB and open without internet.
- Search and downloading new books need a connection; offline you see
  "No connection. Your downloaded books are still available."

## Backup and restore

Settings → **Export** produces a JSON file (books, pages, progress, prefs, audio
tracks). **Import** validates the schema and shows a preview before replacing
anything; nothing is wiped without confirmation. ISPSN personal books are marked
`personal: true` in the export.

## CORS table (live probe — `node tools/check_cors.mjs`)

| Source | Result | Needs proxy? |
|---|---|---|
| Gutenberg OPDS search | 200, ACAO=* | No |
| Internet Archive search | 200, ACAO=* | No |
| Internet Archive metadata | 200, ACAO=* | No |
| Open Library covers | 200, ACAO=* | No |
| LibriVox search | 200, no ACAO header | Yes (CORS_PROXY_URL) |
| Gutendex search | 503 on this network | Yes (and currently unreachable here) |
| Gutenberg text download | 200, no ACAO header | Yes (CORS_PROXY_URL) |
| Google Books search | 429 rate-limited | Yes (CORS_PROXY_URL) |
| ISPSN (personal) | 200, no ACAO header | Yes; disabled by default |

Set `CORS_PROXY_URL` in `frontend/config.js` to route failing sources through the
allow-listed Cloudflare Worker (`worker/cors-proxy.js`, GET only, whitelisted
domains). It is empty by default.

## Known limitations

- iOS may stop the TTS voice when the screen is locked — keep the screen active.
- Scanned PDFs (no selectable text) are reported as "this PDF has no selectable
  text"; no OCR in this version.
- Clearing Safari site data clears the local library — make a backup.
- Gutendex was unreachable on the test network; the Gutenberg OPDS fallback is used.

## Licenses and sources

The main sources are **public-domain** books (Project Gutenberg, LibriVox) and
open-licensed content (Internet Archive items, Google Books free ebooks). Import
only files you have the right to use. The personal "ISPSN Library" source is for
the owner's private use only and is disabled by default; its books are excluded
from shared backups. No scraping of search engines or DRM/paid sites is used.
