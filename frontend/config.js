// Client configuration. No secrets, no localhost, no absolute paths.
// CORS_PROXY_URL is empty by default; if the user sets it (e.g. a Cloudflare
// Worker they deployed), sources that fail CORS checks are routed through it.
export const CONFIG = {
  CORS_PROXY_URL: "", // e.g. "https://bookly-proxy.yourname.workers.dev"
  PAGE_SIZE: 1800, // same target page size as the Python backend
  SOURCE_TIMEOUT_MS: 12000,
  SEARCH_CACHE_TTL_MS: 24 * 3600 * 1000, // 24 h, matching search_cache
  ISPSN_CACHE_TTL_MS: 10 * 60 * 1000, // 10 min in-memory cache
};

export function proxied(url) {
  if (!CONFIG.CORS_PROXY_URL) return url;
  return `${CONFIG.CORS_PROXY_URL}?url=${encodeURIComponent(url)}`;
}
