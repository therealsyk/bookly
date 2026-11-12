import { saveProgress } from "./db.js";

// Debounced progress saving (1 s) with flush on close - same behaviour as the
// reader/player in the backend port.
export function makeProgressSaver(bookId, mode) {
  let timer = null;
  let pending = null;

  function flush() {
    if (!pending) return;
    saveProgress(bookId, mode, pending);
    pending = null;
  }

  return {
    update(position, extra = {}) {
      pending = { position, ...extra };
      clearTimeout(timer);
      timer = setTimeout(flush, 1000);
    },
    flush,
  };
}
