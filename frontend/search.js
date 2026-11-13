import { cacheGet, cachePut } from "./db.js";
import * as librivox from "./sources/librivox.js";
import * as gutendex from "./sources/gutendex.js";
import * as gutenbergOpds from "./sources/openlibrary.js"; // Gutenberg OPDS fallback (file name kept for mapping)
import * as archive from "./sources/archive.js";
import * as googlebooks from "./sources/googlebooks.js";

const PUBLIC_SOURCES = [
  { name: "librivox", fn: librivox.search },
  { name: "gutenberg", fn: gutendex.search, fallback: gutenbergOpds.search },
  { name: "archive", fn: archive.search },
  { name: "googlebooks", fn: googlebooks.search },
];

// Parallel search + merge (same logic as services/search.py): one item per
// normalized title+author with has_audio/has_text flags and visible sources.
export async function searchBooks(query, lang = "en") {
  const cached = await cacheGet(query, lang);
  if (cached) return { query, lang, results: cached.results, errors: cached.errors, cached: true };

  const errors = {};
  const settled = await Promise.allSettled(PUBLIC_SOURCES.map((s) => s.fn(query, lang)));

  const items = [];
  for (let i = 0; i < settled.length; i++) {
    const res = settled[i];
    if (res.status === "fulfilled") {
      items.push(...res.value);
    } else {
      errors[PUBLIC_SOURCES[i].name] = String(res.reason && res.reason.message || res.reason);
      // Gutenberg fallback when Gutendex is down.
      const fb = PUBLIC_SOURCES[i].fallback;
      if (fb) {
        try {
          items.push(...(await fb(query, lang)));
          errors[`${PUBLIC_SOURCES[i].name}_fallback`] = "ok (OPDS used)";
        } catch (e2) {
          errors[`${PUBLIC_SOURCES[i].name}_fallback`] = String(e2.message || e2);
        }
      }
    }
  }

  const merged = new Map();
  for (const it of items) {
    const key = it.key || it.title.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    const existing = merged.get(key);
    if (existing) {
      existing.has_audio = existing.has_audio || it.has_audio;
      existing.has_text = existing.has_text || it.has_text;
      existing.sources.push({ source: it.source, source_id: it.source_id, url: it.url });
      if (!existing.cover_url && it.cover_url) existing.cover_url = it.cover_url;
      if (it.pdf_url) existing.pdf_url = it.pdf_url;
    } else {
      merged.set(key, {
        key,
        title: it.title,
        author: it.author,
        language: it.language,
        cover_url: it.cover_url || null,
        has_audio: !!it.has_audio,
        has_text: !!it.has_text,
        pdf_url: it.pdf_url || null,
        url: it.url,
        sources: [{ source: it.source, source_id: it.source_id, url: it.url }],
      });
    }
  }

  const results = [...merged.values()];
  await cachePut(query, lang, { results, errors });
  return { query, lang, results, errors, cached: false };
}

// Mini-assistant pick: the best result to auto-download for a query.
// Prefers items with a direct PDF URL (Google Books free PDFs), then any
// source with downloadable text. Returns null if nothing can be fetched.
export function pickBestResult(results) {
  if (!results || !results.length) return null;
  const withPdf = results.find((r) => r.pdf_url);
  if (withPdf) return withPdf;
  return results.find((r) => r.sources && r.sources.some((s) => s.text_url)) || null;
}
