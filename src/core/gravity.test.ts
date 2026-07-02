import { describe, test, expect } from "vitest";
import fc from "fast-check";
import { World } from "./world";
import { Block } from "./blocks";
import { settle, isFalling } from "./gravity";

/**
 * `settle` drops loose blocks (Sand/Gravel) straight down onto support. Silent failures here
 * would make a block vanish, duplicate, float, or drift into another column. The oracles pin it
 * with a per-id CONSERVATION census, a NO-FLOATING invariant, PER-COLUMN conservation (straight
 * down ⇒ no sideways flow), IDEMPOTENCE, and COLUMN INDEPENDENCE (a differential that re-derives
 * the whole-world result by settling each column alone) — plus goldens for the concrete shapes.
 */

const SX = 4,
  SY = 6,
  SZ = 4;
// Palette: Air + the two loose blocks + fixed blocks (solid Stone, non-solid Water source).
// Water is included so "loose block rests on a non-Air support" covers a non-solid support too.
const PALETTE = [Block.Air, Block.Air, Block.Sand, Block.Gravel, Block.Stone, Block.Water];
const randomCells = fc.array(fc.constantFrom(...PALETTE), {
  minLength: SX * SY * SZ,
  maxLength: SX * SY * SZ,
});
const fill = (cells: number[]): World => {
  const w = new World(SX, SY, SZ);
  cells.forEach((b, i) => (w.data[i] = b));
  return w;
};

// Independent per-id histogram of a world's blocks.
function histogram(w: World): Map<number, number> {
  const h = new Map<number, number>();
  for (const b of w.data) h.set(b, (h.get(b) ?? 0) + 1);
  return h;
}
const eq = (a: Map<number, number>, b: Map<number, number>) => {
  expect(new Set(a.keys())).toEqual(new Set(b.keys()));
  for (const [k, v] of a) expect(b.get(k)).toBe(v);
};

describe("gravity.settle oracle", () => {
  // CONSERVATION CENSUS (headline): settling moves blocks, never creates or destroys them —
  // the per-id multiset over the whole world is identical before and after. Kills any mutation
  // that drops, duplicates, or transmutes a block.
  test("conserves the exact per-id block multiset", () => {
    fc.assert(
      fc.property(randomCells, (cells) => {
        const w = fill(cells);
        eq(histogram(w), histogram(settle(w)));
      }),
    );
  });

  // NO-FLOATING INVARIANT: after settling, every loose block rests on support — the cell
  // directly below is non-Air, or it sits on the world floor (y=0).
  test("no loose block floats: each has non-Air below (or is at y=0)", () => {
    fc.assert(
      fc.property(randomCells, (cells) => {
        const out = settle(fill(cells));
        for (let y = 0; y < SY; y++)
          for (let z = 0; z < SZ; z++)
            for (let x = 0; x < SX; x++) {
              if (isFalling(out.get(x, y, z))) {
                expect(y === 0 || out.get(x, y - 1, z) !== Block.Air).toBe(true);
              }
            }
      }),
    );
  });

  // PER-COLUMN CONSERVATION: loose blocks fall straight down, so each column keeps its own
  // loose-block multiset — a mutation that shifts a block sideways changes some column's count.
  test("each column keeps its own Sand/Gravel counts (no sideways flow)", () => {
    fc.assert(
      fc.property(randomCells, (cells) => {
        const w = fill(cells);
        const out = settle(w);
        for (let z = 0; z < SZ; z++)
          for (let x = 0; x < SX; x++) {
            const count = (ww: World, id: number) => {
              let n = 0;
              for (let y = 0; y < SY; y++) if (ww.get(x, y, z) === id) n++;
              return n;
            };
            expect(count(out, Block.Sand)).toBe(count(w, Block.Sand));
            expect(count(out, Block.Gravel)).toBe(count(w, Block.Gravel));
          }
      }),
    );
  });

  // FIXED BLOCKS UNMOVED: only Sand/Gravel move — every other block keeps its exact position.
  test("non-loose blocks stay exactly where they were", () => {
    fc.assert(
      fc.property(randomCells, (cells) => {
        const w = fill(cells);
        const out = settle(w);
        for (let y = 0; y < SY; y++)
          for (let z = 0; z < SZ; z++)
            for (let x = 0; x < SX; x++) {
              const id = w.get(x, y, z);
              if (id !== Block.Air && !isFalling(id)) expect(out.get(x, y, z)).toBe(id);
            }
      }),
    );
  });

  // IDEMPOTENT FIXPOINT: a settled world is already at rest — settling again changes nothing.
  test("settle is idempotent", () => {
    fc.assert(
      fc.property(randomCells, (cells) => {
        const once = settle(fill(cells));
        const twice = settle(once);
        expect(Array.from(twice.data)).toEqual(Array.from(once.data));
      }),
    );
  });

  // COLUMN INDEPENDENCE (differential): straight-down means a cell's fate depends only on its
  // own column. Re-derive the whole-world result by settling each column in a 1×SY×1 world and
  // stitching them back — it must match settle(world) cell-for-cell.
  test("settling the whole world == settling each column alone", () => {
    fc.assert(
      fc.property(randomCells, (cells) => {
        const w = fill(cells);
        const whole = settle(w);
        for (let z = 0; z < SZ; z++)
          for (let x = 0; x < SX; x++) {
            const col = new World(1, SY, 1);
            for (let y = 0; y < SY; y++) col.data[y] = w.get(x, y, z);
            const settledCol = settle(col);
            for (let y = 0; y < SY; y++) {
              expect(whole.get(x, y, z)).toBe(settledCol.get(0, y, 0));
            }
          }
      }),
    );
  });

  // GOLDEN: a floating grain drops to the exact resting height; a stack piles bottom-up; a
  // grain rests on a mid-column support. Concrete shapes a bulk census can't pin precisely.
  test("golden: drop distances and piling", () => {
    // A lone Sand at y=5 over an empty column with a Stone floor at y=0 → rests at y=1.
    const a = new World(1, 6, 1);
    a.data[0] = Block.Stone; // y=0 floor
    a.set(0, 5, 0, Block.Sand);
    const ra = settle(a);
    expect(ra.get(0, 1, 0)).toBe(Block.Sand);
    for (let y = 2; y < 6; y++) expect(ra.get(0, y, 0)).toBe(Block.Air);

    // Two loose blocks fall onto a mid-column Stone ledge at y=2 and pile at y=3,4 (order kept).
    const b = new World(1, 6, 1);
    b.set(0, 2, 0, Block.Stone);
    b.set(0, 4, 0, Block.Gravel); // lower loose block
    b.set(0, 5, 0, Block.Sand); // upper loose block
    const rb = settle(b);
    expect(rb.get(0, 2, 0)).toBe(Block.Stone); // ledge unmoved
    expect(rb.get(0, 3, 0)).toBe(Block.Gravel); // piled bottom-up, order preserved
    expect(rb.get(0, 4, 0)).toBe(Block.Sand);
    expect(rb.get(0, 5, 0)).toBe(Block.Air);
  });

  // A loose block already resting on the floor doesn't move (guards an off-by-one that would
  // sink it out of the world or lift it).
  test("golden: a grain on the floor stays on the floor", () => {
    const w = new World(1, 4, 1);
    w.set(0, 0, 0, Block.Sand);
    const r = settle(w);
    expect(r.get(0, 0, 0)).toBe(Block.Sand);
    for (let y = 1; y < 4; y++) expect(r.get(0, y, 0)).toBe(Block.Air);
  });

  test("isFalling: exactly Sand and Gravel", () => {
    expect(isFalling(Block.Sand)).toBe(true);
    expect(isFalling(Block.Gravel)).toBe(true);
    for (const id of Object.values(Block))
      if (id !== Block.Sand && id !== Block.Gravel) expect(isFalling(id)).toBe(false);
  });
});
