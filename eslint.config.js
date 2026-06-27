// Flat ESLint config. Pragmatic by design (see issue #13): JS + typescript-eslint
// recommended (NON-type-checked, so lint stays fast and needs no tsconfig project),
// with eslint-config-prettier last to switch off every stylistic rule and leave
// formatting entirely to Prettier. The goal is consistency, not a rule fight — the
// core's dense oracle comments and Vec3 tuple math are intentional.
import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";

export default tseslint.config(
  // Build output, generated reports, and the Stryker sandbox are never linted.
  { ignores: ["dist/", "reports/", ".stryker-tmp/"] },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  // Source is TypeScript run in the browser (main.ts) or pure (the core). `tsc`
  // (the typecheck CI job) already resolves every name, so leave undefined-name
  // checking to it and just declare the ambient globals for completeness.
  {
    files: ["**/*.ts"],
    languageOptions: {
      globals: { ...globals.browser, ...globals.node },
    },
    rules: {
      "no-undef": "off",
    },
  },

  // Node tooling scripts (smoke / mutation:clean) are plain ESM JS — keep
  // no-undef on here, with Node globals, since there's no tsc pass over them.
  // smoke.mjs also embeds browser-evaluated callbacks (`page.evaluate(() => …)`)
  // that legitimately reference DOM globals, so allow those here too.
  {
    files: ["scripts/**/*.mjs"],
    languageOptions: {
      globals: { ...globals.node, ...globals.browser },
    },
  },

  // Project-wide pragmatic relaxations (issue #13: consistency, not a rule fight).
  {
    rules: {
      // The core deliberately seeds defensive initializers that every code path
      // overwrites before use (e.g. raycast's `normal`), partly because TS strict
      // definite-assignment requires a value when a loop body may not run. Those
      // are documented as equivalent mutants in docs/TESTING.md, not dead code.
      "no-useless-assignment": "off",
    },
  },

  // Must stay last: disables the formatting rules Prettier owns.
  prettier,
);
