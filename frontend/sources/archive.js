import { fetchJson, langCode } from "./_common.js";

const BASE = "https://archive.org";

// Verified live: advancedsearch.php with q= and output=json (ACAO=*).
export async function search(query, lang) {
  const langFilter = lang ? ` AND language:(${langCode(lang, "archive")})` : "";
  const url =
    `${BASE}/advancedsearch.php?q=title%3A(${encodeURIComponent(query)})+AND+mediatype%3A(texts)` +
    langFilter +
    "&fl[]=identifier&fl[]=title&fl[]=creator&fl[]=language&rows=30&page=1&output=json";
  const data = await fetchJson(url);
  return (data.response?.docs || []).map((d) => ({
    key: normalize(d.title),
    title: d.title || "Untitled",
    author: Array.isArray(d.creator) ? d.creator[0] : d.creator || "",
    language: Array.isArray(d.language) ? d.language[0] : d.language || "en",
    cover_url: null,
    has_audio: false,
    has_text: true,
    url: `${BASE}/details/${d.identifier}`,
    source: "archive",
    source_id: d.identifier,
  }));
}

// metadata/<id> (verified live, ACAO=*). Returns text file name and MP3 files.
export async function getFiles(sourceId) {
  const data = await fetchJson(`${BASE}/metadata/${encodeURIComponent(sourceId)}`);
  const files = data.files || [];
  const text = files.find((f) => f.name.endsWith(".txt") || f.name.endsWith("_djvu.txt"))?.name || null;
  const pdf = files.find((f) => f.name.endsWith(".pdf"))?.name || null;
  const mp3s = files.filter((f) => f.name.toLowerCase().endsWith(".mp3"));
  return { text, pdf, mp3s };
}

export function downloadUrl(sourceId, name) {
  return `${BASE}/download/${encodeURIComponent(sourceId)}/${encodeURIComponent(name)}`;
}

function normalize(title) {
  return String(title || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}
