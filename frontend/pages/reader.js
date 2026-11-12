// Bookly paginated text reader (Phase 3, now fully client-side via IndexedDB).
// Imported by app.js as a module; all visible text goes through t() which
// lives in the main shell. Settings persist in localStorage and in prefs.

import { getPages, saveProgress } from "../db.js";
import { savePrefs } from "../db.js";

const FONT_SIZES = ["small", "normal", "large"];
const FONT_FAMILIES = ["serif", "sans"];
const THEMES = ["light", "dark", "sepia"];

function clampInt(value, min, max) {
  const n = Math.round(Number(value));
  if (Number.isNaN(n)) return min;
  return Math.min(max, Math.max(min, n));
}

function getReaderSettings() {
  let stored = null;
  try {
    stored = JSON.parse(localStorage.getItem("bookly_reader") || "null");
  } catch (err) {
    stored = null;
  }
  return {
    font_size: FONT_SIZES.includes(stored && stored.font_size) ? stored.font_size : "normal",
    font_family: FONT_FAMILIES.includes(stored && stored.font_family) ? stored.font_family : "serif",
    theme: THEMES.includes(stored && stored.theme) ? stored.theme : "light",
  };
}

function saveReaderSettings(settings) {
  localStorage.setItem("bookly_reader", JSON.stringify(settings));
  // Persist in IndexedDB prefs too (best effort; the app works offline via sw.js).
  savePrefs({ reader: settings }).catch(() => {});
}

// Global gestures are bound ONCE (see bindReaderGestures) and always act on the
// reader that is currently open, so reopening a book never stacks listeners.
let activeReader = null;
let gesturesBound = false;

function bindReaderGestures(overlay) {
  if (gesturesBound) return;
  gesturesBound = true;
  let touchStartX = null;
  overlay.addEventListener("touchstart", (e) => { touchStartX = e.touches[0].clientX; }, { passive: true });
  overlay.addEventListener("touchend", (e) => {
    if (touchStartX === null || !activeReader) return;
    const dx = e.changedTouches[0].clientX - touchStartX;
    touchStartX = null;
    if (Math.abs(dx) > 40) activeReader.go(dx < 0 ? 1 : -1); // swipe left -> next, right -> previous
  });
}

function openReader(book) {
  const overlay = document.getElementById("reader");
  const pageEl = document.getElementById("reader-page-text");
  const counterEl = document.getElementById("reader-counter");
  const jumpInput = document.getElementById("reader-jump");
  const settings = getReaderSettings();

  let pages = [];
  let current = 0; // zero-based index of the visible page

  function applySettings() {
    overlay.dataset.theme = settings.theme;
    overlay.dataset.font = settings.font_family;
    pageEl.className = `reader-text font-${settings.font_size} family-${settings.font_family}`;
  }

  function renderPage() {
    pageEl.textContent = pages[current] || "";
    counterEl.textContent = `${t("page")} ${current + 1} ${t("of")} ${pages.length}`;
    jumpInput.value = String(current + 1);
    queueProgress();
  }

  // Debounced progress save (1 s) on every page change - same behaviour as the
  // backend port, now writing straight to IndexedDB.
  let progressTimer = null;
  function queueProgress() {
    if (progressTimer) clearTimeout(progressTimer);
    progressTimer = setTimeout(() => {
      saveProgress(book.id, "read", {
        position: current,
        chapter_index: 0,
        percent: pages.length ? (current + 1) / pages.length : 0,
      }).catch(() => {});
    }, 1000);
  }

  function flushProgress() {
    // Save immediately when the reader closes.
    if (progressTimer) clearTimeout(progressTimer);
    progressTimer = null;
    saveProgress(book.id, "read", {
      position: current,
      chapter_index: 0,
      percent: pages.length ? (current + 1) / pages.length : 0,
    }).catch(() => {});
  }

  function go(delta) {
    const next = clampInt(current + delta, 0, pages.length - 1);
    if (next !== current) {
      current = next;
      renderPage();
    }
  }

  async function load() {
    applySettings();
    pages = await getPages(book.id);
    if (!pages || !pages.length) {
      document.getElementById("reader-title").textContent = book.title;
      pageEl.textContent = t("no_text");
      counterEl.textContent = "";
      overlay.hidden = false;
      return;
    }
    // Resume exactly where the user left off (IndexedDB progress, mode "read").
    current = 0;
    document.getElementById("reader-title").textContent = book.title;

    const rows = await getProgress(book.id);
    for (const row of rows) {
      if (row.mode === "read" && row.position >= 0) {
        current = clampInt(row.position, 0, pages.length - 1);
      }
    }

    // Settings controls.
    const sizeSelect = document.getElementById("reader-size");
    const familySelect = document.getElementById("reader-family");
    const themeSelect = document.getElementById("reader-theme");
    sizeSelect.value = settings.font_size;
    familySelect.value = settings.font_family;
    themeSelect.value = settings.theme;
    sizeSelect.onchange = () => { settings.font_size = sizeSelect.value; saveReaderSettings(settings); applySettings(); };
    familySelect.onchange = () => { settings.font_family = familySelect.value; saveReaderSettings(settings); applySettings(); };
    themeSelect.onchange = () => { settings.theme = themeSelect.value; saveReaderSettings(settings); applySettings(); };

    document.getElementById("reader-prev").textContent = "‹";
    document.getElementById("reader-next").textContent = "›";
    document.getElementById("reader-close").textContent = t("close");
    jumpInput.placeholder = t("jump_to_page");
    document.getElementById("reader-jump-btn").textContent = t("go");

    // Swipe left/right changes pages (listeners bound once, routed to this reader).
    bindReaderGestures(overlay);
    activeReader = { go };

    renderPage();
    overlay.hidden = false;
  }

  document.getElementById("reader-prev").onclick = () => go(-1);
  document.getElementById("reader-next").onclick = () => go(1);
  document.getElementById("reader-jump-btn").onclick = () => {
    const target = clampInt(jumpInput.value, 1, pages.length) - 1;
    if (target !== current) { current = target; renderPage(); }
  };
  // Assigned with onkeydown (not addEventListener) so reopening replaces it.
  jumpInput.onkeydown = (e) => {
    if (e.key === "Enter") document.getElementById("reader-jump-btn").click();
  };

  function close() {
    flushProgress();
    activeReader = null;
    overlay.hidden = true;
  }
  document.getElementById("reader-close").onclick = close;

  load();
}

export { openReader };
