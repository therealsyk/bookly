import { addBook, findBookByTitle, savePages } from "./db.js";
import { splitIntoPages, cleanPdfText } from "./paginate.js";
import { fetchText } from "./sources/_common.js";

// Fetch a PDF from a URL (same timeout/proxy rules as the sources) and extract
// its text page by page. Returns { lines, numPages }. Scanned/no-text PDFs throw.
export async function fetchPdfLines(url) {
  const pdfjs = await import("pdfjs-dist");
  const pdf = await pdfjs.default.getDocument({ url: url }).promise;
  const allLines = [];
  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const content = await page.getTextContent();
    allLines.push(...content.items.map((it) => it.str).filter(Boolean));
    if (p % 50 === 0) await new Promise((r) => setTimeout(r, 0)); // yield to UI
  }
  return { lines: allLines, numPages: pdf.numPages };
}

// Assistant flow: download a PDF from a URL and add it as a "pdf" book.
export async function importPdfUrl(url, titleHint) {
  const { lines } = await fetchPdfLines(url);
  const title = titleHint || url.split("/").pop().replace(/\.pdf$/i, "") || "Imported PDF";
  const { pages } = preparePdfText(lines, title);

  let book = await findBookByTitle(title);
  if (book) return { book, deduplicated: true };
  book = await addBook({ source: "pdf", source_id: url, title, author: "", language: "en", kind: "text" });
  await savePages(book.id, pages);
  return { book, deduplicated: false };
}

// Pure step used by both the real extractor and tests: given raw text lines
// from a PDF, clean them and return pages. Throws for scanned/no-text PDFs.
export function preparePdfText(lines, title) {
  const cleaned = cleanPdfText(lines);
  if (!cleaned || cleaned.length < 20) {
    throw new Error("este PDF não tem texto selecionável");
  }
  return { cleaned, pages: splitIntoPages(cleaned), title };
}

// PDF import via pdfjs-dist. Text is extracted page by page (blocks) so a
// large book does not blow up iPhone memory. Scanned PDFs -> clear message.
export async function importPdf(file, titleHint) {
  const pdfjs = await import("pdfjs-dist");
  const data = await file.arrayBuffer();
  const pdf = await pdfjs.default.getDocument({ data }).promise;

  const allLines = [];
  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const content = await page.getTextContent();
    // Blocks: items already grouped; join with spaces, lines between items.
    const lines = content.items.map((it) => it.str).filter(Boolean);
    allLines.push(...lines);
    if (p % 50 === 0) await new Promise((r) => setTimeout(r, 0)); // yield to UI
  }

  const title = titleHint || file.name.replace(/\.pdf$/i, "");
  const { pages } = preparePdfText(allLines, title);

  let book = await findBookByTitle(title);
  if (book) return { book, deduplicated: true };
  book = await addBook({ source: "pdf", source_id: file.name, title, author: "", language: "en", kind: "text" });
  await savePages(book.id, pages);
  return { book, deduplicated: false };
}
