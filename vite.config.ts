import { defineConfig } from "vite";

// Relative base so the production build works both locally (`vite preview`) and
// when served from a GitHub Pages project subpath (https://user.github.io/<repo>/).
// Test config lives separately in vitest.config.ts.
export default defineConfig({
  base: "./",
});
