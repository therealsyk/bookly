// Prompt 9 tests: manifest validity + offline behaviour with a simulated SW.
import { describe, it, expect } from "vitest";
import "fake-indexeddb/auto";
import { openDb, addBook, savePages, getPages, deleteBook, listBooks } from "../db.js";

async function freshDb() {
  await openDb();
  for (const book of await listBooks()) await deleteBook(book.id);
}

describe("manifest", () => {
  let manifest;
  it("has the required fields", async () => {
    const fs = await import("fs");
    manifest = JSON.parse(fs.readFileSync("frontend/manifest.json", "utf-8"));
    expect(manifest.name).toBe("Bookly");
    expect(manifest.short_name).toBe("Bookly");
    expect(manifest.start_url).toBeTruthy();
    expect(manifest.display).toBe("standalone");
    expect(manifest.theme_color).toBeTruthy();
    expect(manifest.background_color).toBeTruthy();
    expect(manifest.lang).toBe("pt-PT");
  });

  it("has 192, 512 and maskable icons and the icon files exist", async () => {
    const fs = await import("fs");
    const sizes = manifest.icons.map((i) => i.sizes);
    expect(sizes).toContain("192x192");
    expect(sizes).toContain("512x512");
    const maskable = manifest.icons.find((i) => i.purpose === "maskable");
    expect(maskable).toBeTruthy();
    for (const icon of manifest.icons) {
      const path = "frontend" + icon.src;
      expect(fs.existsSync(path)).toBe(true); // icons must actually exist on disk
      const size = fs.statSync(path).size;
      expect(size).toBeGreaterThan(0);
    }
  });

  it("index.html has the iOS meta tags", async () => {
    const fs = await import("fs");
    const html = fs.readFileSync("frontend/index.html", "utf-8");
    expect(html).toContain("apple-mobile-web-app-capable");
    expect(html).toContain("apple-touch-icon");
    expect(html).toContain("apple-mobile-web-app-status-bar-style");
  });
});

describe("service worker script", () => {
  it("has no absolute server URLs or secrets", async () => {
    const fs = await import("fs");
    const sw = fs.readFileSync("frontend/sw.js", "utf-8");
    // Only relative paths and the whitelisted external domains are allowed.
    // No localhost, no http:// except the known public sources via config.
    expect(sw).not.toMatch(/localhost/i);
    // No hardcoded API keys or credentials in the worker.
    expect(sw).not.toMatch(/api_key|apiKey|credential/i);
    expect(sw).toContain("bookly-shell");
    expect(sw).toContain("bookly-audio");
  });

  it("audio cache respects the 500 MB cap", async () => {
    const fs = await import("fs");
    const sw = fs.readFileSync("frontend/sw.js", "utf-8");
    expect(/MAX_AUDIO_BYTES\s*=\s*500\s*\*\s*1024\s*\*\s*1024/.test(sw)).toBe(true);
  });
});

describe("offline books from IndexedDB", () => {
  it("a stored book opens without any network (simulated offline)", async () => {
    await freshDb();
    const book = await addBook({ source: "gutenberg", title: "Offline Test", author: "X", kind: "text" });
    // Simulate having downloaded pages while online.
    await savePages(book.id, [
      { page_index: 0, text: "Primeira pagina offline." },
      { page_index: 1, text: "Segunda pagina offline." },
    ]);

    // "Offline": fetch is unavailable. Books/PDFs live in IndexedDB, so reading
    // must not touch the network at all.
    const originalFetch = globalThis.fetch;
    globalThis.fetch = () => { throw new Error("network unavailable"); };
    try {
      const pages = await getPages(book.id);
      expect(pages.length).toBe(2);
      expect(pages[0].text).toContain("offline");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("search needs the network (fails gracefully offline)", async () => {
    const { searchBooks } = await import("../search.js");
    const originalFetch = globalThis.fetch;
    globalThis.fetch = () => { throw new Error("network unavailable"); };
    try {
      const data = await searchBooks("test", "pt");
      // searchBooks reports errors per source instead of throwing.
      expect(Array.isArray(data.results)).toBe(true);
      expect(data.results.length).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
