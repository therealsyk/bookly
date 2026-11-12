import { CONFIG } from "./config.js";

// Exact port of backend/services/downloader.py split_into_pages():
//   sentences = re.findall(r"[^.!?…\n]+[.!?…]?|\n+", text)
//   accumulate until > PAGE_SIZE, cut at end-of-sentence.
export function splitIntoPages(text, pageSize = CONFIG.PAGE_SIZE) {
  const sentences = text.match(/[^.!?\u2026\n]+[.!?\u2026]?|\n+/g) || [];
  const pages = [];
  let current = "";
  for (const sentence of sentences) {
    if (current.length + sentence.length > pageSize && current) {
      pages.push(current.trim());
      current = sentence;
    } else {
      current += sentence;
    }
  }
  if (current.trim()) pages.push(current.trim());
  return pages;
}

// Basic HTML -> plain text (Gutenberg pages, Archive djvu.txt are already text).
export function htmlToText(html) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  for (const el of doc.querySelectorAll("script, style, nav, figure, img")) el.remove();
  const body = doc.querySelector("body") || doc;
  return body.textContent.replace(/\s+\n/g, "\n").replace(/[ \t]{2,}/g, " ").trim();
}

// PDF text cleaning (Prompt 6b part B9): rejoin hyphen-split words at line
// ends, drop repeated headers/footers and isolated page numbers.
export function cleanPdfText(lines) {
  const out = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (/^\d{1,4}$/.test(line)) continue; // isolated page number
    out.push(line);
  }
  const text = out.join("\n");
  return text.replace(/(\w+)-\n(\w+)/g, "$1$2"); // hyphen at line end -> joined word
}
