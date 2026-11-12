// Bookly PWA shell (100% client-side, IndexedDB - no backend calls).
// All visible text goes through t(key) with locales/<lang>.json.
// Language: "auto" (default) follows navigator.languages; user can pin a language in Settings.

import { openDb, listBooks, deleteBook, getPrefs, savePrefs as dbSavePrefs, getPages, getProgress, saveProgress, getJob } from "./db.js";
import { searchBooks } from "./search.js";
import { addFromSource, importTextFile } from "./downloader.js";
import { importPdf } from "./pdfImport.js";
import { listTracks } from "./db.js";
import * as ispsn from "./sources/ispsn.js";
import { openReader } from "./pages/reader.js";
import { openPlayer } from "./pages/player.js";
import { openTts } from "./pages/tts.js";
import { storageEstimate, countBooks, clearBookText, clearAllText, applyTheme } from "./settings.js";
import { exportBackup, validateBackup, importBackup } from "./backup.js";

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

// --- Prefs (IndexedDB, no network) ------------------------------------------

async function loadPrefs() {
  prefs = await getPrefs();
  return prefs;
}

async function savePrefs(payload) {
  prefs = await dbSavePrefs(payload);
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
  const books = await listBooks();
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
    const prog = b.progress;
    if (prog && prog.mode === "listen") {
      meta.textContent = `${t("chapter")} ${(prog.chapter_index || 0) + 1} • ${fmtTime(prog.position)}`;
    } else if (prog && prog.mode === "read") {
      meta.textContent = `${t("page")} ${(prog.position || 0) + 1} ${t("of")} ${b.total_pages || "?"}`;
    } else {
      meta.textContent = t("not_started");
    }
    info.appendChild(meta);

    const bar = document.createElement("div");
    bar.className = "progress-bar";
    const fill = document.createElement("div");
    fill.className = "progress-fill";
    fill.style.width = `${Math.min(100, Math.round(((b.progress && b.progress.percent) || 0) * 100))}%`;
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
    await deleteBook(book.id);
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
  // Phase 6b: pages/audio live in IndexedDB now.
  readBtn.hidden = book.kind === "audio";
  listenBtn.hidden = !(book.kind === "audio" || book.kind === "both");
  ttsBtn.textContent = t("voice_ai");
  readBtn.textContent = t("read");
  listenBtn.textContent = t("listen");

  // Reader (Phase 3) and player (Phase 4); TTS screen is Phase 5.
  readBtn.onclick = () => { overlay.hidden = true; openReader(book); };
  listenBtn.onclick = () => { overlay.hidden = true; openPlayer(book); };
  ttsBtn.onclick = () => { overlay.hidden = true; openTts(book); };

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
    // Client-side download: text fetched, paginated and stored in IndexedDB.
    const res = await addFromSource({
      source: src.source,
      source_id: src.source_id,
      title: item.title,
      author: item.author,
      language: item.language,
    });
    if (!res) {
      addBtn.disabled = false;
      addBtn.textContent = t("add");
      bar.hidden = true;
      return;
    }
    // Poll the job store until it finishes (or errors out).
    let job = null;
    for (let i = 0; i < 60; i++) {
      job = await getJob(res.book.id); // one job per book in IndexedDB
      if (!job) break;
      fill.style.width = `${Math.min(100, Math.round((job.percent || 0)))}%`;
      if (job.status === "done" || job.status === "error") break;
      await new Promise((r) => setTimeout(r, 500));
    }
    addBtn.textContent = job && job.status === "done" ? t("added") : t("add");
    if (job && job.status === "error") {
      addBtn.disabled = false;
      addBtn.textContent = t("retry");
    }
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
    // Recommendations reuse the client search with genre terms from prefs.
    const genres = (prefs && prefs.genres && prefs.genres.length) ? prefs.genres : ["classics"];
    const lang = uiLanguage.split("-")[0];
    recEl.innerHTML = "";
    const heading = document.createElement("h2");
    heading.textContent = t("recommended_for_you");
    recEl.appendChild(heading);
    for (const genre of genres) {
      let items = [];
      try {
        const data = await searchBooks(genre, lang);
        items = sortResults(data.results || [], prefs).slice(0, 12);
      } catch (err) {
        // Source failure is reported, not hidden.
        const p = document.createElement("p");
        p.className = "muted";
        p.textContent = `${genre}: ${err.message}`;
        recEl.appendChild(p);
        continue;
      }
      if (!items.length) continue;
      const h = document.createElement("h3");
      h.textContent = t("genre_" + genre);
      recEl.appendChild(h);
      const carousel = document.createElement("div");
      carousel.className = "carousel";
      for (const item of items) carousel.appendChild(bookCard(item));
      recEl.appendChild(carousel);
    }
    return;
  }

  recEl.hidden = true;
  const lang = uiLanguage.split("-")[0];
  const data = await searchBooks(q, lang);
  resultsEl.innerHTML = "";
  const results = sortResults(data.results || [], prefs);
  if (!results.length) {
    const p = document.createElement("p");
    p.className = "muted";
    p.textContent = t("no_results");
    resultsEl.appendChild(p);
  }
  for (const item of results) resultsEl.appendChild(bookCard(item));

  // Personal source "Biblioteca ISPSN": separate section, only when enabled
  // and a CORS proxy is configured (site sends no ACAO header).
  const ispsnEl = document.getElementById("ispsn-results");
  const ispsnOn = prefs && prefs.personal_sources && prefs.personal_sources.ispsn;
  if (ispsnOn && data.results.length) {
    try {
      const items = await ispsn.search(q);
      ispsnEl.hidden = false;
      ispsnEl.innerHTML = "";
      const h = document.createElement("h3");
      h.textContent = t("ispsn_section");
      ispsnEl.appendChild(h);
      for (const item of items) {
        const card = bookCard(item);
        // ISPSN: no direct download unless robots.txt allows it; open the page.
        const btn = card.querySelector(".add-btn");
        if (btn) {
          btn.textContent = t("open_in_browser");
          btn.onclick = () => window.open(item.url, "_blank");
        }
        ispsnEl.appendChild(card);
      }
    } catch (err) {
      ispsnEl.hidden = false;
      ispsnEl.innerHTML = `<p class="muted">${t("ispsn_unavailable")}</p>`;
    }
  } else {
    ispsnEl.hidden = true;
  }
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
    await savePrefs({ ui_language: langSelect.value });
    resolveLanguage(prefs);
    await loadLocale(uiLanguage); // apply language without reloading the page
    setView("settings");
  });
  editor.appendChild(langLabel);
  editor.appendChild(langSelect);

  // Theme (light / dark / auto).
  const themeLabel = document.createElement("label");
  themeLabel.textContent = t("theme");
  const themeSelect = document.createElement("select");
  for (const opt of [["light", "theme_light"], ["dark", "theme_dark"], ["auto", "theme_auto"]]) {
    const o = document.createElement("option");
    o.value = opt[0];
    o.textContent = t(opt[1]);
    themeSelect.appendChild(o);
  }
  themeSelect.value = prefs.theme || "auto";
  themeSelect.addEventListener("change", async () => {
    await savePrefs({ theme: themeSelect.value });
    applyTheme(themeSelect.value);
  });
  editor.appendChild(themeLabel);
  editor.appendChild(themeSelect);

  // Font size for the reader.
  const fontLabel = document.createElement("label");
  fontLabel.textContent = t("font_size");
  const fontSelect = document.createElement("select");
  for (const opt of [["small", "font_small"], ["normal", "font_normal"], ["large", "font_large"]]) {
    const o = document.createElement("option");
    o.value = opt[0];
    o.textContent = t(opt[1]);
    fontSelect.appendChild(o);
  }
  fontSelect.value = (prefs.reader && prefs.reader.font_size) || "normal";
  fontSelect.addEventListener("change", async () => {
    await savePrefs({ reader: { ...(prefs.reader || {}), font_size: fontSelect.value } });
  });
  editor.appendChild(fontLabel);
  editor.appendChild(fontSelect);

  // TTS voice + rate defaults.
  const ttsLabel = document.createElement("label");
  ttsLabel.textContent = t("tts_voice");
  const ttsVoiceSelect = document.createElement("select");
  const voices = window.speechSynthesis ? window.speechSynthesis.getVoices() : [];
  const defaultOpt = document.createElement("option");
  defaultOpt.value = "";
  defaultOpt.textContent = t("tts_default_voice");
  ttsVoiceSelect.appendChild(defaultOpt);
  for (const v of voices) {
    const o = document.createElement("option");
    o.value = v.name;
    o.textContent = `${v.name} (${v.lang})`;
    ttsVoiceSelect.appendChild(o);
  }
  ttsVoiceSelect.value = (prefs.tts && prefs.tts.voice_name) || "";
  ttsVoiceSelect.addEventListener("change", async () => {
    await savePrefs({ tts: { ...(prefs.tts || {}), voice_name: ttsVoiceSelect.value || null, lang: "pt-PT" } });
  });
  const rateInput = document.createElement("input");
  rateInput.type = "range";
  rateInput.min = "0.5";
  rateInput.max = "2";
  rateInput.step = "0.1";
  rateInput.value = String((prefs.tts && prefs.tts.rate) || 1);
  rateInput.addEventListener("change", async () => {
    await savePrefs({ tts: { ...(prefs.tts || {}), rate: Number(rateInput.value) } });
  });
  editor.appendChild(ttsLabel);
  editor.appendChild(ttsVoiceSelect);
  editor.appendChild(rateInput);

  const redoBtn = document.createElement("button");
  redoBtn.className = "btn ghost";
  redoBtn.textContent = t("onboarding_title");
  redoBtn.addEventListener("click", openOnboarding);
  editor.appendChild(redoBtn);

  // Personal sources toggle (ISPSN, off by default) with the personal-use warning.
  const personalLabel = document.createElement("label");
  personalLabel.textContent = t("personal_sources");
  const personalToggle = document.createElement("button");
  personalToggle.className = "btn ghost";
  personalToggle.textContent = prefs.personal_sources && prefs.personal_sources.ispsn ? t("on") : t("off");
  personalToggle.addEventListener("click", async () => {
    const next = !(prefs.personal_sources && prefs.personal_sources.ispsn);
    await savePrefs({ personal_sources: { ispsn: next } });
    renderSettings();
  });
  editor.appendChild(personalLabel);
  editor.appendChild(personalToggle);
  if (prefs.personal_sources && prefs.personal_sources.ispsn) {
    const warn = document.createElement("p");
    warn.className = "muted";
    warn.textContent = t("personal_sources_warning");
    editor.appendChild(warn);
  }

  // Import PDF/TXT from the device.
  const importBtn = document.getElementById("pdf-import-btn");
  const fileInput = document.getElementById("pdf-import");
  importBtn.textContent = t("import_pdf");
  importBtn.onclick = async () => {
    const file = fileInput.files && fileInput.files[0];
    if (!file) return;
    importBtn.disabled = true;
    importBtn.textContent = t("importing");
    try {
      let result;
      if (file.type === "application/pdf" || /\.pdf$/i.test(file.name)) {
        result = await importPdf(file);
      } else if (/\.txt$/i.test(file.name)) {
        result = await importTextFile(file.name, await file.text());
      } else {
        throw new Error(t("import_unsupported"));
      }
      importBtn.textContent = t("imported");
      if (result && !result.deduplicated) setView("library");
    } catch (err) {
      importBtn.textContent = err.message || t("import_failed");
    } finally {
      importBtn.disabled = false;
    }
  };

  // Storage accounting.
  const storageTitle = document.createElement("h3");
  storageTitle.textContent = t("storage_title");
  editor.appendChild(storageTitle);
  const est = await storageEstimate();
  const counts = await countBooks();
  const used = est.usage != null ? `${(est.usage / 1048576).toFixed(1)} MB` : "?";
  const quota = est.quota != null ? `${(est.quota / 1048576).toFixed(1)} MB` : "?";
  const storageInfo = document.createElement("p");
  storageInfo.className = "muted";
  storageInfo.textContent = `${t("storage_used")}: ${used} · ${t("storage_quota")}: ${quota} · ${t("books_count")}: ${counts.total} · ${t("pdfs_count")}: ${counts.pdfs}`;
  editor.appendChild(storageInfo);
  const iosNote = document.createElement("p");
  iosNote.className = "muted";
  iosNote.textContent = t("ios_storage_note");
  editor.appendChild(iosNote);

  // Clear cached text (per book or all) without touching progress.
  const booksForClear = await listBooks();
  for (const b of booksForClear) {
    const btn = document.createElement("button");
    btn.className = "btn ghost";
    btn.textContent = `${t("clear_text_book")}: ${b.title}`;
    btn.addEventListener("click", async () => {
      if (!confirm(t("clear_text_confirm"))) return;
      await clearBookText(b.id);
      renderSettings();
    });
    editor.appendChild(btn);
  }
  const clearAllBtn = document.createElement("button");
  clearAllBtn.className = "btn ghost";
  clearAllBtn.textContent = t("clear_text_all");
  clearAllBtn.addEventListener("click", async () => {
    if (!confirm(t("clear_text_confirm"))) return;
    await clearAllText();
    renderSettings();
  });
  editor.appendChild(clearAllBtn);

  // Backup export.
  const backupBtn = document.createElement("button");
  backupBtn.className = "btn ghost";
  backupBtn.textContent = t("backup_export");
  backupBtn.addEventListener("click", async () => {
    const dump = await exportBackup();
    const blob = new Blob([JSON.stringify(dump, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "bookly-backup.json";
    a.click();
  });
  editor.appendChild(backupBtn);

  // Backup import with preview + confirmation.
  const restoreInput = document.createElement("input");
  restoreInput.type = "file";
  restoreInput.accept = "application/json,.json";
  const restoreBtn = document.createElement("button");
  restoreBtn.className = "btn ghost";
  restoreBtn.textContent = t("backup_import");
  let pendingData = null;
  restoreBtn.addEventListener("click", async () => {
    const file = restoreInput.files && restoreInput.files[0];
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      const validation = validateBackup(data);
      if (!validation.ok) {
        restoreBtn.textContent = t("backup_invalid");
        return;
      }
      pendingData = data;
      const msg = t("backup_preview")
        .replace("{books}", validation.preview.books)
        .replace("{progress}", validation.preview.progress)
        .replace("{pages}", validation.preview.pages);
      let text = msg;
      if (validation.preview.personal_books > 0) {
        text += " " + t("backup_personal_warning").replace("{personal}", validation.preview.personal_books);
      }
      if (!confirm(text)) return;
      await importBackup(pendingData);
      restoreBtn.textContent = t("cleared"); // reused as generic success label
      renderLibrary();
    } catch (err) {
      restoreBtn.textContent = err.message || t("backup_invalid");
    }
  });
  editor.appendChild(restoreInput);
  editor.appendChild(restoreBtn);
}

// --- Init -----------------------------------------------------------------

async function init() {
  await openDb();
  await loadPrefs();
  resolveLanguage(prefs);
  applyTheme(prefs.theme || "auto");
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

// --- Offline banner + service worker -----------------------------------------

function showOfflineBanner() {
  let banner = document.getElementById("offline-banner");
  if (!banner) {
    banner = document.createElement("div");
    banner.id = "offline-banner";
    banner.className = "offline-banner";
    banner.hidden = true;
    document.body.appendChild(banner);
  }
  if (navigator.onLine) {
    banner.hidden = true;
  } else {
    banner.textContent = t("offline_message");
    banner.hidden = false;
  }
}

window.addEventListener("online", showOfflineBanner);
window.addEventListener("offline", showOfflineBanner);

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js").then((registration) => {
    // Ask before activating a new version (Prompt 9 requirement).
    registration.onupdatefound = () => {
      const installing = registration.installing;
      if (!installing) return;
      installing.onstatechange = () => {
        if (installing.state === "installed" && navigator.serviceWorker.controller) {
          if (confirm(t("update_available"))) {
            // Reload so the new shell is served from the fresh cache.
            window.location.reload();
          }
        }
      };
    };
  }).catch(() => {
    // SW unavailable (e.g. unsupported browser): app still works, just no offline shell.
  });
  showOfflineBanner();
}
