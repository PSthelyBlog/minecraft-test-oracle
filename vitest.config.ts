import { defineConfig, configDefaults } from "vitest/config";

export default defineConfig({
  test: {
    include: ["**/*.{test,spec}.{js,jsx,ts,tsx,mjs,cjs}"],
    // Never pick up a StrykerJS sandbox copy of the suite (e.g. if a mutation run
    // crashed before cleaning .stryker-tmp) — it would silently double every count.
    exclude: [...configDefaults.exclude, "**/.stryker-tmp/**"],
    environment: "node",
  },
});
