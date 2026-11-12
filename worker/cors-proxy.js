// Cloudflare Worker: tiny GET-only CORS proxy for Bookly.
// Whitelist of domains/paths (only the sources the app actually uses).
// Deploy with Cloudflare Workers dashboard or wrangler; then set
// CONFIG.CORS_PROXY_URL = "https://<worker>.workers.dev".
// Usage: <worker>?url=<encoded target URL>

const ALLOWED = [
  { host: "gutendex.com", paths: "/" },
  { host: "www.gutenberg.org", paths: ["/cache/", "/opds/"] },
  { host: "gutenberg.org", paths: ["/cache/", "/opds/"] },
  { host: "archive.org", paths: ["/advancedsearch.php", "/metadata/", "/download/", "/details/"] },
  { host: "ia600509.us.archive.org", paths: "/" }, // generic mirror fallbacks
  { host: "librivox.org", paths: ["/api/feed/", "/rss/"] },
  { host: "covers.openlibrary.org", paths: "/" },
  { host: "www.googleapis.com", paths: "/books/v1/volumes" },
  { host: "biblioteca.ispsn.org", paths: "/digital/" }, // personal source, GET only
];

function isAllowed(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== "https:") return false;
  for (const rule of ALLOWED) {
    if (u.hostname === rule.host || u.hostname.endsWith("." + rule.host)) {
      if (rule.paths.some((p) => u.pathname.startsWith(p))) return true;
    }
  }
  return false;
}

export async function handleRequest(request) {
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET",
    "Content-Type": "application/json",
  };

  if (request.method !== "GET") {
    return new Response(JSON.stringify({ error: "only GET allowed" }), { status: 405, headers: corsHeaders });
  }

  const target = new URL(request.url).searchParams.get("url");
  if (!target || !isAllowed(target)) {
    return new Response(JSON.stringify({ error: "URL not in whitelist" }), { status: 403, headers: corsHeaders });
  }

  try {
    const res = await fetch(target, { method: "GET", headers: { "User-Agent": "BooklyPWA/1.0" } });
    const body = await res.text();
    return new Response(body, { status: res.status, headers: { ...corsHeaders, "Content-Type": res.headers.get("content-type") || "application/json" } });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err.message || err) }), { status: 502, headers: corsHeaders });
  }
}

// Cloudflare Workers entry point.
if (typeof globalThis.addEventListener === "function") {
  globalThis.addEventListener("fetch", (event) => event.respondWith(handleRequest(event.request)));
}
