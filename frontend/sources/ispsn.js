import { CONFIG, proxied } from "../config.js";

// Personal source "Biblioteca ISPSN" - ONLY for the owner's personal use.
// robots.txt (read live on 2026-11-12): "/" allowed; Disallow: /busca/,
// /*/solicitar-*/, /like/, /toggle-favorito/, /set-theme/, /pwa/, /painel/,
// /django-admin/, /entrar/, /minha-conta/, /notificacoes/, /offline/,
// /media/private/, /solia/. We only use /digital/ search and /digital/<slug>/ pages.

const BASE = "https://biblioteca.ispsn.org";
const cache = new Map(); // in-memory, 10 min TTL
let lastRequestAt = 0; // max 1 request per second

export function allowedUrl(url) {
  try {
    const u = new URL(url);
    if (u.origin !== BASE) return false;
    const path = u.pathname;
    if (path === "/digital/" || path.startsWith("/digital/")) return true;
    return false;
  } catch {
    return false;
  }
}

async function getHtml(url) {
  if (!allowedUrl(url)) throw new Error("URL fora da lista permitida pelo robots.txt");
  const now = Date.now();
  if (now - lastRequestAt < 1000) await new Promise((r) => setTimeout(r, 1000 - (now - lastRequestAt)));
  lastRequestAt = Date.now();

  const cached = cache.get(url);
  if (cached && Date.now() - cached.at < CONFIG.ISPSN_CACHE_TTL_MS) return cached.html;

  const res = await fetch(proxied(url)); // site sends no ACAO -> needs CORS_PROXY_URL
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const html = await res.text();
  cache.set(url, { html, at: Date.now() });
  return html;
}

// Parse the #livros-grid fragment returned by /digital/?search_query=...
export function parseSearchHtml(html) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const grid = doc.querySelector("#livros-grid");
  if (!grid) return []; // structure changed -> caller reports clearly
  const items = [];
  for (const card of grid.querySelectorAll("article, .book-card, .livro, li")) {
    const linkEl = card.querySelector("a[href^='/digital/']");
    if (!linkEl) continue;
    const title = (card.querySelector("h2, h3, .title, .titulo")?.textContent || "").trim();
    const author = (card.querySelector(".author, .autor, p.author")?.textContent || "").trim();
    const category = (card.querySelector(".category, .categoria, .tag")?.textContent || "").trim();
    if (!title) continue;
    items.push({
      key: title.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim(),
      title,
      author,
      category,
      url: BASE + linkEl.getAttribute("href"), // absolute, whitelisted path
      source: "ispsn",
      source_id: linkEl.getAttribute("href").replace(/^\/digital\//, "").replace(/\/$/, ""),
    });
  }
  return items;
}

export async function search(query) {
  const url = `${BASE}/digital/?search_query=${encodeURIComponent(query)}`;
  const html = await getHtml(url);
  return parseSearchHtml(html);
}

// Read a book page: language, category and the "Descarregar" link (if any).
export async function getBookPage(slug) {
  const url = `${BASE}/digital/${encodeURIComponent(slug)}/`;
  const html = await getHtml(url);
  const doc = new DOMParser().parseFromString(html, "text/html");
  const title = (doc.querySelector("h1")?.textContent || "").trim();
  const author = (doc.querySelector(".author, .autor")?.textContent || "").trim();
  const language = (doc.querySelector(".language, .idioma")?.textContent || "").trim();
  const category = (doc.querySelector(".category, .categoria")?.textContent || "").trim();
  const dl = [...doc.querySelectorAll("a")].find((a) => /descarregar/i.test(a.textContent));
  return { title, author, language, category, download_url: dl ? dl.getAttribute("href") : null };
}
