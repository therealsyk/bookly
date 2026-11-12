import { defineConfig } from "vite";

// The app is fully client-side: Vite only serves/builds the frontend.
export default defineConfig({
  root: "frontend",
  build: { outDir: "../dist", emptyOutDir: true },
  publicDir: false,
});
