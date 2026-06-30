import { describe, test, expect } from "vitest";
import fc from "fast-check";
import { World } from "./world";
import { Block, isSolid } from "./blocks";
import { generateTerrain } from "./terrain";
import { computeWater } from "./water";

/**
 * Water is a deterministic flood fill (the Minecraft Classic model): a non-solid cell is
 * water iff reachable from a `Block.Water` source by SIDEWAYS or DOWNWARD steps, never up.
 * These oracles re-derive that set INDEPENDENTLY of the BFS in water.ts — an inflow
 * relaxation to the same least fixpoint, the fixpoint condition itself, an inflow-witness
 * invariant ("no water from nowhere; never rises"), a damming metamorphic, and goldens —
 * so water leaking through a wall, flowing uphill, appearing from nowhere, or failing to
 * fill a reachable gap all disagree with at least one oracle.
 */

// The four horizontal neighbours (same y); water also flows straight down, never up.
const HORIZONTAL = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
] as const;

/**
 * The flood operator F at one cell, stated straight from the rule and INDEPENDENT of
 * water.ts: a solid cell holds nothing; otherwise it is water iff it is a source, OR the
 * cell directly ABOVE it is water (it flowed down in), OR a HORIZONTAL neighbour is water
 * (it spread in sideways). The cell BELOW never feeds it — water does not flow up.
 */
function floodAt(w: World, water: Uint8Array, x: number, y: number, z: number): 0 | 1 {
  if (isSolid(w.get(x, y, z))) return 0;
  if (w.get(x, y, z) === Block.Water) return 1;
  if (w.inBounds(x, y + 1, z) && water[w.index(x, y + 1, z)] === 1) return 1; // flowed down from above
  for (const [dx, dz] of HORIZONTAL) {
    if (!w.inBounds(x + dx, y, z + dz)) continue;
    if (water[w.index(x + dx, y, z + dz)] === 1) return 1; // spread in sideways
  }
  return 0;
}

/**
 * INDEPENDENT re-derivation: relax to the same least fixpoint by repeated full sweeps
 * (Gauss–Seidel), a different mechanism from water.ts's BFS queue. Each cell rises to
 * `floodAt` until nothing changes.
 */
function relaxWater(w: World): Uint8Array {
  const W = new Uint8Array(w.volume);
  let changed = true;
  while (changed) {
    changed = false;
    for (let y = 0; y < w.sizeY; y++)
      for (let z = 0; z < w.sizeZ; z++)
        for (let x = 0; x < w.sizeX; x++) {
          const v = floodAt(w, W, x, y, z);
          const i = w.index(x, y, z);
          if (v > W[i]) {
            W[i] = v;
            changed = true;
          }
        }
  }
  return W;
}

// Random small worlds biased toward water sources, walls, and open space.
const randomCells = fc.array(
  fc.constantFrom(
    Block.Air,
    Block.Air, // bias toward open space so water has room to flow
    Block.Stone, // solid wall / floor
    Block.Water, // source
  ),
  { minLength: 125, maxLength: 125 },
);
const fill = (cells: number[]): World => {
  const w = new World(5, 5, 5);
  cells.forEach((b, i) => (w.data[i] = b));
  return w;
};

describe("water-flood oracle", () => {
  // RE-DERIVATION (headline): the BFS field equals an independent Gauss–Seidel relaxation
  // to the same least fixpoint, cell for cell, over random worlds. A wrong direction, a
  // missed neighbour, or leaking through a wall makes the two mechanisms disagree.
  test("re-derivation: BFS flood equals an independent relaxation", () => {
    fc.assert(
      fc.property(randomCells, (cells) => {
        const w = fill(cells);
        expect(Array.from(computeWater(w))).toEqual(Array.from(relaxWater(w)));
      }),
      { numRuns: 300 },
    );
  });

  // FIXPOINT: the computed field is a FIXED POINT of the flood rule — applying F to every
  // cell reproduces it exactly. Re-derived from the rule (floodAt), so a wrong spread/fall
  // leaves some cell unsettled and this disagrees.
  test("fixpoint: applying the flood rule to the result changes nothing", () => {
    fc.assert(
      fc.property(randomCells, (cells) => {
        const w = fill(cells);
        const water = computeWater(w);
        for (let y = 0; y < 5; y++)
          for (let z = 0; z < 5; z++)
            for (let x = 0; x < 5; x++)
              expect(water[w.index(x, y, z)]).toBe(floodAt(w, water, x, y, z));
      }),
      { numRuns: 300 },
    );
  });

  // INVARIANTS: values are binary; solid cells hold no water; water blocks are wet; and
  // the INFLOW-WITNESS — every non-source water cell has water directly above it (flowed
  // down) or a horizontal water neighbour (spread). Water never appears from nowhere and
  // never rises: a cell whose only watered neighbour is BELOW it stays dry.
  test("invariants: binary, solids dry, sources wet, and every drop has a non-rising inflow", () => {
    fc.assert(
      fc.property(randomCells, (cells) => {
        const w = fill(cells);
        const water = computeWater(w);
        for (let y = 0; y < 5; y++)
          for (let z = 0; z < 5; z++)
            for (let x = 0; x < 5; x++) {
              const v = water[w.index(x, y, z)];
              expect(v === 0 || v === 1).toBe(true);
              const id = w.get(x, y, z);
              if (isSolid(id)) expect(v).toBe(0);
              if (id === Block.Water) expect(v).toBe(1);
              if (v === 1 && id !== Block.Water) {
                const above = w.inBounds(x, y + 1, z) && water[w.index(x, y + 1, z)] === 1;
                let witness = above; // flowed down from above
                for (const [dx, dz] of HORIZONTAL) {
                  if (!w.inBounds(x + dx, y, z + dz)) continue;
                  if (water[w.index(x + dx, y, z + dz)] === 1) witness = true; // spread sideways
                }
                expect(witness).toBe(true);
              }
            }
      }),
      { numRuns: 300 },
    );
  });

  // GAP-FILLING GOLDEN (the whole point of the redesign): a single source in one corner
  // of an ENCLOSED flat basin floods the ENTIRE reachable floor — water fills the gap and
  // lies flat, instead of decaying away from the source. (The old level CA left most of
  // this basin dry; see docs/TESTING.md.)
  test("golden: a source floods an entire enclosed basin floor (gap-filling)", () => {
    const N = 9;
    const w = new World(N, 3, N);
    for (let z = 0; z < N; z++)
      for (let x = 0; x < N; x++) {
        w.set(x, 0, z, Block.Stone); // floor
        if (x === 0 || z === 0 || x === N - 1 || z === N - 1) w.set(x, 1, z, Block.Stone); // walls
      }
    w.set(1, 1, 1, Block.Water); // one source in a corner
    const water = computeWater(w);
    // Every open interior floor cell (the 7×7 inside the walls) is water.
    for (let z = 1; z < N - 1; z++)
      for (let x = 1; x < N - 1; x++) expect(water[w.index(x, 1, z)]).toBe(1);
    // The walls and the world outside the basin stay dry.
    expect(water[w.index(0, 1, 0)]).toBe(0);
  });

  // GOLDEN (waterfall): a source up high floods straight down the open shaft and pools on
  // the floor. Pins downward flow and that the column does not stop short.
  test("golden: a source falls down a shaft and pools on the floor", () => {
    const w = new World(5, 6, 5);
    for (let z = 0; z < 5; z++) for (let x = 0; x < 5; x++) w.set(x, 0, z, Block.Stone); // floor
    w.set(2, 5, 2, Block.Water); // source at the top, open air below
    const water = computeWater(w);
    for (let y = 1; y <= 5; y++) expect(water[w.index(2, y, 2)]).toBe(1); // full column down
    // It reached the floor level and spread across the whole open floor (y = 1).
    for (let z = 0; z < 5; z++) for (let x = 0; x < 5; x++) expect(water[w.index(x, 1, z)]).toBe(1);
  });

  // INVARIANT (never rises): a source sealed under an opaque lid with open air ABOVE the
  // lid leaves the air above bone dry — water cannot climb out.
  test("invariant: water never climbs above a sealing lid", () => {
    const w = new World(3, 4, 3);
    for (let z = 0; z < 3; z++) for (let x = 0; x < 3; x++) w.set(x, 0, z, Block.Stone); // floor
    w.set(1, 1, 1, Block.Water); // source in the pit
    for (let z = 0; z < 3; z++) for (let x = 0; x < 3; x++) w.set(x, 2, z, Block.Stone); // lid
    const water = computeWater(w);
    for (let z = 0; z < 3; z++) for (let x = 0; x < 3; x++) expect(water[w.index(x, 3, z)]).toBe(0);
  });

  // METAMORPHIC (damming): replacing any cell with a solid block never ADDS water anywhere
  // — it can only remove a source or block a flood path. Pins that solids dam, never
  // create, water.
  test("metamorphic: adding a solid block never adds water anywhere", () => {
    fc.assert(
      fc.property(randomCells, fc.nat(124), (cells, k) => {
        const w = fill(cells);
        const before = computeWater(w);
        const x = k % 5,
          z = Math.floor(k / 5) % 5,
          y = Math.floor(k / 25);
        w.set(x, y, z, Block.Stone); // solid, never a source
        const after = computeWater(w);
        for (let i = 0; i < w.volume; i++) expect(after[i]).toBeLessThanOrEqual(before[i]);
      }),
      { numRuns: 300 },
    );
  });

  // GOLDEN (integration + determinism): flood over the real seeded 80×32×80 world. The
  // pinned hash is cross-checked against relaxWater (independent), and a second run is
  // identical. Re-pin only after re-deriving (relaxWater must still agree).
  test("golden: water over the seeded terrain is stable and matches relaxation", () => {
    const w = new World(80, 32, 80);
    generateTerrain(w, 20090513);
    const water = computeWater(w);
    let h = 0x811c9dc5;
    for (const v of water) {
      h ^= v;
      h = Math.imul(h, 0x01000193);
    }
    expect(Array.from(water)).toEqual(Array.from(relaxWater(w))); // independent cross-check
    expect(Array.from(computeWater(w))).toEqual(Array.from(water)); // determinism
    expect((h >>> 0).toString(16)).toBe("646e5398");
  });
});
