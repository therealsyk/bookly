import { defineConfig } from "vite";
import fs from "node:fs";
import { copyFileSync, mkdirSync, readdirSync } from "fs";

// The app is fully client-side: Vite only serves/builds the frontend.
// PWA static files (manifest.json, sw.js, icons/) are copied to dist as-is so
// /manifest.json, /sw.js and /icons/* resolve after build. Locales are loaded
// at runtime via fetch("/locales/<lang>.json"), so they must be served too.
function copyStatic() {
  const src = "frontend";
  const out = "dist";
  // Vite hashes asset links in index.html (./assets/manifest-<hash>.json).
  // A relative "start_url" in the manifest is resolved against the manifest's
  // own URL, so a hashed manifest inside assets/ makes the home-screen icon
  // open /bookly/assets/ -> 404. Point the shell at the root copies instead.
  const htmlPath = out + "/index.html";
  const html = fs.readFileSync(htmlPath, "utf8");
  const fixed = html
    .replace(/href="[^"]*manifest-[^"]*\.json"/g, 'href="./manifest.json"')
    .replace(/href="\/icons\/[^"]*"/g, 'href="./icons/icon-192.png"')
    .replace(/href="[^"]*icon-192[^"]*"/g, 'href="./icons/icon-192.png"');
  fs.writeFileSync(htmlPath, fixed);
  mkdirSync(out + "/icons", { recursive: true });
  mkdirSync(out + "/locales", { recursive: true });
  copyFileSync(src + "/manifest.json", out + "/manifest.json");
  copyFileSync(src + "/sw.js", out + "/sw.js");
  for (const icon of readdirSync(src + "/icons")) {
    copyFileSync(src + "/icons/" + icon, out + "/icons/" + icon);
  }
  for (const loc of readdirSync(src + "/locales")) {
    copyFileSync(src + "/locales/" + loc, out + "/locales/" + loc);
  }
}

export default defineConfig({
  root: "frontend",
  // Relative base so the app works on GitHub Pages under a repo subpath.
  base: "./",
  build: { outDir: "../dist", emptyOutDir: true },
  publicDir: false,
  plugins: [
    {
      name: "bookly-static-pwa",
      closeBundle: () => copyStatic(),
    },
  ],
});
