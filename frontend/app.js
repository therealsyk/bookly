// Bookly PWA shell. Localization via t(key) with locales/<lang>.json.
const LANG = localStorage.getItem("bookly_lang") || "pt-PT";
let locale = {};

async function loadLocale() {
  try {
    const res = await fetch(`/locales/${LANG}.json`);
    locale = await res.json();
  } catch (err) {
    locale = {};
  }
}

function t(key) {
  return locale[key] || key;
}

async function loadBooks() {
  const res = await fetch("/api/books");
  if (!res.ok) return [];
  return res.json();
}

async function render() {
  const list = document.getElementById("book-list");
  const empty = document.getElementById("library-empty");
  const books = await loadBooks();
  empty.hidden = books.length > 0;
  empty.textContent = t("empty_library");
  list.innerHTML = "";
  for (const b of books) {
    const li = document.createElement("li");
    li.className = "book-card";
    li.textContent = b.title;
    list.appendChild(li);
  }
}

async function init() {
  await loadLocale();
  document.getElementById("app-title").textContent = t("app_name");
  await render();
}

init();

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js");
}
