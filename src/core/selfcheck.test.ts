import { describe, test, expect } from "vitest";
import { selfCheck } from "./selfcheck";

/**
 * The boot self-check is the production-runtime guard. Its own oracle is simple:
 * on a correct build it must pass (return true, not throw). It is itself a
 * re-derivation of the core invariants, so the deeper falsifiability lives in the
 * per-module oracles + mutation testing; here we just pin that the gate is wired
 * and green.
 */
describe("selfcheck oracle", () => {
  test("passes on a correct build", () => {
    expect(selfCheck()).toBe(true);
    expect(() => selfCheck()).not.toThrow();
  });
});
