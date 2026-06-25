import { describe, test, expect } from "vitest";
import fc from "fast-check";
import { World } from "./world";
import { Block } from "./blocks";
import { generateTerrain, heightAt, hash2 } from "./terrain";

function fnv1a(bytes: Uint8Array): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i];
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}

describe("terrain oracle", () => {
  // DETERMINISM / GOLDEN: terrain is a pure function of (seed, size). The exact
  // byte content of a fixed small world is frozen; ANY drift in the generator
  // (noise, layering, thresholds) changes this hash and fails loudly.
  test("golden: fixed seed+size produces a stable world hash", () => {
    const w = new World(16, 24, 16);
    generateTerrain(w, 1337);
    expect(fnv1a(w.data)).toBe("99fb25e6");
  });

  // DETERMINISM: regenerating with the same seed is byte-identical; a different
  // seed changes something.
  test("same seed → identical bytes; different seed → different bytes", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 1e6 }), (seed) => {
        const a = new World(12, 20, 12);
        const b = new World(12, 20, 12);
        generateTerrain(a, seed);
        generateTerrain(b, seed);
        expect(a.data).toEqual(b.data);
      }),
    );
    const a = new World(12, 20, 12);
    const b = new World(12, 20, 12);
    generateTerrain(a, 1);
    generateTerrain(b, 2);
    expect(a.data).not.toEqual(b.data);
  });

  // INVARIANT: heightAt stays inside [1, sizeY-1] for any column — guarantees a
  // bedrock floor below and open air above, no clamping bugs.
  test("heightAt is always within [1, sizeY-1]", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 1e6 }),
        fc.integer({ min: 8, max: 64 }),
        fc.integer({ min: -500, max: 500 }),
        fc.integer({ min: -500, max: 500 }),
        (seed, sizeY, x, z) => {
          const h = heightAt(seed, sizeY, x, z);
          expect(Number.isInteger(h)).toBe(true);
          expect(h).toBeGreaterThanOrEqual(1);
          expect(h).toBeLessThanOrEqual(sizeY - 1);
        },
      ),
    );
  });

  // STRUCTURAL CENSUS: every generated column obeys the layering contract:
  //   y=0 is Bedrock, the surface block is Grass/Sand, dirt sits under the
  //   surface, stone forms the core, and there is never stone directly on top.
  test("every column has the correct vertical layering", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 1e6 }), (seed) => {
        const w = new World(10, 24, 10);
        generateTerrain(w, seed);
        for (let z = 0; z < w.sizeZ; z++) {
          for (let x = 0; x < w.sizeX; x++) {
            const h = heightAt(seed, w.sizeY, x, z);
            expect(w.get(x, 0, z)).toBe(Block.Bedrock); // unbreakable floor
            const surface = w.get(x, h, z);
            expect([Block.Grass, Block.Sand]).toContain(surface); // top is ground, not stone/air
            if (h >= 1) expect(w.get(x, h - 1, z)).not.toBe(Block.Air); // solid under surface
            // directly above the surface is never solid ground
            expect([Block.Air, Block.Water]).toContain(w.get(x, h + 1, z));
          }
        }
      }),
      { numRuns: 60 },
    );
  });

  // INVARIANT: water never appears above the sea level, and every water cell
  // sits on or below it. Pins the L90 `y <= sea` threshold.
  test("water only exists at or below sea level", () => {
    const sea = 9;
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 1e6 }), (seed) => {
        const w = new World(10, 24, 10);
        generateTerrain(w, seed, sea);
        for (let y = 0; y < w.sizeY; y++)
          for (let z = 0; z < w.sizeZ; z++)
            for (let x = 0; x < w.sizeX; x++) {
              if (w.get(x, y, z) === Block.Water) expect(y).toBeLessThanOrEqual(sea);
            }
      }),
      { numRuns: 40 },
    );
  });

  // TOTALITY: the hash primitive is deterministic and bounded in [0, 1).
  test("hash2 is deterministic and in [0,1)", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -1e6, max: 1e6 }),
        fc.integer({ min: -1e4, max: 1e4 }),
        fc.integer({ min: -1e4, max: 1e4 }),
        (s, x, z) => {
          const v = hash2(s, x, z);
          expect(v).toBe(hash2(s, x, z));
          expect(v).toBeGreaterThanOrEqual(0);
          expect(v).toBeLessThan(1);
        },
      ),
    );
  });
});
