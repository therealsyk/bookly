import { addBook, findBookBySource, findBookByTitle, createJob, updateJob, savePages, addTrack, getBook, updateBook } from "./db.js";
import { splitIntoPages, htmlToText } from "./paginate.js";
import { fetchText } from "./sources/_common.js";
import * as gutenbergOpds from "./sources/openlibrary.js"; // OPDS/text helpers (file name kept)
import { getFiles, downloadUrl } from "./sources/archive.js";
import { getAudioTracksForBook } from "./audio.js";

// Client-side "download": fetch text, paginate, store in IndexedDB.
// Progress is exposed through the jobs store so the UI can poll it.
export async function addFromSource({ source, source_id, title, author, language }) {
  let book = await findBookBySource(source, source_id);
  if (!book && title) book = await findBookByTitle(title);
  if (book) return { book, deduplicated: true };

  book = await addBook({
    source,
    source_id,
    title: title || "Untitled",
    author: author || "",
    language: language || "en",
    kind: source === "librivox" ? "audio" : "text",
    cover_url: null,
  });

  // One job per book (book.id as key) so the UI can poll it directly.
  const job = await createJob(book.id, { source, source_id, title: book.title });
  runDownload(book, job).catch((err) => updateJob(book.id, { status: "error", error: String(err.message || err) }));
  return { book, deduplicated: false };
}

async function runDownload(book, job) {
  await updateJob(job.id, { status: "running" });

  // 1. Resolve text source.
  let text = null;
  if (book.source === "gutenberg") {
    const url = gutenbergOpds.textUrl(book.source_id);
    text = htmlToText(await fetchText(url));
  } else if (book.source === "archive") {
    const files = await getFiles(book.source_id);
    if (!files.text) throw new Error("no text file on this Archive item");
    text = await fetchText(downloadUrl(book.source_id, files.text));
  } else if (book.source === "librivox") {
    // LibriVox books are audio-only; text comes from the matching project page.
    text = ""; // no companion text guaranteed -> reader shows empty until imported
  }

  if (text) {
    const pages = splitIntoPages(text);
    await savePages(book.id, pages);
    await updateJob(job.id, { status: "done", total_items: 1, done_items: 1, percent: 100 });
  } else {
    await updateJob(job.id, { status: "done", total_items: 0, done_items: 0, percent: 100 });
  }

  // 2. Audio tracks (LibriVox / Archive MP3s), validated with real requests.
  try {
    const tracks = await getAudioTracksForBook(book.source, book.source_id);
    if (tracks.length) {
      for (const tr of tracks) await addTrack({ book_id: book.id, ...tr });
      const updated = await getBook(book.id);
      if (updated && updated.kind !== "both") {
        await updateBook(book.id, { kind: updated.kind === "audio" ? "audio" : "both" });
      }
    }
  } catch (err) {
    // Audio failure must be reported, not hidden.
    await updateJob(job.id, { error: `audio: ${err.message}` });
  }
}

// Import a file chosen by the user (PDF handled in pdfImport.js).
export async function importTextFile(name, text, titleHint) {
  const title = titleHint || name.replace(/\.[a-z]+$/i, "");
  let book = await findBookByTitle(title);
  if (book) return { book, deduplicated: true };
  book = await addBook({ source: "local", source_id: name, title, author: "", language: "en", kind: "text" });
  const pages = splitIntoPages(text);
  await savePages(book.id, pages);
  return { book, deduplicated: false };
}
