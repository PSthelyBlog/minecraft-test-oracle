import { describe, test, expect } from "vitest";
import fc from "fast-check";
import { World } from "./world";
import { Block, isSolid } from "./blocks";
import { computeWater } from "./water";
import { computeLava, LAVA_RANGE } from "./lava";

/**
 * Lava is a BOUNDED flood fill: a non-solid cell holds lava iff reachable from a
 * `Block.Lava` source by SIDEWAYS or DOWNWARD steps — never up — spending at most
 * `LAVA_RANGE` horizontal steps (down steps are free, the budget is carried). These
 * oracles re-derive that set INDEPENDENTLY of the BFS in lava.ts: a Gauss–Seidel
 * budget relaxation to the same max-fixpoint, a subset DIFFERENTIAL against
 * `computeWater` (bounded ⊆ unbounded, same never-up rule — water.ts shares no code
 * with lava.ts), an inflow-witness invariant, diamond/shaft goldens that pin the
 * exact range on both sides of the boundary, and a damming metamorphic — so lava
 * leaking through a wall, climbing, appearing from nowhere, over- or under-spreading,
 * or spending budget on a fall all disagree with at least one oracle.
 */

// The four horizontal neighbours (same y); lava also pours straight down, never up.
const HORIZONTAL = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
] as const;

/**
 * The budget operator at one cell, stated straight from the rule and INDEPENDENT of
 * lava.ts. Budgets encode remaining horizontal steps + 1 (0 = dry). A solid cell
 * holds nothing; a source holds the full budget; otherwise a cell takes the best of
 * the cell ABOVE it (poured down, free) and each HORIZONTAL neighbour minus one
 * (spread in sideways). The cell BELOW never feeds it — lava does not flow up.
 */
function budgetAt(w: World, B: Uint8Array, x: number, y: number, z: number): number {
  if (isSolid(w.get(x, y, z))) return 0;
  if (w.get(x, y, z) === Block.Lava) return LAVA_RANGE + 1;
  let v = 0;
  if (w.inBounds(x, y + 1, z)) v = Math.max(v, B[w.index(x, y + 1, z)]); // poured down, free
  for (const [dx, dz] of HORIZONTAL) {
    if (!w.inBounds(x + dx, y, z + dz)) continue;
    v = Math.max(v, B[w.index(x + dx, y, z + dz)] - 1); // spread sideways, costs 1
  }
  return v;
}

/**
 * INDEPENDENT re-derivation: relax the budget field to the same max-fixpoint by
 * repeated full sweeps (Gauss–Seidel), a different mechanism from lava.ts's BFS
 * queue, then project to presence (budget > 0).
 */
function relaxLava(w: World): Uint8Array {
  const B = new Uint8Array(w.volume);
  let changed = true;
  while (changed) {
    changed = false;
    for (let y = 0; y < w.sizeY; y++)
      for (let z = 0; z < w.sizeZ; z++)
        for (let x = 0; x < w.sizeX; x++) {
          const v = budgetAt(w, B, x, y, z);
          const i = w.index(x, y, z);
          if (v > B[i]) {
            B[i] = v;
            changed = true;
          }
        }
  }
  const lava = new Uint8Array(w.volume);
  for (let i = 0; i < w.volume; i++) lava[i] = B[i] > 0 ? 1 : 0;
  return lava;
}

// Random small worlds biased toward lava sources, walls, and open space. Water
// blocks are included so the two fluids' fields coexist (they may overlap on shared
// reachable air until the reaction issue resolves contact).
const randomCells = fc.array(
  fc.constantFrom(
    Block.Air,
    Block.Air, // bias toward open space so lava has room to flow
    Block.Stone, // solid wall / floor
    Block.Lava, // source
    Block.Water, // the other fluid (non-solid: lava may flood through it, and vice versa)
  ),
  { minLength: 125, maxLength: 125 },
);
const fill = (cells: number[]): World => {
  const w = new World(5, 5, 5);
  cells.forEach((b, i) => (w.data[i] = b));
  return w;
};

describe("lava-flood oracle", () => {
  // RE-DERIVATION (headline): the BFS field equals an independent Gauss–Seidel budget
  // relaxation to the same max-fixpoint, cell for cell, over random worlds. A wrong
  // direction, a missed neighbour, leaking through a wall, or any budget arithmetic
  // slip (charging a fall, refunding a sideways step) makes the two mechanisms disagree.
  test("re-derivation: BFS flood equals an independent budget relaxation", () => {
    fc.assert(
      fc.property(randomCells, (cells) => {
        const w = fill(cells);
        expect(Array.from(computeLava(w))).toEqual(Array.from(relaxLava(w)));
      }),
      { numRuns: 300 },
    );
  });

  // DIFFERENTIAL vs water.ts (independent module, shared-nothing): replacing every
  // lava source with a water source and flooding UNBOUNDED must cover the lava field —
  // bounded ⊆ unbounded under the same sideways/down/never-up rule. A lava cell water
  // can't reach means lava crossed a wall, climbed, or appeared from nowhere.
  test("differential: lava is a subset of water's unbounded flood from the same sources", () => {
    fc.assert(
      fc.property(randomCells, (cells) => {
        const w = fill(cells);
        const lava = computeLava(w);
        const w2 = new World(5, 5, 5);
        for (let i = 0; i < w.volume; i++)
          w2.data[i] = w.data[i] === Block.Lava ? Block.Water : w.data[i];
        const water = computeWater(w2);
        for (let i = 0; i < w.volume; i++) expect(lava[i]).toBeLessThanOrEqual(water[i]);
      }),
      { numRuns: 300 },
    );
  });

  // INVARIANTS: values are binary; solid cells hold no lava; lava blocks are molten;
  // and the INFLOW-WITNESS — every non-source lava cell has lava directly above it
  // (poured down) or a horizontal lava neighbour (spread in). Lava never appears from
  // nowhere and never rises: a cell whose only molten neighbour is BELOW it stays dry.
  test("invariants: binary, solids dry, sources molten, and every cell has a non-rising inflow", () => {
    fc.assert(
      fc.property(randomCells, (cells) => {
        const w = fill(cells);
        const lava = computeLava(w);
        for (let y = 0; y < 5; y++)
          for (let z = 0; z < 5; z++)
            for (let x = 0; x < 5; x++) {
              const v = lava[w.index(x, y, z)];
              expect(v === 0 || v === 1).toBe(true);
              const id = w.get(x, y, z);
              if (isSolid(id)) expect(v).toBe(0);
              if (id === Block.Lava) expect(v).toBe(1);
              if (v === 1 && id !== Block.Lava) {
                const above = w.inBounds(x, y + 1, z) && lava[w.index(x, y + 1, z)] === 1;
                let witness = above; // poured down from above
                for (const [dx, dz] of HORIZONTAL) {
                  if (!w.inBounds(x + dx, y, z + dz)) continue;
                  if (lava[w.index(x + dx, y, z + dz)] === 1) witness = true; // spread sideways
                }
                expect(witness).toBe(true);
              }
            }
      }),
      { numRuns: 300 },
    );
  });

  // GOLDEN (the bound, both sides): a source on an open flat floor spreads to exactly
  // the Manhattan-distance-≤ LAVA_RANGE diamond — molten at distance 3, dry at 4. This
  // is the one behaviour water CANNOT exhibit, so it pins boundedness itself; an
  // off-by-one budget (seed, decrement, or the ≥1 floor) moves the boundary and fails.
  test("golden: a source on a flat floor makes exactly the radius-3 diamond", () => {
    const N = 11;
    const w = new World(N, 3, N);
    for (let z = 0; z < N; z++) for (let x = 0; x < N; x++) w.set(x, 0, z, Block.Stone); // floor
    const c = 5;
    w.set(c, 1, c, Block.Lava); // one source mid-floor
    const lava = computeLava(w);
    let molten = 0;
    for (let z = 0; z < N; z++)
      for (let x = 0; x < N; x++) {
        const d = Math.abs(x - c) + Math.abs(z - c);
        expect(lava[w.index(x, 1, z)]).toBe(d <= LAVA_RANGE ? 1 : 0);
        if (d <= LAVA_RANGE) molten++;
      }
    expect(molten).toBe(25); // 1 + 4 + 8 + 12: the full diamond, nothing more
    // Nothing climbed to the layer above the source.
    for (let z = 0; z < N; z++) for (let x = 0; x < N; x++) expect(lava[w.index(x, 2, z)]).toBe(0);
  });

  // GOLDEN (down is free): a source pours down a deep 1×1 stone shaft — far deeper
  // than LAVA_RANGE — and still spreads its FULL radius-3 diamond in the basin at the
  // bottom. Charging budget for the fall (or resetting it) fails this together with
  // the diamond golden above.
  test("golden: a fall costs no budget — full spread after pouring down a deep shaft", () => {
    const N = 11;
    const H = 9;
    const w = new World(N, H, N);
    for (let z = 0; z < N; z++) for (let x = 0; x < N; x++) w.set(x, 0, z, Block.Stone); // floor
    const c = 5;
    // A stone shaft from y=2 to the top, hollow at (c, y, c), so nothing spreads mid-fall.
    for (let y = 2; y < H; y++)
      for (let dz = -1; dz <= 1; dz++)
        for (let dx = -1; dx <= 1; dx++)
          if (dx !== 0 || dz !== 0) w.set(c + dx, y, c + dz, Block.Stone);
    w.set(c, H - 1, c, Block.Lava); // source at the shaft mouth, 6 cells above the basin
    const lava = computeLava(w);
    for (let y = 1; y < H - 1; y++) expect(lava[w.index(c, y, c)]).toBe(1); // full column down
    for (let z = 0; z < N; z++)
      for (let x = 0; x < N; x++) {
        const d = Math.abs(x - c) + Math.abs(z - c);
        expect(lava[w.index(x, 1, z)]).toBe(d <= LAVA_RANGE ? 1 : 0); // undiminished diamond
      }
  });

  // INVARIANT (never rises): a source sealed under an opaque lid with open air ABOVE
  // the lid leaves the air above bone dry — lava cannot climb out.
  test("invariant: lava never climbs above a sealing lid", () => {
    const w = new World(3, 4, 3);
    for (let z = 0; z < 3; z++) for (let x = 0; x < 3; x++) w.set(x, 0, z, Block.Stone); // floor
    w.set(1, 1, 1, Block.Lava); // source in the pit
    for (let z = 0; z < 3; z++) for (let x = 0; x < 3; x++) w.set(x, 2, z, Block.Stone); // lid
    const lava = computeLava(w);
    for (let z = 0; z < 3; z++) for (let x = 0; x < 3; x++) expect(lava[w.index(x, 3, z)]).toBe(0);
  });

  // METAMORPHIC (damming): replacing any cell with a solid block never ADDS lava
  // anywhere — it can only remove a source or block a flow path. Pins that solids
  // dam, never create, lava.
  test("metamorphic: adding a solid block never adds lava anywhere", () => {
    fc.assert(
      fc.property(randomCells, fc.nat(124), (cells, k) => {
        const w = fill(cells);
        const before = computeLava(w);
        const x = k % 5,
          z = Math.floor(k / 5) % 5,
          y = Math.floor(k / 25);
        w.set(x, y, z, Block.Stone); // solid, never a source
        const after = computeLava(w);
        for (let i = 0; i < w.volume; i++) expect(after[i]).toBeLessThanOrEqual(before[i]);
      }),
      { numRuns: 300 },
    );
  });

  // DETERMINISM: recomputing over the same world is byte-identical (no hidden state,
  // no traversal-order dependence — the max-fixpoint is unique).
  test("determinism: recomputing the field is byte-identical", () => {
    fc.assert(
      fc.property(randomCells, (cells) => {
        const w = fill(cells);
        expect(Array.from(computeLava(w))).toEqual(Array.from(computeLava(w)));
      }),
      { numRuns: 100 },
    );
  });
});
