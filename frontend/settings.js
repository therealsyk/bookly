import { getPrefs, savePrefs } from "./db.js";

export async function loadPrefs() {
  return getPrefs();
}

export async function updatePrefs(payload) {
  return savePrefs(payload);
}
