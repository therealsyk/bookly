import { defineConfig } from "vite";
import { copyFileSync, mkdirSync, readdirSync } from "fs";

// The app is fully client-side: Vite only serves/builds the frontend.
// PWA static files (manifest.json, sw.js, icons/) are copied to dist as-is so
// /manifest.json, /sw.js and /icons/* resolve after build. Locales are loaded
// at runtime via fetch("/locales/<lang>.json"), so they must be served too.
function copyStatic() {
  const src = "frontend";
  const out = "dist";
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
