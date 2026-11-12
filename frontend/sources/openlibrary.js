import { fetchJson } from "./_common.js";

// --- Gutenberg OPDS search (fallback when Gutendex is unreachable) --------
const GUTENBERG = "https://www.gutenberg.org";

// Verified live: /opds/search returns 200 with ACAO=*.
export async function search(query, lang) {
  const data = await fetchJson(`${GUTENBERG}/opds/search?query=${encodeURIComponent(query)}`);
  return (data.publications || []).map((p) => {
    const meta = p.metadata || {};
    const id = String(meta.identifier || "").replace(/^GUTETEXT:/i, "");
    return {
      key: normalize(meta.title),
      title: meta.title || "Untitled",
      author: meta.author && meta.author.name ? meta.author.name : "",
      language: meta.language || lang || "en",
      cover_url: p.images && p.images[0] ? p.images[0].href : null,
      has_audio: false,
      has_text: true,
      url: `${GUTENBERG}/ebooks/${id}`,
      source: "gutenberg",
      source_id: id,
    };
  });
}

// Full-text HTML page (verified live).
export function textUrl(sourceId) {
  return `${GUTENBERG}/cache/epub/${sourceId}/pg${sourceId}-images.html`;
}

// Open Library covers: cover fallback only (verified live, ACAO=*).
export function coverUrl(title, gutenbergId = null) {
  if (gutenbergId) {
    return `https://covers.openlibrary.org/b/gutenberg/${gutenbergId}-M.jpg?default=false`;
  }
  return `https://covers.openlibrary.org/b/title/${encodeURIComponent(title)}-M.jpg?default=false`;
}
