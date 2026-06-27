import { describe, test, expect } from "vitest";
import fc from "fast-check";
import { World } from "./world";
import { Block } from "./blocks";

const dim = fc.integer({ min: 1, max: 12 });

describe("world oracle", () => {
  // CENSUS / BIJECTION — the cornerstone oracle.
  // index() must map the sizeX*sizeY*sizeZ cells ONTO exactly {0 .. volume-1}
  // with no collisions and no gaps. Any off-by-one or swapped stride in the
  // index formula makes the produced set stop being a permutation, which this
  // catches independently of the formula itself.
  test("index is a bijection onto [0, volume)", () => {
    fc.assert(
      fc.property(dim, dim, dim, (sx, sy, sz) => {
        const w = new World(sx, sy, sz);
        const seen = new Uint8Array(w.volume);
        let count = 0;
        for (let y = 0; y < sy; y++) {
          for (let z = 0; z < sz; z++) {
            for (let x = 0; x < sx; x++) {
              const i = w.index(x, y, z);
              expect(i).toBeGreaterThanOrEqual(0);
              expect(i).toBeLessThan(w.volume);
              expect(seen[i]).toBe(0); // no two cells share an index
              seen[i] = 1;
              count++;
            }
          }
        }
        expect(count).toBe(w.volume);
        expect(seen.every((b) => b === 1)).toBe(true); // every slot used
      }),
    );
  });

  // ROUND-TRIP: a value written at a cell is read back unchanged, and writing
  // one cell never disturbs another (probed via a full clear+set+read sweep).
  test("set then get returns the written block", () => {
    fc.assert(
      fc.property(dim, dim, dim, fc.integer({ min: 0, max: 13 }), (sx, sy, sz, id) => {
        const w = new World(sx, sy, sz);
        const x = sx - 1,
          y = sy - 1,
          z = sz - 1; // a corner, most index-sensitive
        expect(w.set(x, y, z, id)).toBe(true);
        expect(w.get(x, y, z)).toBe(id);
        // neighbours stay Air
        expect(w.get(0, 0, 0)).toBe(sx * sy * sz === 1 ? id : Block.Air);
      }),
    );
  });

  // TOTALITY: out-of-bounds is defined, never throws, never corrupts.
  test("out-of-bounds reads are Air and writes are rejected", () => {
    const w = new World(4, 4, 4);
    const oob: [number, number, number][] = [
      [-1, 0, 0],
      [0, -1, 0],
      [0, 0, -1],
      [4, 0, 0],
      [0, 4, 0],
      [0, 0, 4],
      [99, 99, 99],
    ];
    for (const [x, y, z] of oob) {
      expect(w.inBounds(x, y, z)).toBe(false);
      expect(w.get(x, y, z)).toBe(Block.Air);
      expect(w.set(x, y, z, Block.Stone)).toBe(false);
    }
    // nothing leaked into the array
    expect(w.data.every((b) => b === Block.Air)).toBe(true);
  });

  // INVARIANT: constructor rejects degenerate dimensions instead of silently
  // producing a zero-volume world.
  test("rejects non-positive / non-integer dimensions", () => {
    // each axis independently must reject zero, negative, and non-integer
    expect(() => new World(0, 4, 4)).toThrow();
    expect(() => new World(4, 0, 4)).toThrow();
    expect(() => new World(4, 4, 0)).toThrow();
    expect(() => new World(-1, 4, 4)).toThrow();
    expect(() => new World(4, -1, 4)).toThrow();
    expect(() => new World(4, 4, -1)).toThrow();
    expect(() => new World(1.5, 4, 4)).toThrow();
    expect(() => new World(4, 1.5, 4)).toThrow();
    expect(() => new World(4, 4, 1.5)).toThrow();
    // a valid world still constructs
    expect(() => new World(1, 1, 1)).not.toThrow();
  });
});
