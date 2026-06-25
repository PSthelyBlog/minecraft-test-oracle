import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["**/*.{test,spec}.{js,jsx,ts,tsx,mjs,cjs}"],
    environment: "node",
  },
});
