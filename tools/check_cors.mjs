// tools/check_cors.mjs - real CORS check for every source used by the client.
// Run: node tools/check_cors.mjs
// Prints a table: source -> OK/FAIL, with the actual Access-Control-Allow-Origin.

const TESTS = [
  { name: "librivox search", url: "https://librivox.org/api/feed/audiobooks?format=json&search=dracula&limit=2" },
  { name: "gutendex search", url: "https://gutendex.com/books?search=dracula&languages=en&limit=2" },
  { name: "gutenberg OPDS search", url: "https://www.gutenberg.org/opds/search?query=dracula" },
  { name: "gutenberg text download", url: "https://www.gutenberg.org/cache/epub/1342/pg1342-images.html" },
  { name: "archive search", url: "https://archive.org/advancedsearch.php?q=title%3A(dracula)+AND+mediatype%3A(texts)&rows=2&output=json" },
  { name: "archive metadata", url: "https://archive.org/metadata/brillianceofdracula00stou" },
  { name: "openlibrary cover", url: "https://covers.openlibrary.org/b/title/Dracula-M.jpg?default=false" },
  { name: "googlebooks search", url: "https://www.googleapis.com/books/v1/volumes?q=dracula&filter=free-ebooks&maxResults=2" },
  { name: "ispsn search (personal)", url: "https://biblioteca.ispsn.org/digital/?search_query=dracula" },
];

async function check(test) {
  try {
    const res = await fetch(test.url, { method: "GET" });
    const acao = res.headers.get("access-control-allow-origin");
    const ok = res.ok && (acao === "*" || acao != null);
    console.log(`${test.name.padEnd(24)} | ${res.status} | ACAO=${acao || "(none)"} | ${ok ? "OK" : "FAIL (needs CORS_PROXY_URL)"}`);
  } catch (err) {
    console.log(`${test.name.padEnd(24)} | ERROR | ${err.message} | FAIL`);
  }
}

(async () => {
  for (const t of TESTS) await check(t);
})();
