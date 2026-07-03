import { describe, test, expect } from "vitest";
import fc from "fast-check";
import { World } from "./world";
import { Block } from "./blocks";
import { computeWater } from "./water";
import { computeLava } from "./lava";
import { submersion } from "./physics";
import type { Vec3 } from "./math";
import { Medium, MEDIA, mediumDef, mediumAt, mediumAtPoint } from "./medium";

/**
 * `medium.ts` names the medium an observer is immersed in (Air / Water / Lava / Solid)
 * as a total, disjoint partition derived from the world + its two fluid fields. Two
 * silent surfaces: the hand-authored `MEDIA` fog registry (a wrong constant renders the
 * wrong atmosphere with no error) and the `mediumAt` classifier (a swapped branch, a
 * flipped comparison, a wrong overlap precedence, or a dropped bounds guard mislabels a
 * cell). The oracles below pin the registry as a golden and the classifier by an
 * INDEPENDENT partition census, a DIFFERENTIAL against `physics.submersion` (which
 * shares no code with it), and explicit overlap-precedence cases.
 */

// The blocks placed in the random worlds below, and their solidity, stated by INTENT
// (not read back from blocks.ts) so the medium classifier is checked against an
// independent notion of "solid". Glass/Leaves are the important cases: solid but NOT
// opaque, so they pin that `mediumAt` keys off `solid`, not `opaque`.
const SOLID_IDS = new Set<number>([Block.Stone, Block.Glass, Block.Leaves]);
const PALETTE = [
  Block.Air,
  Block.Air, // bias toward open space so the fluids have room to flood
  Block.Stone, // solid + opaque
  Block.Water, // water source
  Block.Lava, // lava source (non-solid, like water)
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
const noLava = (w: World): Uint8Array => new Uint8Array(w.volume);

/**
 * INDEPENDENT re-derivation of the medium at a cell. Different structure from the source
 * (an explicit solid set, no `isSolid` call), so a mutated branch/precedence disagrees.
 * Precedence: Lava beats Water (the fluids may overlap until the reaction lands — the
 * louder signal wins); either fluid beats Solid (the floods never enter solids anyway).
 */
function expectedMedium(
  world: World,
  water: Uint8Array,
  lava: Uint8Array,
  x: number,
  y: number,
  z: number,
): number {
  if (x < 0 || y < 0 || z < 0 || x >= world.sizeX || y >= world.sizeY || z >= world.sizeZ) {
    return Medium.Air; // out of bounds is open sky
  }
  if (lava[world.index(x, y, z)] === 1) return Medium.Lava; // molten beats everything
  if (water[world.index(x, y, z)] === 1) return Medium.Water;
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
    [Medium.Lava]: {
      name: "Lava",
      fog: [207 / 255, 80 / 255, 16 / 255],
      near: 0.05,
      far: 4,
      mult: 0.6,
    },
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

  // Lava must be harsher than water — molten, nearly opaque, dimmer — or the new medium
  // reads as recoloured water.
  test("Lava is harsher than Water: closer fog, stronger dim, warm not blue", () => {
    const water = MEDIA[Medium.Water];
    const lava = MEDIA[Medium.Lava];
    expect(lava.fogFar).toBeLessThan(water.fogFar); // barely see past your hands
    expect(lava.fogNear).toBeLessThanOrEqual(water.fogNear);
    expect(lava.lightMultiplier).toBeLessThan(water.lightMultiplier);
    const [r, g, b] = lava.fogColor;
    expect(r).toBeGreaterThan(g); // warm ordering — molten orange,
    expect(g).toBeGreaterThan(b); // not a blue like water's
  });

  // mediumDef falls back to Air for an unknown id (never returns undefined).
  test("mediumDef is total: unknown id falls back to Air", () => {
    expect(mediumDef(999)).toBe(MEDIA[Medium.Air]);
    for (const id of Object.values(Medium)) expect(mediumDef(id)).toBe(MEDIA[id]);
  });
});

describe("mediumAt classifier", () => {
  // PARTITION CENSUS (headline): over random worlds + their real flood fields, every cell —
  // in bounds AND one ring out of bounds — classifies to exactly the independently-derived
  // medium. Kills any swapped branch, flipped comparison, wrong precedence, or dropped OOB
  // guard.
  test("every cell matches the independent 4-way partition", () => {
    fc.assert(
      fc.property(randomCells, (cells) => {
        const w = fill(cells);
        const water = computeWater(w);
        const lava = computeLava(w);
        for (let y = -1; y <= SIZE; y++)
          for (let z = -1; z <= SIZE; z++)
            for (let x = -1; x <= SIZE; x++) {
              expect(mediumAt(w, water, lava, x, y, z)).toBe(
                expectedMedium(w, water, lava, x, y, z),
              );
            }
      }),
    );
  });

  // STRICT EXTENSION: with an all-dry lava field, the classifier is byte-identical to the
  // v0.6 three-way semantics (water → solid → air), over random worlds including ones that
  // contain Lava blocks (a Lava block under a dry field is non-solid → Air, like any fluid
  // source outside its field).
  test("strict extension: an all-dry lava field reproduces the 3-way classifier", () => {
    fc.assert(
      fc.property(randomCells, (cells) => {
        const w = fill(cells);
        const water = computeWater(w);
        const dry = noLava(w);
        for (let y = 0; y < SIZE; y++)
          for (let z = 0; z < SIZE; z++)
            for (let x = 0; x < SIZE; x++) {
              // the v0.6 rule, restated: water, else solid, else air
              const old =
                water[w.index(x, y, z)] === 1
                  ? Medium.Water
                  : SOLID_IDS.has(w.get(x, y, z))
                    ? Medium.Solid
                    : Medium.Air;
              expect(mediumAt(w, water, dry, x, y, z)).toBe(old);
            }
      }),
    );
  });

  // PRECEDENCE (the #116 design call, pinned): where the two fluids overlap, Lava wins.
  // Synthetic fields pin the branch order directly; a real overlapping flood pins it
  // end-to-end (water's unbounded flood covers lava's bounded tongue near a lava source
  // when both spill into the same basin).
  test("precedence: a cell flooded by both fluids is Lava", () => {
    const w = new World(3, 3, 3);
    const both = new Uint8Array(w.volume);
    both[w.index(1, 1, 1)] = 1;
    expect(mediumAt(w, both, both, 1, 1, 1)).toBe(Medium.Lava); // synthetic: both set → Lava

    // End-to-end: one open basin, a water source and a lava source both flooding it.
    const basin = new World(7, 3, 7);
    for (let z = 0; z < 7; z++) for (let x = 0; x < 7; x++) basin.set(x, 0, z, Block.Stone);
    basin.set(0, 1, 0, Block.Water); // water floods the whole floor (unbounded)
    basin.set(3, 1, 3, Block.Lava); // lava tongue floods its radius-3 diamond
    const water = computeWater(basin);
    const lava = computeLava(basin);
    const overlap = basin.index(4, 1, 3); // inside both floods
    expect(water[overlap]).toBe(1);
    expect(lava[overlap]).toBe(1);
    expect(mediumAt(basin, water, lava, 4, 1, 3)).toBe(Medium.Lava); // lava wins
    expect(mediumAt(basin, water, lava, 6, 1, 6)).toBe(Medium.Water); // water-only stays Water
  });

  // DIFFERENTIAL vs computeLava: a cell classifies Lava iff the field marks it — re-derived
  // from the field itself, independent of the classifier's branch structure.
  test("Lava iff the lava field marks the cell", () => {
    fc.assert(
      fc.property(randomCells, (cells) => {
        const w = fill(cells);
        const water = computeWater(w);
        const lava = computeLava(w);
        for (let y = 0; y < SIZE; y++)
          for (let z = 0; z < SIZE; z++)
            for (let x = 0; x < SIZE; x++) {
              const isLava = mediumAt(w, water, lava, x, y, z) === Medium.Lava;
              expect(isLava).toBe(lava[w.index(x, y, z)] === 1);
            }
      }),
    );
  });

  // DISJOINTNESS invariant: neither fluid ever coincides with Solid (the floods never
  // enter a solid cell), so the partition is genuine. Checked against the fields,
  // independent of the classifier's precedence.
  test("no cell is both fluid and Solid", () => {
    fc.assert(
      fc.property(randomCells, (cells) => {
        const w = fill(cells);
        const water = computeWater(w);
        const lava = computeLava(w);
        for (let y = 0; y < SIZE; y++)
          for (let z = 0; z < SIZE; z++)
            for (let x = 0; x < SIZE; x++) {
              const i = w.index(x, y, z);
              const wet = water[i] === 1;
              const molten = lava[i] === 1;
              const solid = SOLID_IDS.has(w.get(x, y, z));
              expect((wet || molten) && solid).toBe(false);
              // and the classifier honours the fields: molten → Lava; wet non-molten →
              // Water; dry solid → Solid
              if (molten) expect(mediumAt(w, water, lava, x, y, z)).toBe(Medium.Lava);
              else if (wet) expect(mediumAt(w, water, lava, x, y, z)).toBe(Medium.Water);
              else if (solid) expect(mediumAt(w, water, lava, x, y, z)).toBe(Medium.Solid);
            }
      }),
    );
  });

  // DIFFERENTIAL vs physics.submersion: the player box is wet (submersion > 0) IFF at least
  // one cell it overlaps is water-flooded. submersion re-derives wetness by clipped-volume
  // overlap of the WATER field alone; run the classifier with a dry lava field so Water
  // classification coincides with the field (lava precedence would otherwise mask
  // overlapped cells).
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
        const dry = noLava(w);
        const c = center as Vec3;
        const h = half as Vec3;
        const wet = submersion(w, water, c, h) > 0;
        // Independent existence check over exactly the cells the box overlaps.
        let overlapsWater = false;
        for (let y = Math.floor(c[1] - h[1]); y < Math.ceil(c[1] + h[1]); y++)
          for (let z = Math.floor(c[2] - h[2]); z < Math.ceil(c[2] + h[2]); z++)
            for (let x = Math.floor(c[0] - h[0]); x < Math.ceil(c[0] + h[0]); x++)
              if (mediumAt(w, water, dry, x, y, z) === Medium.Water) overlapsWater = true;
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
    const dry = noLava(w);

    // dead centre of the water cell → Water
    expect(mediumAtPoint(w, water, dry, [1.5, 1.5, 1.5])).toBe(Medium.Water);
    // exactly on the lower boundary belongs to the higher cell (cell 1) → still Water
    expect(mediumAtPoint(w, water, dry, [1, 1, 1])).toBe(Medium.Water);
    // just below the boundary is cell (…,0,…), the Stone floor → Solid
    expect(mediumAtPoint(w, water, dry, [1.5, 0.99, 1.5])).toBe(Medium.Solid);
    // open air above → Air
    expect(mediumAtPoint(w, water, dry, [1.5, 2.5, 1.5])).toBe(Medium.Air);
    // outside the world → Air (open sky)
    expect(mediumAtPoint(w, water, dry, [-0.5, 1.5, 1.5])).toBe(Medium.Air);
  });

  // The eye dipping into a lava tongue reads Lava — the fact updateAtmosphere keys off.
  test("a point inside a flooded lava cell reads Lava", () => {
    const w = new World(5, 3, 5);
    for (let z = 0; z < 5; z++) for (let x = 0; x < 5; x++) w.set(x, 0, z, Block.Stone); // floor
    w.set(1, 1, 1, Block.Lava); // source; the tongue floods the floor around it
    const water = computeWater(w);
    const lava = computeLava(w);
    expect(w.get(3, 1, 1)).toBe(Block.Air); // a flooded NON-source cell…
    expect(mediumAtPoint(w, water, lava, [3.5, 1.5, 1.5])).toBe(Medium.Lava); // …reads Lava
    expect(mediumAtPoint(w, water, lava, [3.5, 2.5, 1.5])).toBe(Medium.Air); // above it: Air
  });
});
