import { describe, test, expect } from "vitest";
import fc from "fast-check";
import { World } from "./world";
import { Block, isSolid } from "./blocks";
import { generateTerrain } from "./terrain";
import { computeWater, updateWater, MAX_WATER } from "./water";

/**
 * Water flow is the least fixpoint of a monotone CA. These oracles re-derive it
 * INDEPENDENTLY of the BFS in water.ts (the fixpoint condition itself, a relaxation),
 * pin the "no water from nowhere" reachability invariant and the damming behaviour
 * metamorphically, and freeze a golden — so a wrong decay, a missed fall, water
 * flowing up, or water leaking through a wall all disagree with at least one oracle.
 */

const HORIZONTAL = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
] as const;

/**
 * The flow operator F applied at one cell, stated straight from the rules and
 * INDEPENDENT of water.ts: a solid cell holds nothing; otherwise it is at least its
 * source level (MAX for a water block), full if the cell above holds water (falling),
 * and at least one less than its brightest horizontal neighbour (spreading).
 */
function flowAt(w: World, water: Uint8Array, x: number, y: number, z: number): number {
  if (isSolid(w.get(x, y, z))) return 0;
  let v = w.get(x, y, z) === Block.Water ? MAX_WATER : 0;
  if (w.inBounds(x, y + 1, z) && water[w.index(x, y + 1, z)] > 0) v = Math.max(v, MAX_WATER);
  for (const [dx, dz] of HORIZONTAL) {
    if (!w.inBounds(x + dx, y, z + dz)) continue;
    v = Math.max(v, water[w.index(x + dx, y, z + dz)] - 1);
  }
  return v;
}

/**
 * INDEPENDENT re-derivation: relax to the same least fixpoint by repeated full sweeps
 * (Gauss–Seidel), a different mechanism from water.ts's BFS queue. Each cell rises to
 * `flowAt` until nothing changes.
 */
function relaxWater(w: World): Uint8Array {
  const W = new Uint8Array(w.volume);
  let changed = true;
  while (changed) {
    changed = false;
    for (let y = 0; y < w.sizeY; y++)
      for (let z = 0; z < w.sizeZ; z++)
        for (let x = 0; x < w.sizeX; x++) {
          const v = flowAt(w, W, x, y, z);
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

describe("water-flow oracle", () => {
  // FIXPOINT (headline): the computed field is a FIXED POINT of the flow rule — applying
  // F to every cell reproduces it exactly. Re-derived from the rules (flowAt), so a wrong
  // decay/fall/spread leaves some cell unsettled and this disagrees.
  test("fixpoint: applying the flow rule to the result changes nothing", () => {
    fc.assert(
      fc.property(randomCells, (cells) => {
        const w = fill(cells);
        const water = computeWater(w);
        for (let y = 0; y < 5; y++)
          for (let z = 0; z < 5; z++)
            for (let x = 0; x < 5; x++)
              expect(water[w.index(x, y, z)]).toBe(flowAt(w, water, x, y, z));
      }),
      { numRuns: 300 },
    );
  });

  // RE-DERIVATION: the BFS field equals an independent Gauss–Seidel relaxation to the
  // same least fixpoint, cell for cell, over random worlds.
  test("re-derivation: BFS water equals an independent relaxation", () => {
    fc.assert(
      fc.property(randomCells, (cells) => {
        const w = fill(cells);
        expect(Array.from(computeWater(w))).toEqual(Array.from(relaxWater(w)));
      }),
      { numRuns: 300 },
    );
  });

  // INVARIANTS: bounds; solid cells hold no water; water blocks are full sources; and
  // reachability — every non-source watered cell has an INFLOW witness (water directly
  // above it, or a horizontal neighbour exactly one level higher). Water never appears
  // from nowhere and never flows up out of nothing.
  test("invariants: bounds, solids dry, sources full, and every drop has an inflow", () => {
    fc.assert(
      fc.property(randomCells, (cells) => {
        const w = fill(cells);
        const water = computeWater(w);
        for (let y = 0; y < 5; y++)
          for (let z = 0; z < 5; z++)
            for (let x = 0; x < 5; x++) {
              const v = water[w.index(x, y, z)];
              expect(v).toBeGreaterThanOrEqual(0);
              expect(v).toBeLessThanOrEqual(MAX_WATER);
              const id = w.get(x, y, z);
              if (isSolid(id)) expect(v).toBe(0);
              if (id === Block.Water) expect(v).toBe(MAX_WATER);
              if (v > 0 && id !== Block.Water) {
                const above = w.inBounds(x, y + 1, z) ? water[w.index(x, y + 1, z)] : 0;
                let witness = above > 0; // falling inflow
                for (const [dx, dz] of HORIZONTAL) {
                  if (!w.inBounds(x + dx, y, z + dz)) continue;
                  if (water[w.index(x + dx, y, z + dz)] === v + 1) witness = true; // spread inflow
                }
                expect(witness).toBe(true);
              }
            }
      }),
      { numRuns: 300 },
    );
  });

  // GOLDEN / CLOSED FORM: a single source on a floor spreads symmetrically by exactly
  // Chebyshev... no — by horizontal step count. On an open floor the source is MAX and
  // each ring out is one less, to MAX_WATER cells away. Pins the decay independently.
  test("golden: a lone source on a floor decays by horizontal distance", () => {
    const n = 2 * MAX_WATER + 3;
    const w = new World(n, 3, n);
    const cx = MAX_WATER + 1,
      cz = MAX_WATER + 1;
    for (let z = 0; z < n; z++) for (let x = 0; x < n; x++) w.set(x, 0, z, Block.Stone); // floor
    w.set(cx, 1, cz, Block.Water); // one source sitting on the floor
    const water = computeWater(w);
    for (let z = 0; z < n; z++)
      for (let x = 0; x < n; x++) {
        // BFS distance on the open floor is the L1 (Manhattan) distance here.
        const d = Math.abs(x - cx) + Math.abs(z - cz);
        expect(water[w.index(x, 1, z)]).toBe(Math.max(0, MAX_WATER - d));
      }
  });

  // GOLDEN: a waterfall — a source up high falls down a shaft. Pins falling (the column
  // stays full all the way down) and horizontal decay at the SOURCE level, where there is
  // nothing above to refill by falling. (Lower down, sideways spread itself falls and
  // floods the floor to full — correct CA behaviour, so we assert the clean top level.)
  test("golden: a falling column stays full while the source level decays by 1", () => {
    const w = new World(7, 6, 7);
    for (let z = 0; z < 7; z++) for (let x = 0; x < 7; x++) w.set(x, 0, z, Block.Stone); // floor
    w.set(3, 5, 3, Block.Water); // source at the top, open air below
    const water = computeWater(w);
    for (let y = 1; y <= 5; y++) expect(water[w.index(3, y, 3)]).toBe(MAX_WATER); // full column
    // at the source level (y=5) nothing is above, so spread is pure horizontal decay
    expect(water[w.index(4, 5, 3)]).toBe(MAX_WATER - 1);
    expect(water[w.index(5, 5, 3)]).toBe(MAX_WATER - 2);
    expect(water[w.index(6, 5, 3)]).toBe(MAX_WATER - 3);
  });

  // METAMORPHIC (damming): replacing any cell with a solid block never RAISES water
  // anywhere — it can only remove a source or block a path. Pins that solids dam, never
  // create, water.
  test("metamorphic: adding a solid block never raises water anywhere", () => {
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

  // GOLDEN (integration + determinism): water over the real seeded 80×32×80 world. The
  // pinned hash is cross-checked against relaxWater below, and a second run is identical.
  // Re-pin only after re-deriving (relaxWater must still agree).
  test("golden: water over the seeded terrain is stable and matches relaxation", () => {
    const w = new World(80, 32, 80);
    generateTerrain(w, 20090513);
    const water = computeWater(w);
    let h = 0x811c9dc5;
    for (const v of water) {
      h ^= v;
      h = Math.imul(h, 0x01000193);
    }
    expect((h >>> 0).toString(16)).toBe("e01e9736");
    expect(Array.from(water)).toEqual(Array.from(relaxWater(w))); // independent cross-check
    expect(Array.from(computeWater(w))).toEqual(Array.from(water)); // determinism
  });
});

// The blocks an edit can swap to: open air, a solid dam, and a full source — the whole
// space that matters to flow (solidity and source-ness). Air covers the non-solid
// non-source case directly.
const editBlocks = [Block.Air, Block.Stone, Block.Water];
const cube = fc.array(fc.constantFrom(...editBlocks), { minLength: 125, maxLength: 125 });
// Invert world.index = x + 5*(z + 5*y): x fastest, then z, then y (y-major).
const decode5 = (idx: number): [number, number, number] => [
  idx % 5,
  Math.floor(idx / 25),
  Math.floor(idx / 5) % 5,
];

describe("incremental-water oracle", () => {
  // DIFFERENTIAL (headline): replaying a random sequence of block edits through
  // updateWater must leave the field byte-identical to a from-scratch computeWater —
  // after EVERY edit. Any missed case in the directional removal/add logic (a dried
  // column, a stale spread, an uncollected re-flood border) shows up as a mismatch.
  // This IS the empirical proof the incremental update equals the fixpoint.
  test("differential: incremental == from-scratch recompute, edit by edit", () => {
    fc.assert(
      fc.property(
        cube,
        fc.array(fc.tuple(fc.nat(124), fc.constantFrom(...editBlocks)), {
          minLength: 1,
          maxLength: 12,
        }),
        (initial, edits) => {
          const w = fill(initial);
          const water = computeWater(w);
          for (const [idx, nb] of edits) {
            const [x, y, z] = decode5(idx);
            w.data[idx] = nb; // apply the edit (== w.set within bounds)
            updateWater(w, water, x, y, z);
            expect(Array.from(water)).toEqual(Array.from(computeWater(w)));
          }
        },
      ),
      { numRuns: 300 },
    );
  });

  // CHANGED-SET CENSUS: the indices updateWater returns are EXACTLY the cells whose
  // level changed (vs a before-snapshot) — no stale omission (a missed cell ⇒ a
  // stale-rendered water chunk) and no spurious entry — and the list is duplicate-free.
  // This is what the renderer trusts to decide which chunks to remesh.
  test("census: the returned changed set is exactly the cells whose level changed", () => {
    fc.assert(
      fc.property(cube, fc.nat(124), fc.constantFrom(...editBlocks), (initial, idx, nb) => {
        const w = fill(initial);
        const water = computeWater(w);
        const before = Array.from(water);
        const [x, y, z] = decode5(idx);
        w.data[idx] = nb;
        const changed = updateWater(w, water, x, y, z);
        const actual = new Set<number>();
        for (let i = 0; i < water.length; i++) if (water[i] !== before[i]) actual.add(i);
        expect(new Set(changed)).toEqual(actual);
        expect(changed.length).toBe(new Set(changed).size); // no duplicates
      }),
      { numRuns: 400 },
    );
  });
});
