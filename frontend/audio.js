import { fetchJson } from "./sources/_common.js";
import { getAudioTracks } from "./sources/librivox.js";
import { getFiles, downloadUrl } from "./sources/archive.js";

// Validate an MP3 with a real HEAD request before saving it (Prompt 6b: tracks
// are validated with a real request). No Range support needed on the client -
// <audio> streams directly from archive.org/librivox mirrors.
export async function validateMp3(url) {
  try {
    const res = await fetch(url, { method: "HEAD" });
    if (!res.ok) return false;
    const type = res.headers.get("content-type") || "";
    return res.ok && (type.includes("audio") || url.toLowerCase().endsWith(".mp3"));
  } catch {
    return false;
  }
}

export async function getAudioTracksForBook(source, sourceId) {
  if (source === "librivox") {
    const tracks = await getAudioTracks(sourceId);
    const validated = [];
    for (const tr of tracks) {
      if (await validateMp3(tr.url)) validated.push(tr);
    }
    return validated; // empty list -> caller shows "no audio available"
  }

  if (source === "archive") {
    const files = await getFiles(sourceId);
    const mp3s = files.mp3s || [];
    const tracks = [];
    for (let i = 0; i < mp3s.length; i++) {
      const url = downloadUrl(sourceId, mp3s[i].name);
      if (await validateMp3(url)) {
        tracks.push({ chapter_index: i, title: mp3s[i].title || mp3s[i].name, url, duration_sec: null });
      }
    }
    return tracks;
  }

  return []; // gutenberg/googlebooks/pdf -> no audio
}
