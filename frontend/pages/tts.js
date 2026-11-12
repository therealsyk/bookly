// Bookly "Voz IA" (Phase 5) - local TTS via window.speechSynthesis. No server,
// no audio cache. Reads the current page sentence by sentence, highlights the
// active sentence, advances pages automatically and stores progress with
// mode="tts" sharing the same current_page as the reading mode.

import { getPages, saveProgress } from "../db.js";
import { getPrefs, savePrefs } from "../db.js";
import { splitSentences } from "./sentences.js";

function clampInt(value, min, max) {
  const n = Math.round(Number(value));
  if (Number.isNaN(n)) return min;
  return Math.min(max, Math.max(min, n));
}

// --- Voice selection ----------------------------------------------------------

// speechSynthesis.getVoices() can arrive late on iOS/Chrome; callers must wait
// for the voiceschanged event. Prefer local pt-PT voices over remote ones.
export function pickVoice(voices, lang = "pt-PT") {
  if (!voices || !voices.length) return null;
  const exact = voices.filter((v) => v.lang === lang);
  if (exact.length) {
    const local = exact.find((v) => !v.remote);
    return local || exact[0];
  }
  const prefix = voices.filter((v) => v.lang && v.lang.startsWith(lang.split("-")[0]));
  if (prefix.length) {
    const local = prefix.find((v) => !v.remote);
    return local || prefix[0];
  }
  return null;
}

// Returns {voice, hasNativeVoice}. Falls back to the system default voice.
export function resolveVoice(voices, lang = "pt-PT") {
  const voice = pickVoice(voices, lang);
  return { voice, hasNativeVoice: !!voice };
}

// --- State machine -------------------------------------------------------------

function createTtsState(pages) {
  let pageIdx = 0;
  let sentenceIdx = 0;
  let sentences = [];
  let playing = false;

  function loadPage(idx) {
    pageIdx = clampInt(idx, 0, pages.length - 1);
    sentences = splitSentences(pages[pageIdx] || "");
    if (sentenceIdx >= sentences.length) sentenceIdx = Math.max(0, sentences.length - 1);
  }

  return {
    get pageIdx() { return pageIdx; },
    get sentenceIdx() { return sentenceIdx; },
    get sentences() { return sentences; },
    get playing() { return playing; },
    loadPage,
    setPlaying(value) { playing = !!value; },
    nextSentence() {
      if (sentenceIdx < sentences.length - 1) { sentenceIdx += 1; return true; }
      // End of page -> advance to the next one and continue.
      if (pageIdx < pages.length - 1) { loadPage(pageIdx + 1); sentenceIdx = 0; return "page"; }
      return false; // end of book
    },
    prevSentence() {
      if (sentenceIdx > 0) { sentenceIdx -= 1; return true; }
      if (pageIdx > 0) { loadPage(pageIdx - 1); sentenceIdx = Math.max(0, sentences.length - 1); return "page"; }
      return false;
    },
    nextPage() { if (pageIdx < pages.length - 1) { loadPage(pageIdx + 1); sentenceIdx = 0; return true; } return false; },
    prevPage() { if (pageIdx > 0) { loadPage(pageIdx - 1); sentenceIdx = 0; return true; } return false; },
    setSentenceIdx(n) { sentenceIdx = clampInt(n, 0, Math.max(0, sentences.length - 1)); },
  };
}

// Exposed for tests and for the UI wiring.
function openTts(book) {
  const overlay = document.getElementById("tts");
  const bodyEl = document.getElementById("tts-body");
  const counterEl = document.getElementById("tts-counter");
  const playBtn = document.getElementById("tts-playpause");
  const voiceSelect = document.getElementById("tts-voice");
  const speedInput = document.getElementById("tts-speed");
  const speedLabel = document.getElementById("tts-speed-label");
  const warningEl = document.getElementById("tts-warning");

  let pages = [];
  let state = null;
  let voice = null;
  let rate = 1;
  let resumeAttempted = false; // one retry if iOS stops the queue unexpectedly

  async function loadPrefs() {
    const prefs = await getPrefs();
    rate = Math.min(2, Math.max(0.5, Number(prefs.tts && prefs.tts.rate) || 1));
    speedInput.value = String(rate);
    speedLabel.textContent = `${rate.toFixed(1)}×`;
    return prefs;
  }

  function renderSentences() {
    bodyEl.innerHTML = "";
    state.sentences.forEach((s, i) => {
      const span = document.createElement("span");
      span.className = "tts-sentence" + (i === state.sentenceIdx ? " active" : "");
      span.textContent = s;
      bodyEl.appendChild(span);
    });
    // Smooth scroll the highlighted sentence into view.
    const active = bodyEl.querySelector(".active");
    if (active && typeof active.scrollIntoView === "function") {
      active.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }

  function updateCounter() {
    counterEl.textContent = `${t("page")} ${state.pageIdx + 1} ${t("of")} ${pages.length}`;
  }

  const saver = { timer: null };
  function queueProgress() {
    if (saver.timer) clearTimeout(saver.timer);
    saver.timer = setTimeout(() => saveNow(), 1000);
  }
  function saveNow() {
    if (saver.timer) { clearTimeout(saver.timer); saver.timer = null; }
    saveProgress(book.id, "tts", {
      position: state.pageIdx,
      chapter_index: 0,
      percent: pages.length ? (state.pageIdx + 1) / pages.length : 0,
    }).catch(() => {});
  }

  function speakCurrent() {
    if (!window.speechSynthesis || !state.sentences.length) return;
    const text = state.sentences[state.sentenceIdx];
    if (!text) return;
    const utter = new window.SpeechSynthesisUtterance(text);
    if (voice) utter.voice = voice;
    utter.lang = voice ? voice.lang : "pt-PT";
    utter.rate = rate;
    utter.onend = () => {
      resumeAttempted = false;
      const result = state.nextSentence();
      renderSentences();
      updateCounter();
      queueProgress();
      if (result === "page" || result === true) speakCurrent(); // auto-advance
    };
    utter.onerror = () => {
      // iOS sometimes aborts the queue; retry once when the user presses play.
      resumeAttempted = true;
    };
    window.speechSynthesis.speak(utter);
  }

  function play() {
    state.setPlaying(true);
    playBtn.textContent = t("tts_pause");
    speakCurrent();
  }

  function pause() {
    state.setPlaying(false);
    if (window.speechSynthesis) window.speechSynthesis.cancel();
    playBtn.textContent = t("tts_play");
    saveNow(); // flush on pause, per the requirement
  }

  async function loadVoices() {
    return new Promise((resolve) => {
      if (!window.speechSynthesis) return resolve([]);
      const immediate = window.speechSynthesis.getVoices();
      if (immediate.length) return resolve(immediate);
      window.speechSynthesis.addEventListener("voiceschanged", () => {
        resolve(window.speechSynthesis.getVoices());
      });
      // Fallback timeout so the UI never hangs.
      setTimeout(() => resolve(window.speechSynthesis.getVoices()), 1500);
    });
  }

  async function load() {
    pages = await getPages(book.id);
    if (!pages || !pages.length) {
      document.getElementById("tts-title").textContent = book.title;
      bodyEl.textContent = t("no_text");
      overlay.hidden = false;
      return;
    }

    const voices = await loadVoices();
    const resolved = resolveVoice(voices, "pt-PT");
    voice = resolved.voice;
    if (!resolved.hasNativeVoice) {
      warningEl.textContent = t("tts_no_voice");
      warningEl.hidden = false;
    }

    // iOS limitation: the queue can stop when the screen is locked.
    const keepScreen = document.createElement("p");
    keepScreen.className = "tts-warning";
    keepScreen.textContent = t("tts_keep_screen");
    warningEl.parentNode.insertBefore(keepScreen, bodyEl);

    state = createTtsState(pages);

    // Resume on the last page saved by either read or tts mode.
    const rows = await getProgress(book.id);
    let resumePage = 0;
    for (const row of rows) {
      if ((row.mode === "tts" || row.mode === "read") && row.position >= 0) {
        resumePage = clampInt(row.position, 0, pages.length - 1);
      }
    }
    state.loadPage(resumePage);
    state.setSentenceIdx(0);

    document.getElementById("tts-title").textContent = book.title;
    renderSentences();
    updateCounter();

    // Voice list.
    voiceSelect.innerHTML = "";
    if (!voices.length) {
      const opt = document.createElement("option");
      opt.value = "";
      opt.textContent = t("tts_default_voice");
      voiceSelect.appendChild(opt);
    } else {
      voices.forEach((v, i) => {
        const opt = document.createElement("option");
        opt.value = String(i);
        opt.textContent = `${v.name} (${v.lang})${v.remote ? " ☁" : ""}`;
        if (voice && v === voice) opt.selected = true;
        voiceSelect.appendChild(opt);
      });
    }
    voiceSelect.onchange = () => {
      const chosen = voices[Number(voiceSelect.value)];
      if (chosen) voice = chosen;
    };

    speedInput.oninput = () => {
      rate = Math.min(2, Math.max(0.5, Number(speedInput.value)));
      speedLabel.textContent = `${rate.toFixed(1)}×`;
      getPrefs().then((prefs) => {
        prefs.tts = { ...(prefs.tts || {}), rate };
        savePrefs({ tts: prefs.tts }).catch(() => {});
      });
    };

    playBtn.textContent = t("tts_play");
    playBtn.onclick = () => (state.playing ? pause() : play());
    document.getElementById("tts-prev-sentence").textContent = t("tts_prev_sentence");
    document.getElementById("tts-next-sentence").textContent = t("tts_next_sentence");
    document.getElementById("tts-prev-page").textContent = t("tts_prev_page");
    document.getElementById("tts-next-page").textContent = t("tts_next_page");

    document.getElementById("tts-prev-sentence").onclick = () => {
      if (state.prevSentence()) { renderSentences(); updateCounter(); queueProgress(); }
    };
    document.getElementById("tts-next-sentence").onclick = () => {
      if (state.nextSentence()) { renderSentences(); updateCounter(); queueProgress(); }
    };
    document.getElementById("tts-prev-page").onclick = () => {
      if (state.prevPage()) { state.setSentenceIdx(0); renderSentences(); updateCounter(); queueProgress(); }
    };
    document.getElementById("tts-next-page").onclick = () => {
      if (state.nextPage()) { state.setSentenceIdx(0); renderSentences(); updateCounter(); queueProgress(); }
    };

    document.getElementById("tts-close").textContent = t("close");
    document.getElementById("tts-close").onclick = () => {
      pause();
      saveNow(); // flush on close
      overlay.hidden = true;
    };

    overlay.hidden = false;
  }

  load();
}

export { openTts, createTtsState };
