// Bookly paginated text reader (Phase 3).
// Loaded from app.js via openReader(book). All text goes through t() which
// lives in the main shell; settings persist in localStorage and are saved to
// the server through PUT /api/prefs.

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
  // Persist to the server too (best effort; the app works offline via sw.js).
  fetch("/api/prefs", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ reader: settings }),
  }).catch(() => {});
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
    saveProgress();
  }

  // Debounced progress save (1 s) on every page change.
  let progressTimer = null;
  function saveProgress() {
    if (progressTimer) clearTimeout(progressTimer);
    progressTimer = setTimeout(() => {
      fetch(`/api/progress/${book.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode: "read",
          position: current,
          chapter_index: 0,
          percent: pages.length ? (current + 1) / pages.length : 0,
        }),
      }).catch(() => {});
    }, 1000);
  }

  function flushProgress() {
    // Save immediately when the reader closes.
    if (progressTimer) clearTimeout(progressTimer);
    progressTimer = null;
    fetch(`/api/progress/${book.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        mode: "read",
        position: current,
        chapter_index: 0,
        percent: pages.length ? (current + 1) / pages.length : 0,
      }),
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
    const data = await api(`/api/library/pages/${book.id}`);
    if (!data || !Array.isArray(data.pages) || !data.pages.length) {
      document.getElementById("reader-title").textContent = book.title;
      pageEl.textContent = t("no_text");
      counterEl.textContent = "";
      overlay.hidden = false;
      return;
    }
    pages = data.pages;
    // Resume exactly where the user left off.
    current = clampInt(data.current_page, 0, pages.length - 1);
    document.getElementById("reader-title").textContent = book.title;

    const prev = await api(`/api/progress/${book.id}`);
    if (prev && prev.progress) {
      for (const row of prev.progress) {
        if (row.mode === "read" && row.position >= 0) {
          current = clampInt(row.position, 0, pages.length - 1);
        }
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

    // Swipe left/right changes pages.
    let touchStartX = null;
    overlay.addEventListener("touchstart", (e) => { touchStartX = e.touches[0].clientX; }, { passive: true });
    overlay.addEventListener("touchend", (e) => {
      if (touchStartX === null) return;
      const dx = e.changedTouches[0].clientX - touchStartX;
      touchStartX = null;
      if (Math.abs(dx) > 40) go(dx < 0 ? 1 : -1); // swipe left -> next, right -> previous
    });

    renderPage();
    overlay.hidden = false;
  }

  document.getElementById("reader-prev").onclick = () => go(-1);
  document.getElementById("reader-next").onclick = () => go(1);
  document.getElementById("reader-jump-btn").onclick = () => {
    const target = clampInt(jumpInput.value, 1, pages.length) - 1;
    if (target !== current) { current = target; renderPage(); }
  };
  jumpInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") document.getElementById("reader-jump-btn").click();
  });

  function close() {
    flushProgress();
    overlay.hidden = true;
  }
  document.getElementById("reader-close").onclick = close;

  load();
}
