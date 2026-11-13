import { describe, it, expect } from "vitest";
import { pickBestResult } from "../search.js";

describe("pickBestResult (mini-assistant)", () => {
  it("prefers results with a direct PDF URL", () => {
    const results = [
      { title: "Audio only", sources: [{ source: "librivox", has_audio: true }] },
      { title: "Gutenberg text", sources: [{ source: "gutenberg", text_url: "https://gutenberg.org/123.txt" }] },
      { title: "Google PDF", pdf_url: "https://books.google.com/books/download.pdf", sources: [{ source: "googlebooks" }] },
    ];
    const best = pickBestResult(results);
    expect(best.title).toBe("Google PDF");
  });

  it("falls back to any result with a text_url when no PDF exists", () => {
    const results = [
      { title: "Audio only", sources: [{ source: "librivox", has_audio: true }] },
      { title: "Gutenberg text", sources: [{ source: "gutenberg", text_url: "https://gutenberg.org/123.txt" }] },
    ];
    const best = pickBestResult(results);
    expect(best.title).toBe("Gutenberg text");
  });

  it("returns null when nothing is downloadable", () => {
    const results = [{ title: "Locked", sources: [{ source: "googlebooks", has_text: false }] }];
    expect(pickBestResult(results)).toBeNull();
  });

  it("handles empty and null input", () => {
    expect(pickBestResult([])).toBeNull();
    expect(pickBestResult(null)).toBeNull();
  });
});
