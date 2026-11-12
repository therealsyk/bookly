import { fetchJson, langCode } from "./_common.js";

const BASE = "https://librivox.org";

// Verified endpoint: /api/feed/audiobooks (returns {"books": [...]}) - tested live.
export async function search(query, lang) {
  const url = `${BASE}/api/feed/audiobooks?format=json&search=${encodeURIComponent(query)}&limit=30`;
  const data = await fetchJson(url);
  return (data.books || []).map((b) => ({
    key: normalize(b.title),
    title: b.title,
    author: (b.authors || []).map((a) => `${a.first_name || ""} ${a.last_name || ""}`.trim()).join(", ") || "",
    language: b.language || "en",
    cover_url: null,
    has_audio: true,
    has_text: false,
    url: b.url_librivox || b.url_project || "",
    source: "librivox",
    source_id: String(b.id),
  }));
}

// Project metadata -> MP3 chapter list (url + length in seconds).
export async function getAudioTracks(sourceId) {
  const data = await fetchJson(`${BASE}/api/feed/audiobooks?id=${encodeURIComponent(sourceId)}&format=json`);
  const book = data.books && data.books[0];
  if (!book || !book.readers) return [];
  return book.readers.map((r, i) => ({
    chapter_index: i,
    title: r.title,
    url: r.url, // direct MP3 from archive.org mirrors; validated before saving
    duration_sec: Number(r.length) || null,
  }));
}

function normalize(title) {
  return String(title || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}
