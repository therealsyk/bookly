import { defineConfig } from "vitest/config";

// jsdom provides DOMParser (browser API) so the ISPSN parser tests run for real.
export default defineConfig({
  test: {
    environment: "jsdom",
    include: ["frontend/tests/**/*.test.js"],
  },
});
