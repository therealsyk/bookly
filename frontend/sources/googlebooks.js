import { fetchJson, langCode } from "./_common.js";

// Google Books API - public, key-free for this usage. Live test hit 429
// (rate limited) on this network; the endpoint itself is documented and CORS-enabled.
export async function search(query, lang) {
  const url =
    `https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(query)}` +
    `&filter=free-ebooks&langRestrict=${langCode(lang, "google")}&maxResults=20`;
  const data = await fetchJson(url);
  return (data.items || []).map((it) => {
    const info = it.volumeInfo || {};
    const access = it.accessInfo || {};
    const pdfAvailable = access.pdf && access.pdf.isAvailable;
    return {
      key: normalize(info.title),
      title: info.title || "Untitled",
      author: (info.authors || []).join(", "),
      language: info.language || lang || "en",
      cover_url: info.imageLink || null,
      has_audio: false,
      has_text: pdfAvailable, // only PDF-available items are downloadable
      pdf_url: pdfAvailable ? access.pdf.downloadLink : null,
      url: info.link || it.id,
      source: "googlebooks",
      source_id: it.id,
    };
  });
}

function normalize(title) {
  return String(title || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}
