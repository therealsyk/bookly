import { fetchJson, langCode } from "./_common.js";

const BASE = "https://gutendex.com";

// NOTE: gutendex.com times out on this network (see tools/check_cors.mjs).
// The endpoint itself is correct; if it fails the search layer reports it in
// `errors` and Gutenberg OPDS is used as fallback.
export async function search(query, lang) {
  const url = `${BASE}/books?search=${encodeURIComponent(query)}&languages=${langCode(lang, "gutenberg")}&limit=30`;
  const data = await fetchJson(url);
  return (data.results || []).map((b) => ({
    key: normalize(b.title),
    title: b.title,
    author: (b.authors || []).map((a) => a.name).join(", "),
    language: b.language || "en",
    cover_url: b.cover || null,
    has_audio: false,
    has_text: true,
    url: b.url || `https://www.gutenberg.org/ebooks/${b.id}`,
    source: "gutenberg",
    source_id: String(b.id),
  }));
}

// Plain-text download for the client (verified live: text/html works; plain
// text URLs on gutenberg.org are served with CORS allowed via cache path).
export function textUrl(sourceId) {
  return `https://www.gutenberg.org/cache/epub/${sourceId}/pg${sourceId}-images.html`;
}

function normalize(title) {
  return String(title || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}
