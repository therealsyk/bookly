import { addBook, findBookByTitle, savePages } from "./db.js";
import { splitIntoPages, cleanPdfText } from "./paginate.js";

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

  const cleaned = cleanPdfText(allLines);
  if (!cleaned || cleaned.length < 20) {
    throw new Error("este PDF não tem texto selecionável");
  }

  const title = titleHint || file.name.replace(/\.pdf$/i, "");
  let book = await findBookByTitle(title);
  if (book) return { book, deduplicated: true };
  book = await addBook({ source: "pdf", source_id: file.name, title, author: "", language: "en", kind: "text" });
  const pages = splitIntoPages(cleaned);
  await savePages(book.id, pages);
  return { book, deduplicated: false };
}
