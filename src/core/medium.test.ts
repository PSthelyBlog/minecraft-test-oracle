import { describe, test, expect } from "vitest";
import fc from "fast-check";
import { World } from "./world";
import { Block } from "./blocks";
import { computeWater } from "./water";
import { submersion } from "./physics";
import type { Vec3 } from "./math";
import { Medium, MEDIA, mediumDef, mediumAt, mediumAtPoint } from "./medium";

/**
 * `medium.ts` names the medium an observer is immersed in (Air / Water / Solid) as a
 * total, disjoint partition derived from the world + its water field. Two silent
 * surfaces: the hand-authored `MEDIA` fog registry (a wrong constant renders the wrong
 * atmosphere with no error) and the `mediumAt` classifier (a swapped branch, a flipped
 * comparison, or a dropped bounds guard mislabels a cell). The oracles below pin the
 * registry as a golden and the classifier by an INDEPENDENT partition census plus a
 * DIFFERENTIAL against `physics.submersion` — a function that shares no code with it.
 */

// The blocks placed in the random worlds below, and their solidity, stated by INTENT
// (not read back from blocks.ts) so the medium classifier is checked against an
// independent notion of "solid". Glass/Leaves are the important cases: solid but NOT
// opaque, so they pin that `mediumAt` keys off `solid`, not `opaque`.
const SOLID_IDS = new Set<number>([Block.Stone, Block.Glass, Block.Leaves]);
const PALETTE = [
  Block.Air,
  Block.Air, // bias toward open space so water has room to flood
  Block.Stone, // solid + opaque
  Block.Water, // source
  Block.Glass, // solid, NOT opaque
  Block.Leaves, // solid, NOT opaque
];

const SIZE = 5;
const randomCells = fc.array(fc.constantFrom(...PALETTE), {
  minLength: SIZE ** 3,
  maxLength: SIZE ** 3,
});
const fill = (cells: number[]): World => {
  const w = new World(SIZE, SIZE, SIZE);
  cells.forEach((b, i) => (w.data[i] = b));
  return w;
};

/**
 * INDEPENDENT re-derivation of the medium at a cell. Different structure from the source
 * (an explicit solid set, no `isSolid` call), so a mutated branch/precedence disagrees.
 */
function expectedMedium(world: World, water: Uint8Array, x: number, y: number, z: number): number {
  if (x < 0 || y < 0 || z < 0 || x >= world.sizeX || y >= world.sizeY || z >= world.sizeZ) {
    return Medium.Air; // out of bounds is open sky
  }
  if (water[world.index(x, y, z)] === 1) return Medium.Water; // flooded beats everything
  if (SOLID_IDS.has(world.get(x, y, z))) return Medium.Solid;
  return Medium.Air;
}

describe("medium registry (MEDIA)", () => {
  // GOLDEN / census: the whole registry, frozen by intent. A single flipped fog value or
  // multiplier drifts loudly. (MEDIA is a load-time constant → Stryker reports its mutants
  // as `static`/ignored, exactly like blocks.ts; falsifiability is proven by this golden.)
  const SKY: readonly [number, number, number] = [0x8f / 255, 0xbc / 255, 0xff / 255];
  const FROZEN: Record<
    number,
    { name: string; fog: readonly number[]; near: number; far: number; mult: number }
  > = {
    [Medium.Air]: { name: "Air", fog: SKY, near: 40, far: 110, mult: 1 },
    [Medium.Water]: { name: "Water", fog: [0.15, 0.3, 0.62], near: 0.1, far: 18, mult: 0.75 },
    [Medium.Solid]: { name: "Solid", fog: SKY, near: 40, far: 110, mult: 1 },
  };

  test("registry matches the frozen contract, exactly and totally", () => {
    // the registry defines exactly the known media — no more, no fewer
    expect(new Set(Object.keys(MEDIA).map(Number))).toEqual(new Set(Object.values(Medium)));
    for (const id of Object.values(Medium)) {
      const want = FROZEN[id];
      const def = MEDIA[id];
      expect(def.id).toBe(id);
      expect(def.name).toBe(want.name);
      expect(Array.from(def.fogColor)).toEqual(Array.from(want.fog));
      expect(def.fogNear).toBe(want.near);
      expect(def.fogFar).toBe(want.far);
      expect(def.lightMultiplier).toBe(want.mult);
    }
  });

  // STRICT EXTENSION: Air must reproduce today's atmosphere (main.ts `Fog(SKY, 40, 110)`,
  // no dimming) so above-water rendering is byte-identical after this change.
  test("Air is exactly today's sky fog — a strict, no-op extension above water", () => {
    const air = MEDIA[Medium.Air];
    expect(Array.from(air.fogColor)).toEqual([0x8f / 255, 0xbc / 255, 0xff / 255]);
    expect([air.fogNear, air.fogFar, air.lightMultiplier]).toEqual([40, 110, 1]);
  });

  // Water must actually change the atmosphere, or the whole feature is a no-op.
  test("Water pulls fog in and dims — distinct from Air", () => {
    const air = MEDIA[Medium.Air];
    const water = MEDIA[Medium.Water];
    expect(water.fogFar).toBeLessThan(air.fogFar); // fog closes in underwater
    expect(water.lightMultiplier).toBeLessThan(1); // and dims
    expect(Array.from(water.fogColor)).not.toEqual(Array.from(air.fogColor));
  });

  // mediumDef falls back to Air for an unknown id (never returns undefined).
  test("mediumDef is total: unknown id falls back to Air", () => {
    expect(mediumDef(999)).toBe(MEDIA[Medium.Air]);
    for (const id of Object.values(Medium)) expect(mediumDef(id)).toBe(MEDIA[id]);
  });
});

describe("mediumAt classifier", () => {
  // PARTITION CENSUS (headline): over random worlds + their real flood field, every cell —
  // in bounds AND one ring out of bounds — classifies to exactly the independently-derived
  // medium. Kills any swapped branch, flipped comparison, or dropped OOB guard.
  test("every cell matches the independent 3-way partition", () => {
    fc.assert(
      fc.property(randomCells, (cells) => {
        const w = fill(cells);
        const water = computeWater(w);
        for (let y = -1; y <= SIZE; y++)
          for (let z = -1; z <= SIZE; z++)
            for (let x = -1; x <= SIZE; x++) {
              expect(mediumAt(w, water, x, y, z)).toBe(expectedMedium(w, water, x, y, z));
            }
      }),
    );
  });

  // DISJOINTNESS invariant: Water and Solid never coincide (the flood never waters a solid
  // cell), so the partition is genuine. Checked against computeWater, independent of the
  // classifier's Water-before-Solid precedence.
  test("no cell is both Water and Solid", () => {
    fc.assert(
      fc.property(randomCells, (cells) => {
        const w = fill(cells);
        const water = computeWater(w);
        for (let y = 0; y < SIZE; y++)
          for (let z = 0; z < SIZE; z++)
            for (let x = 0; x < SIZE; x++) {
              const wet = water[w.index(x, y, z)] === 1;
              const solid = SOLID_IDS.has(w.get(x, y, z));
              expect(wet && solid).toBe(false);
              // and the classifier honours that: a watered cell is Water, a dry solid is Solid
              if (wet) expect(mediumAt(w, water, x, y, z)).toBe(Medium.Water);
              else if (solid) expect(mediumAt(w, water, x, y, z)).toBe(Medium.Solid);
            }
      }),
    );
  });

  // DIFFERENTIAL vs physics.submersion: the player box is wet (submersion > 0) IFF at least
  // one cell it overlaps is classified Water. submersion re-derives wetness by clipped-volume
  // overlap; mediumAt by a single lookup — no shared code — so a bug in either disagrees.
  const box = fc.record({
    center: fc.tuple(
      fc.double({ min: -1, max: SIZE + 1, noNaN: true }),
      fc.double({ min: -1, max: SIZE + 1, noNaN: true }),
      fc.double({ min: -1, max: SIZE + 1, noNaN: true }),
    ),
    half: fc.tuple(
      fc.double({ min: 0.1, max: 1.5, noNaN: true }),
      fc.double({ min: 0.1, max: 1.5, noNaN: true }),
      fc.double({ min: 0.1, max: 1.5, noNaN: true }),
    ),
  });
  test("submersion > 0 iff the box overlaps a Water cell", () => {
    fc.assert(
      fc.property(randomCells, box, (cells, { center, half }) => {
        const w = fill(cells);
        const water = computeWater(w);
        const c = center as Vec3;
        const h = half as Vec3;
        const wet = submersion(w, water, c, h) > 0;
        // Independent existence check over exactly the cells the box overlaps.
        let overlapsWater = false;
        for (let y = Math.floor(c[1] - h[1]); y < Math.ceil(c[1] + h[1]); y++)
          for (let z = Math.floor(c[2] - h[2]); z < Math.ceil(c[2] + h[2]); z++)
            for (let x = Math.floor(c[0] - h[0]); x < Math.ceil(c[0] + h[0]); x++)
              if (mediumAt(w, water, x, y, z) === Medium.Water) overlapsWater = true;
        expect(wet).toBe(overlapsWater);
      }),
    );
  });
});

describe("mediumAtPoint", () => {
  // A point floors to its containing cell: [x, x+1) belongs to cell x. Golden cases pin the
  // convention (a swapped floor/round would move the boundary).
  test("floors the point to its containing cell", () => {
    const w = new World(3, 3, 3);
    for (let z = 0; z < 3; z++) for (let x = 0; x < 3; x++) w.set(x, 0, z, Block.Stone); // floor
    w.set(1, 1, 1, Block.Water); // one source, enclosed enough to stay put
    const water = computeWater(w);

    // dead centre of the water cell → Water
    expect(mediumAtPoint(w, water, [1.5, 1.5, 1.5])).toBe(Medium.Water);
    // exactly on the lower boundary belongs to the higher cell (cell 1) → still Water
    expect(mediumAtPoint(w, water, [1, 1, 1])).toBe(Medium.Water);
    // just below the boundary is cell (…,0,…), the Stone floor → Solid
    expect(mediumAtPoint(w, water, [1.5, 0.99, 1.5])).toBe(Medium.Solid);
    // open air above → Air
    expect(mediumAtPoint(w, water, [1.5, 2.5, 1.5])).toBe(Medium.Air);
    // outside the world → Air (open sky)
    expect(mediumAtPoint(w, water, [-0.5, 1.5, 1.5])).toBe(Medium.Air);
  });
});
