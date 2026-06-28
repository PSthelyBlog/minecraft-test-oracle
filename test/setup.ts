// Vitest setup: pin a fixed fast-check seed so the property-based oracles draw the
// SAME sequence of inputs on every run. Without this, fast-check picks a random seed
// each run, which makes the suite — and therefore the mutation score — non-deterministic
// (a mutant near a property's detection edge gets killed on one run and survives on
// another). Determinism is the whole point of the repo's golden oracles; the tests that
// verify them should be reproducible too. See docs/TESTING.md.
//
// The seed fixes the *sequence*, not the breadth: each property still explores its full
// `numRuns` of edge-biased inputs, just the same ones each time. Override with
// `FAST_CHECK_SEED=<n>` to explore a different sample locally (e.g. to hunt for inputs
// the pinned seed happens to miss).
import fc from "fast-check";

// Read the env without pulling in @types/node (tsconfig restricts `types` to vite/client).
const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
const override = env?.FAST_CHECK_SEED;
const seed = override ? Number(override) : 0x5eed;
fc.configureGlobal({ seed });
