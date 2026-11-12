// Bookly audio player (Phase 4). <audio>-based, with chapter list, ±15s,
// speed 0.75-2x, sleep timer, Media Session API lock-screen controls,
// position saved every 5 s and resume on reopen, next-chapter preload and
// auto-advance. Audio is served by the backend with Range support (iOS/Safari).

let activePlayer = null;

function fmtClock(sec) {
  const s = Math.max(0, Math.floor(sec || 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

async function openPlayer(book) {
  const overlay = document.getElementById("player");
  const audio = document.getElementById("player-audio");
  const cover = document.getElementById("player-cover");
  const titleEl = document.getElementById("player-title");
  const chaptersEl = document.getElementById("player-chapters");
  const timeEl = document.getElementById("player-time");
  const speedSel = document.getElementById("player-speed");
  const sleepSel = document.getElementById("player-sleep");

  titleEl.textContent = book.title;
  if (book.cover_url) { cover.src = book.cover_url; cover.hidden = false; } else { cover.hidden = true; }

  const data = await fetch(`/api/audio/${book.id}`).then(r => r.json()).catch(() => null);
  const tracks = (data && data.tracks) || [];
  if (!tracks.length) {
    chaptersEl.textContent = t("no_audio");
    overlay.hidden = false;
    return;
  }

  // Chapter list.
  chaptersEl.innerHTML = "";
  tracks.forEach((tr, i) => {
    const btn = document.createElement("button");
    btn.className = "chapter-btn";
    btn.textContent = `${t("chapter")} ${i + 1} — ${tr.title}`;
    btn.dataset.index = String(i);
    btn.onclick = () => playChapter(i, 0);
    chaptersEl.appendChild(btn);
  });

  // Restore saved position (mode "listen": position = seconds into chapter,
  // chapter_index = which track).
  let startTrack = 0;
  let startPos = 0;
  try {
    const prog = await fetch(`/api/progress/${book.id}`).then(r => r.json());
    const listen = (prog.progress || []).find(p => p.mode === "listen");
    if (listen) {
      startTrack = Math.min(tracks.length - 1, Math.max(0, listen.chapter_index));
      startPos = listen.position || 0;
    }
  } catch (err) { /* first time */ }

  // Pre-load the next chapter in a hidden audio element so switching is instant.
  let nextAudio = null;
  function preloadNext(index) {
    if (index + 1 >= tracks.length) { nextAudio = null; return; }
    nextAudio = new Audio(tracks[index + 1].url);
    nextAudio.preload = "auto";
  }

  let saveTimer = null;
  function saveProgress() {
    const total = tracks.reduce((sum, tr) => sum + (tr.duration_sec || 0), 0) || 0;
    const elapsedBefore = tracks.slice(0, currentTrack).reduce((sum, tr) => sum + (tr.duration_sec || 0), 0);
    const percent = total ? (elapsedBefore + audio.currentTime) / total : 0;
    fetch(`/api/progress/${book.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "listen", position: audio.currentTime, chapter_index: currentTrack, percent }),
    }).catch(() => {});
  }

  let currentTrack = startTrack;

  function playChapter(index, offset) {
    currentTrack = index;
    audio.src = tracks[index].url;
    audio.playbackRate = parseFloat(speedSel.value) || 1;
    audio.addEventListener("loadedmetadata", () => {
      if (offset > 0 && offset < (audio.duration || 0)) audio.currentTime = offset;
    }, { once: true });
    audio.play().catch(() => {});
    preloadNext(index);
    updateMediaSession(index);
  }

  function updateMediaSession(index) {
    if (!("mediaSession" in navigator)) return;
    navigator.mediaSession.metadata = new MediaMetadata({
      title: tracks[index].title || book.title,
      artist: book.author || "",
      album: book.title,
      artwork: book.cover_url ? [{ src: book.cover_url, sizes: "512x512", type: "image/jpeg" }] : [],
    });
    navigator.mediaSession.setActionHandler("play", () => audio.play().catch(() => {}));
    navigator.mediaSession.setActionHandler("pause", () => audio.pause());
    navigator.mediaSession.setActionHandler("seekbackward", () => { audio.currentTime = Math.max(0, audio.currentTime - 15); });
    navigator.mediaSession.setActionHandler("seekforward", () => { audio.currentTime = Math.min(audio.duration || 0, audio.currentTime + 15); });
    navigator.mediaSession.setActionHandler("prevtrack", () => { if (currentTrack > 0) playChapter(currentTrack - 1, 0); });
    navigator.mediaSession.setActionHandler("nexttrack", () => { if (currentTrack < tracks.length - 1) playChapter(currentTrack + 1, 0); });
  }

  // Save position every 5 seconds.
  audio.addEventListener("timeupdate", () => {
    timeEl.textContent = `${fmtClock(audio.currentTime)} / ${fmtClock(audio.duration || tracks[currentTrack].duration_sec || 0)}`;
    if (!saveTimer) {
      saveTimer = setTimeout(() => { saveTimer = null; saveProgress(); }, 5000);
    }
  });

  // Auto-advance to the next chapter when this one ends.
  audio.addEventListener("ended", () => {
    saveProgress();
    if (currentTrack + 1 < tracks.length) playChapter(currentTrack + 1, 0);
  });

  document.getElementById("player-playpause").onclick = () => {
    if (audio.paused) audio.play().catch(() => {}); else audio.pause();
  };
  document.getElementById("player-back15").onclick = () => { audio.currentTime = Math.max(0, audio.currentTime - 15); };
  document.getElementById("player-fwd15").onclick = () => { audio.currentTime = Math.min(audio.duration || 0, audio.currentTime + 15); };

  // Speed/sleep are wired below (listeners that also persist to prefs).

  // Sleep timer: pause after N minutes.
  let sleepTimer = null;
  sleepSel.onchange = () => {
    if (sleepTimer) clearTimeout(sleepTimer);
    const mins = parseInt(sleepSel.value, 10);
    if (mins > 0) sleepTimer = setTimeout(() => audio.pause(), mins * 60000);
  };

  document.getElementById("player-close").onclick = () => {
    saveProgress();          // flush on close
    audio.pause();
    if (sleepTimer) clearTimeout(sleepTimer);
    overlay.hidden = true;
  };

  // Restore speed/sleep from saved prefs and persist changes back.
  speedSel.value = String(prefs && prefs.speed ? prefs.speed : 1);
  sleepSel.value = String(prefs && prefs.sleep_minutes ? prefs.sleep_minutes : 0);
  const savePlayerPrefs = () => fetch("/api/prefs", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ speed: parseFloat(speedSel.value) || 1, sleep_minutes: parseInt(sleepSel.value, 10) || 0 }),
  }).catch(() => {});
  speedSel.addEventListener("change", savePlayerPrefs);
  sleepSel.addEventListener("change", savePlayerPrefs);

  playChapter(startTrack, startPos);
  activePlayer = { audio, saveProgress };
}

// Expose for app.js.
window.openPlayer = openPlayer;
