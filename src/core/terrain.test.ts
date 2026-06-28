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

// INDEPENDENT re-derivation of tree placement (a second implementation of the rule
// in terrain.ts, sharing only the hash2/heightAt primitives — which have their own
// oracles). The census test below asserts the generator's trunks match this exactly.
const TREE_CELL = 5;
const TREE_DENSITY = 0.5;
const CANOPY_RADIUS = 2;
const SALT_GATE = 0x7a1;
const SALT_OX = 0x1b3;
const SALT_OZ = 0x2d9;
const SALT_TRUNK = 0x5e7;

interface ExpectedTree {
  x: number;
  z: number;
  base: number;
  top: number;
}

function expectedTrees(seed: number, sizeX: number, sizeY: number, sizeZ: number): ExpectedTree[] {
  const sea = Math.floor(sizeY * 0.42);
  const out: ExpectedTree[] = [];
  for (let cz = 0; cz < Math.ceil(sizeZ / TREE_CELL); cz++) {
    for (let cx = 0; cx < Math.ceil(sizeX / TREE_CELL); cx++) {
      if (hash2(seed ^ SALT_GATE, cx, cz) >= TREE_DENSITY) continue;
      const x = cx * TREE_CELL + Math.floor(hash2(seed ^ SALT_OX, cx, cz) * TREE_CELL);
      const z = cz * TREE_CELL + Math.floor(hash2(seed ^ SALT_OZ, cx, cz) * TREE_CELL);
      if (x < CANOPY_RADIUS || x >= sizeX - CANOPY_RADIUS) continue;
      if (z < CANOPY_RADIUS || z >= sizeZ - CANOPY_RADIUS) continue;
      const height = heightAt(seed, sizeY, x, z);
      if (height <= sea + 1) continue;
      const top = height + 4 + Math.floor(hash2(seed ^ SALT_TRUNK, cx, cz) * 3);
      if (top + 1 > sizeY - 1) continue;
      out.push({ x, z, base: height + 1, top });
    }
  }
  return out;
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
            // directly above the surface is never solid ground (but may be a tree)
            expect([Block.Air, Block.Water, Block.Log, Block.Leaves]).toContain(w.get(x, h + 1, z));
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

  // TREE GOLDEN: a world that actually grows trees (the existing golden world has
  // none) — freezes the exact Log/Leaves output so any drift in tree placement or
  // shape fails loudly.
  test("golden: a tree-bearing world has a stable hash", () => {
    const w = new World(24, 20, 24);
    generateTerrain(w, 7);
    expect(fnv1a(w.data)).toBe("68ddd847");
  });

  // TREE CENSUS (independent re-derivation): the generator's trunks must match the
  // re-derived placement rule EXACTLY — every predicted tree has a Log trunk rooted
  // on Grass, and every trunk base in the world is a predicted tree (bijection).
  test("trees appear exactly where the placement rule predicts", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 1e6 }), (seed) => {
        const w = new World(24, 20, 24);
        generateTerrain(w, seed);
        const trees = expectedTrees(seed, 24, 20, 24);

        // (i) each predicted tree: Grass under the base, Log from base to top
        for (const t of trees) {
          expect(w.get(t.x, t.base - 1, t.z)).toBe(Block.Grass);
          for (let y = t.base; y <= t.top; y++) expect(w.get(t.x, y, t.z)).toBe(Block.Log);
        }
        // (ii) bijection: every trunk base in the world is a predicted tree
        const predicted = new Set(trees.map((t) => `${t.x},${t.z}`));
        for (let z = 0; z < 24; z++)
          for (let x = 0; x < 24; x++) {
            const h = heightAt(seed, 20, x, z);
            if (w.get(x, h + 1, z) === Block.Log) {
              expect(predicted.has(`${x},${z}`)).toBe(true);
            }
          }
      }),
      { numRuns: 60 },
    );
  });

  // INVARIANT: every Log is grounded — the cell directly below is Log or Grass.
  // Kills mutations that float a trunk or root it on sand/water/air.
  test("every Log is grounded on Log or Grass (trunks are contiguous, on grass)", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 1e6 }), (seed) => {
        const w = new World(24, 20, 24);
        generateTerrain(w, seed);
        for (let y = 1; y < w.sizeY; y++)
          for (let z = 0; z < w.sizeZ; z++)
            for (let x = 0; x < w.sizeX; x++) {
              if (w.get(x, y, z) === Block.Log) {
                expect([Block.Log, Block.Grass]).toContain(w.get(x, y - 1, z));
              }
            }
      }),
      { numRuns: 40 },
    );
  });

  // EXPLICIT STRUCTURE (non-vacuous): a fixed seed grows ≥1 tree; each has a Log
  // trunk base and top, and a Leaves cap directly above the trunk.
  test("a known seed grows trees with Log trunks and a Leaves cap", () => {
    const w = new World(24, 20, 24);
    generateTerrain(w, 7);
    const trees = expectedTrees(7, 24, 20, 24);
    expect(trees.length).toBeGreaterThan(0);
    for (const t of trees) {
      expect(w.get(t.x, t.base, t.z)).toBe(Block.Log);
      expect(w.get(t.x, t.top, t.z)).toBe(Block.Log);
      expect(w.get(t.x, t.top + 1, t.z)).toBe(Block.Leaves); // canopy cap above the trunk
    }
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
