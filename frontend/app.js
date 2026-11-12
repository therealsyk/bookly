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

function fmtTime(sec) {
  const s = Math.max(0, Math.floor(sec || 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

async function renderLibrary() {
  const list = document.getElementById("book-list");
  const empty = document.getElementById("library-empty");
  const data = await api("/api/library");
  const books = (data && data.books) || [];
  empty.hidden = books.length > 0;
  empty.textContent = t("empty_library");
  list.innerHTML = "";
  for (const b of books) {
    const li = document.createElement("li");
    li.className = "book-row";

    if (b.cover_url) {
      const img = document.createElement("img");
      img.className = "row-cover";
      img.src = b.cover_url;
      img.alt = "";
      img.loading = "lazy";
      li.appendChild(img);
    } else {
      const ph = document.createElement("div");
      ph.className = "row-cover placeholder";
      li.appendChild(ph);
    }

    const info = document.createElement("div");
    info.className = "row-info";
    const title = document.createElement("strong");
    title.textContent = b.title;
    info.appendChild(title);
    if (b.author) {
      const author = document.createElement("span");
      author.className = "muted";
      author.textContent = b.author;
      info.appendChild(author);
    }

    // Position line: text -> "Page X of Y", audio -> "Chapter X • mm:ss".
    const meta = document.createElement("span");
    meta.className = "row-meta muted";
    if (b.mode === "listen") {
      meta.textContent = `${t("chapter")} ${b.chapter_index || 1} • ${fmtTime(b.position)}`;
    } else if (b.pages) {
      meta.textContent = `${t("page")} ${(b.current_page || 0) + 1} ${t("of")} ${b.pages}`;
    } else if (b.kind === "audio") {
      meta.textContent = t("not_started");
    }
    info.appendChild(meta);

    const bar = document.createElement("div");
    bar.className = "progress-bar";
    const fill = document.createElement("div");
    fill.className = "progress-fill";
    fill.style.width = `${Math.min(100, Math.round((b.progress_percent || 0) * 100))}%`;
    bar.appendChild(fill);
    info.appendChild(bar);

    li.appendChild(info);

    // Long press (>=600 ms) opens the delete confirmation.
    let pressTimer = null;
    li.addEventListener("pointerdown", () => {
      pressTimer = setTimeout(() => confirmDelete(b), 600);
    });
    const clearPress = () => {
      if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; }
    };
    li.addEventListener("pointerup", clearPress);
    li.addEventListener("pointercancel", clearPress);

    // Tap opens the detail screen.
    li.addEventListener("click", () => openDetail(b));

    list.appendChild(li);
  }
}

function confirmDelete(book) {
  const overlay = document.getElementById("confirm-delete");
  document.getElementById("confirm-text").textContent = `${t("delete_confirm")} "${book.title}"?`;
  document.getElementById("confirm-cancel").textContent = t("cancel");
  document.getElementById("confirm-yes").textContent = t("delete");
  overlay.hidden = false;
  document.getElementById("confirm-cancel").onclick = () => { overlay.hidden = true; };
  document.getElementById("confirm-yes").onclick = async () => {
    await api(`/api/library/${book.id}`, { method: "DELETE" });
    overlay.hidden = true;
    renderLibrary();
  };
}

// --- Book detail ------------------------------------------------------------

async function openDetail(book) {
  const overlay = document.getElementById("book-detail");
  const cover = document.getElementById("detail-cover");
  if (book.cover_url) {
    cover.src = book.cover_url;
    cover.hidden = false;
  } else {
    cover.hidden = true;
  }
  document.getElementById("detail-title").textContent = book.title;
  document.getElementById("detail-author").textContent = book.author || "";

  const readBtn = document.getElementById("action-read");
  const listenBtn = document.getElementById("action-listen");
  const ttsBtn = document.getElementById("action-tts");
  readBtn.hidden = !book.pages;
  listenBtn.hidden = book.kind !== "audio" && book.kind !== "both";
  ttsBtn.textContent = t("voice_ai");
  readBtn.textContent = t("read");
  listenBtn.textContent = t("listen");

  // Reader (Phase 3) and player (Phase 4); TTS screen is Phase 5.
  readBtn.onclick = () => { overlay.hidden = true; openReader(book); };
  listenBtn.onclick = () => { overlay.hidden = true; openPlayer(book); };
  ttsBtn.onclick = () => { overlay.hidden = true; };

  overlay.hidden = false;
  overlay.querySelector(".detail-card").onclick = (e) => {
    if (e.target === overlay.querySelector(".detail-card")) overlay.hidden = true;
  };
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
  if (item.has_audio) flags.appendChild(spanFlag("🎧"));
  if (item.has_text) flags.appendChild(spanFlag("📖"));
  info.appendChild(flags);

  // Add button with a progress bar fed by the download job.
  const addBtn = document.createElement("button");
  addBtn.className = "btn primary add-btn";
  addBtn.textContent = t("add");
  const bar = document.createElement("div");
  bar.className = "progress-bar add-progress";
  bar.hidden = true;
  const fill = document.createElement("div");
  fill.className = "progress-fill";
  bar.appendChild(fill);

  addBtn.addEventListener("click", async () => {
    const src = (item.sources || [])[0];
    if (!src) return;
    addBtn.disabled = true;
    addBtn.textContent = t("adding");
    bar.hidden = false;
    const res = await api("/api/library/add", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        source: src.source,
        source_id: src.source_id,
        title: item.title,
        author: item.author,
        language: item.language,
      }),
    });
    if (!res) {
      addBtn.disabled = false;
      addBtn.textContent = t("add");
      bar.hidden = true;
      return;
    }
    const jobId = res.job_id;
    // Poll the job until it finishes (or errors out).
    for (let i = 0; i < 120; i++) {
      const job = await api(`/api/library/jobs/${jobId}`);
      if (!job) break;
      fill.style.width = `${Math.min(100, Math.round((job.progress || 0) * 100))}%`;
      if (job.status === "done" || job.status === "error") break;
      await new Promise((r) => setTimeout(r, 1000));
    }
    addBtn.textContent = job && job.status === "done" ? t("added") : t("add");
    if (job && job.status === "error") addBtn.disabled = false;
  });

  info.appendChild(addBtn);
  info.appendChild(bar);
  div.appendChild(info);
  return div;
}

function spanFlag(text) {
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

// Debounced search: run 400 ms after the user stops typing.
function debounce(fn, ms) {
  let timer = null;
  return (...args) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
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
        const tag = spanFlag(prefs.authors[prefs.authors.length - 1]);
        tags.appendChild(tag);
      }
    });
    container.appendChild(input);
    for (const author of prefs.authors) tags.appendChild(spanFlag(author));
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
  document.getElementById("search-input").addEventListener("input", debounce(renderSearch, 400));
  if (onboardingNeeded()) openOnboarding();
  await renderLibrary();
}

init();

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js");
}
