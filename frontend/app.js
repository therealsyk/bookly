// Bookly PWA shell. All visible text goes through t(key) with locales/<lang>.json.
// Language: "auto" (default) follows navigator.languages; user can pin a language in Settings.

const AVAILABLE_LANGS = ["pt-PT", "en"]; // must match frontend/locales/*.json
let locale = {};
let uiLanguage = "auto";
let prefs = null;

function detectBrowserLanguage() {
  const langs = navigator.languages || [navigator.language || "en"];
  for (const raw of langs) {
    const lower = raw.toLowerCase();
    // Exact match first, then prefix match (e.g. "pt" -> "pt-PT").
    for (const avail of AVAILABLE_LANGS) {
      if (avail.toLowerCase() === lower) return avail;
    }
    for (const avail of AVAILABLE_LANGS) {
      if (lower.startsWith(avail.split("-")[0])) return avail;
    }
  }
  return "en";
}

function resolveLanguage(prefsValue) {
  const setting = prefsValue && prefsValue.ui_language ? prefsValue.ui_language : "auto";
  uiLanguage = setting === "auto" ? detectBrowserLanguage() : setting;
  document.documentElement.lang = uiLanguage;
  return uiLanguage;
}

async function loadLocale(lang) {
  try {
    const res = await fetch(`/locales/${lang}.json`);
    locale = await res.json();
  } catch (err) {
    locale = {};
  }
}

function t(key) {
  return locale[key] || key;
}

// --- API helpers --------------------------------------------------------------

async function api(path, options) {
  const res = await fetch(path, options);
  if (!res.ok) return null;
  return res.json();
}

async function loadPrefs() {
  const data = await api("/api/prefs");
  prefs = data || { ui_language: "auto", genres: [], book_languages: [], format: "both", authors: [], onboarded: false };
  return prefs;
}

async function savePrefs(payload) {
  const res = await fetch("/api/prefs", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (res.ok) prefs = await res.json();
  return prefs;
}

// --- Navigation ---------------------------------------------------------------

function setView(view) {
  for (const section of document.querySelectorAll("#app > section")) {
    section.hidden = section.id !== view;
  }
  for (const btn of document.querySelectorAll(".nav-btn")) {
    btn.classList.toggle("active", btn.dataset.view === view);
  }
  if (view === "library") renderLibrary();
  if (view === "search") renderSearch();
  if (view === "settings") renderSettings();
}

// --- Library ----------------------------------------------------------------

async function renderLibrary() {
  const list = document.getElementById("book-list");
  const empty = document.getElementById("library-empty");
  const books = await api("/api/library") || [];
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

// --- Search + recommendations ----------------------------------------------

function bookCard(item) {
  const div = document.createElement("div");
  div.className = "result-card";
  // Fallback to Open Library covers when the source has no cover.
  let cover = item.cover_url || "";
  if (!cover && item.sources && item.sources.length) {
    const src = item.sources[0];
    if (src.source === "gutenberg" && src.source_id) {
      cover = `https://covers.openlibrary.org/b/id/${src.source_id}-L.jpg`;
    }
  }
  if (cover) {
    const img = document.createElement("img");
    img.src = cover;
    img.alt = "";
    img.loading = "lazy";
    div.appendChild(img);
  }
  const info = document.createElement("div");
  info.className = "result-info";
  const title = document.createElement("strong");
  title.textContent = item.title;
  info.appendChild(title);
  if (item.author) {
    const author = document.createElement("span");
    author.className = "muted";
    author.textContent = item.author;
    info.appendChild(author);
  }
  const flags = document.createElement("div");
  flags.className = "flags";
  if (item.has_audio) flags.appendChild(span(t("has_audio")));
  if (item.has_text) flags.appendChild(span(t("has_text")));
  info.appendChild(flags);
  div.appendChild(info);
  return div;
}

function span(text) {
  const s = document.createElement("span");
  s.className = "flag";
  s.textContent = text;
  return s;
}

function sortResults(results, prefs) {
  const langs = (prefs && prefs.book_languages) || [];
  const format = (prefs && prefs.format) || "both";
  return results.slice().sort((a, b) => {
    const langScore = (x) => (langs.length && langs.includes((x.language || "").toLowerCase()) ? 1 : 0);
    const fmtScore = (x) => {
      if (format === "both") return 2;
      if (format === "audio") return x.has_audio ? 2 : (x.has_text ? 1 : 0);
      return x.has_text ? 2 : (x.has_audio ? 1 : 0);
    };
    return langScore(b) - langScore(a) || fmtScore(b) - fmtScore(a);
  });
}

async function renderSearch() {
  const input = document.getElementById("search-input");
  input.placeholder = t("search_placeholder");
  const resultsEl = document.getElementById("search-results");
  const recEl = document.getElementById("recommendations");
  const q = input.value.trim();

  if (!q) {
    resultsEl.innerHTML = "";
    recEl.hidden = false;
    const data = await api("/api/recommendations");
    recEl.innerHTML = "";
    const heading = document.createElement("h2");
    heading.textContent = t("recommended_for_you");
    recEl.appendChild(heading);
    if (!data || !(data.groups || {}).genres) {
      // no groups: flat carousel
      const carousel = document.createElement("div");
      carousel.className = "carousel";
      for (const item of (data && data.results) || []) carousel.appendChild(bookCard(item));
      recEl.appendChild(carousel);
      if (!(data && data.results && data.results.length)) {
        const p = document.createElement("p");
        p.className = "muted";
        p.textContent = t("no_results");
        recEl.appendChild(p);
      }
    } else {
      for (const [genre, items] of Object.entries(data.groups)) {
        if (!items.length) continue;
        const h = document.createElement("h3");
        h.textContent = t("genre_" + genre);
        recEl.appendChild(h);
        const carousel = document.createElement("div");
        carousel.className = "carousel";
        for (const item of sortResults(items, prefs)) carousel.appendChild(bookCard(item));
        recEl.appendChild(carousel);
      }
    }
    return;
  }

  recEl.hidden = true;
  const lang = uiLanguage.split("-")[0];
  const data = await api(`/api/search?q=${encodeURIComponent(q)}&lang=${encodeURIComponent(lang)}`);
  resultsEl.innerHTML = "";
  const results = sortResults((data && data.results) || [], prefs);
  if (!results.length) {
    const p = document.createElement("p");
    p.className = "muted";
    p.textContent = t("no_results");
    resultsEl.appendChild(p);
    return;
  }
  for (const item of results) resultsEl.appendChild(bookCard(item));
}

// --- Onboarding ------------------------------------------------------------

const GENRES = ["fiction", "romance", "detective", "scifi", "fantasy", "adventure",
  "poetry", "drama", "classics", "history", "philosophy", "children", "other"];
const FORMATS = ["audio", "text", "both"];
const STEPS = ["genres", "languages", "format", "authors"];

function onboardingNeeded() {
  return prefs && !prefs.onboarded;
}

function renderOnboardingStep(stepIndex) {
  const step = STEPS[stepIndex];
  const container = document.getElementById("ob-step");
  container.innerHTML = "";

  if (step === "genres" || step === "languages") {
    const selected = step === "genres" ? prefs.genres : prefs.book_languages;
    const options = step === "genres" ? GENRES : ["pt", "en", "es", "fr", "de"];
    for (const opt of options) {
      const btn = document.createElement("button");
      btn.className = "chip" + (selected.includes(opt) ? " selected" : "");
      btn.textContent = step === "genres" ? t("genre_" + opt) : opt.toUpperCase();
      btn.addEventListener("click", () => {
        if (selected.includes(opt)) selected.splice(selected.indexOf(opt), 1);
        else selected.push(opt);
        btn.classList.toggle("selected");
      });
      container.appendChild(btn);
    }
  } else if (step === "format") {
    for (const fmt of FORMATS) {
      const btn = document.createElement("button");
      btn.className = "chip" + (prefs.format === fmt ? " selected" : "");
      btn.textContent = t("format_" + fmt);
      btn.addEventListener("click", () => {
        prefs.format = fmt;
        container.querySelectorAll(".chip").forEach((c) => c.classList.remove("selected"));
        btn.classList.add("selected");
      });
      container.appendChild(btn);
    }
  } else if (step === "authors") {
    const input = document.createElement("input");
    input.type = "text";
    input.placeholder = t("step_authors_hint");
    const tags = document.createElement("div");
    tags.className = "tags";
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && input.value.trim()) {
        prefs.authors.push(input.value.trim());
        input.value = "";
        const tag = span(prefs.authors[prefs.authors.length - 1]);
        tags.appendChild(tag);
      }
    });
    container.appendChild(input);
    for (const author of prefs.authors) tags.appendChild(span(author));
    container.appendChild(tags);
  }

  document.getElementById("ob-title").textContent = t("onboarding_title");
  document.getElementById("ob-intro").textContent = t("onboarding_intro");
  const stepTitle = document.createElement("h3");
  stepTitle.textContent = t("step_" + step);
  container.prepend(stepTitle);

  document.getElementById("ob-next").textContent = stepIndex === STEPS.length - 1 ? t("finish") : t("next");
  document.getElementById("ob-skip").textContent = t("skip");
}

function openOnboarding() {
  const overlay = document.getElementById("onboarding");
  overlay.hidden = false;
  let index = 0;
  renderOnboardingStep(index);
  document.getElementById("ob-next").onclick = async () => {
    if (index < STEPS.length - 1) {
      index += 1;
      renderOnboardingStep(index);
    } else {
      prefs.onboarded = true;
      await savePrefs(prefs);
      overlay.hidden = true;
    }
  };
  document.getElementById("ob-skip").onclick = async () => {
    if (index < STEPS.length - 1) {
      index += 1;
      renderOnboardingStep(index);
    } else {
      prefs.onboarded = true;
      await savePrefs(prefs);
      overlay.hidden = true;
    }
  };
}

// --- Settings ---------------------------------------------------------------

async function renderSettings() {
  document.getElementById("settings-title").textContent = t("settings");
  const editor = document.getElementById("prefs-editor");
  editor.innerHTML = "";

  // Language selector: auto or pinned.
  const langLabel = document.createElement("label");
  langLabel.textContent = t("language");
  const langSelect = document.createElement("select");
  const autoOpt = document.createElement("option");
  autoOpt.value = "auto";
  autoOpt.textContent = t("language_auto");
  langSelect.appendChild(autoOpt);
  for (const lang of AVAILABLE_LANGS) {
    const opt = document.createElement("option");
    opt.value = lang;
    opt.textContent = lang;
    langSelect.appendChild(opt);
  }
  langSelect.value = prefs.ui_language || "auto";
  langSelect.addEventListener("change", async () => {
    prefs.ui_language = langSelect.value;
    await savePrefs(prefs);
    resolveLanguage(prefs);
    await loadLocale(uiLanguage); // apply language without reloading the page
    setView("settings");
  });
  editor.appendChild(langLabel);
  editor.appendChild(langSelect);

  const redoBtn = document.createElement("button");
  redoBtn.className = "btn ghost";
  redoBtn.textContent = t("onboarding_title");
  redoBtn.addEventListener("click", openOnboarding);
  editor.appendChild(redoBtn);
}

// --- Init -----------------------------------------------------------------

async function init() {
  await loadPrefs();
  resolveLanguage(prefs);
  await loadLocale(uiLanguage);
  document.getElementById("app-title").textContent = t("app_name");
  document.querySelectorAll(".nav-btn").forEach((btn) => {
    btn.textContent = t(btn.dataset.view === "library" ? "library" : btn.dataset.view === "search" ? "search" : "settings");
    btn.addEventListener("click", () => setView(btn.dataset.view));
  });
  document.getElementById("search-input").addEventListener("input", renderSearch);
  if (onboardingNeeded()) openOnboarding();
  await renderLibrary();
}

init();

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js");
}
