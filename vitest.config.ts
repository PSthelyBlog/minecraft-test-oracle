import { defineConfig, configDefaults } from "vitest/config";

export default defineConfig({
  test: {
    include: ["**/*.{test,spec}.{js,jsx,ts,tsx,mjs,cjs}"],
    // Never pick up a StrykerJS sandbox copy of the suite (e.g. if a mutation run
    // crashed before cleaning .stryker-tmp) — it would silently double every count.
    exclude: [...configDefaults.exclude, "**/.stryker-tmp/**"],
    environment: "node",
    // Pin the fast-check seed (test/setup.ts) so property runs — and the mutation
    // score — are reproducible run-to-run. See docs/TESTING.md.
    setupFiles: ["./test/setup.ts"],
    // The heavier property-based oracles (e.g. the mesher AO census, which calls
    // world.get ~12× per face over many random worlds) run well under a second
    // normally, but StrykerJS instruments the source — on a slow CI runner a single
    // such test can cross vitest's default 5s testTimeout and abort the mutation
    // dry-run. Give property tests room; hung mutants are still bounded by Stryker's
    // own per-mutant timeout, so this doesn't slow mutation or weaken any oracle.
    testTimeout: 20000,
  },
});
