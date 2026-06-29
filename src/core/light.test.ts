import { describe, test, expect } from "vitest";
import fc from "fast-check";
import { World } from "./world";
import { Block, isOpaque, emissionOf } from "./blocks";
import { computeBlockLight, computeSkyLight, MAX_LIGHT } from "./light";
import { generateTerrain } from "./terrain";

/**
 * Block-light is a max-fixpoint flood. These oracles re-derive it INDEPENDENTLY of
 * the BFS in light.ts (a relaxation, a distance formula), pin the shadow-casting
 * behaviour metamorphically, and assert the structural invariants — so an off-by-one
 * decay, a missed neighbour, a flipped opaque check, or light leaking through a wall
 * all disagree with at least one oracle.
 */

const NB = [
  [1, 0, 0],
  [-1, 0, 0],
  [0, 1, 0],
  [0, -1, 0],
  [0, 0, 1],
  [0, 0, -1],
] as const;

/**
 * INDEPENDENT re-derivation: relax to the same fixpoint by repeated full sweeps
 * (Gauss–Seidel), a different mechanism from light.ts's BFS queue. A cell is its own
 * emission; a NON-opaque cell additionally takes one less than its brightest
 * neighbour. Opaque cells keep their emission and never receive — so an opaque
 * non-emitter holds 0 and never relays, i.e. it casts shadow.
 */
function relaxLight(w: World): Uint8Array {
  const L = new Uint8Array(w.volume);
  for (let y = 0; y < w.sizeY; y++)
    for (let z = 0; z < w.sizeZ; z++)
      for (let x = 0; x < w.sizeX; x++) L[w.index(x, y, z)] = emissionOf(w.get(x, y, z));
  let changed = true;
  while (changed) {
    changed = false;
    for (let y = 0; y < w.sizeY; y++)
      for (let z = 0; z < w.sizeZ; z++)
        for (let x = 0; x < w.sizeX; x++) {
          if (isOpaque(w.get(x, y, z))) continue; // opaque: stuck at its emission
          let v = emissionOf(w.get(x, y, z));
          for (const [dx, dy, dz] of NB) {
            if (!w.inBounds(x + dx, y + dy, z + dz)) continue;
            const nl = L[w.index(x + dx, y + dy, z + dz)];
            if (nl - 1 > v) v = nl - 1;
          }
          const i = w.index(x, y, z);
          if (v > L[i]) {
            L[i] = v;
            changed = true;
          }
        }
  }
  return L;
}

const randomCells = fc.array(
  fc.constantFrom(
    Block.Air,
    Block.Stone, // opaque non-emitter (wall)
    Block.Glass, // transparent
    Block.Leaves, // transparent
    Block.Glowstone, // emitter (15), opaque
  ),
  { minLength: 64, maxLength: 64 },
);
const fill = (cells: number[]): World => {
  const w = new World(4, 4, 4);
  cells.forEach((b, i) => (w.data[i] = b));
  return w;
};

describe("block-light oracle", () => {
  // GOLDEN / RE-DERIVATION (open air): a lone source in all-air decays by exactly
  // Manhattan distance — BFS distance through open air IS the L1 distance. Fully
  // independent of the implementation (a closed-form distance formula).
  test("golden: a lone source in open air decays by Manhattan distance", () => {
    const w = new World(9, 9, 9);
    const cx = 4,
      cy = 4,
      cz = 4;
    w.set(cx, cy, cz, Block.Glowstone); // emission 15, the only non-air cell
    const light = computeBlockLight(w);
    for (let y = 0; y < 9; y++)
      for (let z = 0; z < 9; z++)
        for (let x = 0; x < 9; x++) {
          const d = Math.abs(x - cx) + Math.abs(y - cy) + Math.abs(z - cz);
          expect(light[w.index(x, y, z)]).toBe(Math.max(0, MAX_LIGHT - d));
        }
  });

  // HEADLINE RE-DERIVATION: over random worlds (walls / glass / multiple sources),
  // the BFS field equals the independent relaxation, cell for cell.
  test("re-derivation: BFS block-light equals an independent relaxation", () => {
    fc.assert(
      fc.property(randomCells, (cells) => {
        const w = fill(cells);
        expect(Array.from(computeBlockLight(w))).toEqual(Array.from(relaxLight(w)));
      }),
      { numRuns: 300 },
    );
  });

  // INVARIANTS: bounds; opaque non-emitters are dark; and the gradient rule — a lit
  // cell that is not itself a source of ≥ its level must have a neighbour brighter by
  // ≥ 1 (light never appears from nowhere).
  test("invariants: bounds, opaque cells dark, and light has a brighter source", () => {
    fc.assert(
      fc.property(randomCells, (cells) => {
        const w = fill(cells);
        const light = computeBlockLight(w);
        for (let y = 0; y < 4; y++)
          for (let z = 0; z < 4; z++)
            for (let x = 0; x < 4; x++) {
              const l = light[w.index(x, y, z)];
              expect(l).toBeGreaterThanOrEqual(0);
              expect(l).toBeLessThanOrEqual(MAX_LIGHT);
              const id = w.get(x, y, z);
              if (isOpaque(id) && emissionOf(id) === 0) expect(l).toBe(0);
              if (l > 0 && emissionOf(id) < l) {
                let brighter = false;
                for (const [dx, dy, dz] of NB) {
                  if (!w.inBounds(x + dx, y + dy, z + dz)) continue;
                  if (light[w.index(x + dx, y + dy, z + dz)] >= l + 1) brighter = true;
                }
                expect(brighter).toBe(true);
              }
            }
      }),
      { numRuns: 200 },
    );
  });

  // METAMORPHIC (shadow): replacing any cell with an opaque non-emitter (Stone) can
  // only DARKEN — it removes any emission there and blocks light paths through it, and
  // can never create light or open a path. Pins that opaque blocks cast shadow.
  test("metamorphic: adding an opaque occluder never brightens any cell", () => {
    fc.assert(
      fc.property(randomCells, fc.nat(63), (cells, k) => {
        const w = fill(cells);
        const before = computeBlockLight(w);
        const x = k % 4,
          z = Math.floor(k / 4) % 4,
          y = Math.floor(k / 16);
        w.set(x, y, z, Block.Stone); // opaque, emission 0
        const after = computeBlockLight(w);
        for (let i = 0; i < w.volume; i++) expect(after[i]).toBeLessThanOrEqual(before[i]);
      }),
      { numRuns: 200 },
    );
  });

  // GOLDEN: freeze a fixed lit scene (a source behind a partial wall) so the exact
  // field — including the shadow — can't silently drift. Determinism too.
  test("golden: a fixed lit scene's light field is stable", () => {
    const w = new World(7, 5, 7);
    w.set(3, 2, 3, Block.Glowstone);
    // a partial wall one cell to +X of the source, casting a shadow beyond it
    w.set(4, 1, 3, Block.Stone);
    w.set(4, 2, 3, Block.Stone);
    w.set(4, 3, 3, Block.Stone);
    const light = computeBlockLight(w);
    let h = 0x811c9dc5;
    for (const v of light) {
      h ^= v;
      h = Math.imul(h, 0x01000193);
    }
    expect((h >>> 0).toString(16)).toBe("c14b9890");
    // determinism: a second run is identical
    expect(Array.from(computeBlockLight(w))).toEqual(Array.from(light));
  });
});

/**
 * INDEPENDENT sky-exposure: a cell is open to the sky iff every cell STRICTLY ABOVE
 * it in its column is non-opaque. Computed here by scanning upward — a different
 * mechanism from light.ts, which seeds by walking each column downward and breaking
 * at the first opaque block.
 */
function skyExposed(w: World, x: number, y: number, z: number): boolean {
  for (let yy = y + 1; yy < w.sizeY; yy++) if (isOpaque(w.get(x, yy, z))) return false;
  return true;
}

/**
 * INDEPENDENT re-derivation of skylight: the same Gauss–Seidel relaxation as
 * `relaxLight`, but seeded from open sky instead of emitters. A non-opaque cell is
 * MAX_LIGHT if it is sky-exposed, else one less than its brightest neighbour. Opaque
 * cells stay 0. This converges to the same max-fixpoint as light.ts's BFS by a
 * different mechanism (full sweeps, independent sky test), so any off-by-one decay,
 * missed neighbour, flipped opaque check, or mis-seeded column disagrees.
 */
function relaxSky(w: World): Uint8Array {
  const L = new Uint8Array(w.volume);
  const base = (x: number, y: number, z: number): number =>
    !isOpaque(w.get(x, y, z)) && skyExposed(w, x, y, z) ? MAX_LIGHT : 0;
  for (let y = 0; y < w.sizeY; y++)
    for (let z = 0; z < w.sizeZ; z++)
      for (let x = 0; x < w.sizeX; x++) L[w.index(x, y, z)] = base(x, y, z);
  let changed = true;
  while (changed) {
    changed = false;
    for (let y = 0; y < w.sizeY; y++)
      for (let z = 0; z < w.sizeZ; z++)
        for (let x = 0; x < w.sizeX; x++) {
          if (isOpaque(w.get(x, y, z))) continue; // opaque: stuck at 0, casts shadow
          let v = base(x, y, z);
          for (const [dx, dy, dz] of NB) {
            if (!w.inBounds(x + dx, y + dy, z + dz)) continue;
            const nl = L[w.index(x + dx, y + dy, z + dz)];
            if (nl - 1 > v) v = nl - 1;
          }
          const i = w.index(x, y, z);
          if (v > L[i]) {
            L[i] = v;
            changed = true;
          }
        }
  }
  return L;
}

const fnv = (light: Uint8Array): string => {
  let h = 0x811c9dc5;
  for (const v of light) {
    h ^= v;
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
};

describe("skylight oracle", () => {
  // GOLDEN / CLOSED FORM: an all-air world is fully open to the sky, so every cell is
  // MAX_LIGHT. A purely independent statement of the seeding.
  test("golden: an all-air world is uniformly full skylight", () => {
    const w = new World(5, 6, 5);
    const light = computeSkyLight(w);
    for (let i = 0; i < w.volume; i++) expect(light[i]).toBe(MAX_LIGHT);
  });

  // GOLDEN / CLOSED FORM: a single opaque roof block in open air. Every cell stays 15
  // except the block itself (0) and the column directly beneath it — each shadow cell
  // has a sky-exposed (15) horizontal neighbour, so it is exactly 14. No level reaches
  // 13. Fully independent of the implementation.
  test("golden: a lone roof block casts a 14-bright shadow column", () => {
    const w = new World(7, 7, 7);
    const rx = 3,
      ry = 3,
      rz = 3;
    w.set(rx, ry, rz, Block.Stone);
    const light = computeSkyLight(w);
    for (let y = 0; y < 7; y++)
      for (let z = 0; z < 7; z++)
        for (let x = 0; x < 7; x++) {
          let expected = MAX_LIGHT;
          if (x === rx && z === rz) {
            if (y === ry)
              expected = 0; // the opaque block
            else if (y < ry) expected = MAX_LIGHT - 1; // shadow column beneath it
          }
          expect(light[w.index(x, y, z)]).toBe(expected);
        }
  });

  // HEADLINE RE-DERIVATION: over random worlds, the BFS skylight equals the
  // independent relaxation, cell for cell.
  test("re-derivation: BFS skylight equals an independent relaxation", () => {
    fc.assert(
      fc.property(randomCells, (cells) => {
        const w = fill(cells);
        expect(Array.from(computeSkyLight(w))).toEqual(Array.from(relaxSky(w)));
      }),
      { numRuns: 300 },
    );
  });

  // INVARIANTS: bounds; opaque cells dark; sky-exposed cells are full; and the
  // gradient rule — a lit, non-sky-exposed cell must have a neighbour brighter by ≥ 1
  // (skylight never appears from nowhere).
  test("invariants: bounds, opaque dark, sky cells full, light has a brighter source", () => {
    fc.assert(
      fc.property(randomCells, (cells) => {
        const w = fill(cells);
        const light = computeSkyLight(w);
        for (let y = 0; y < 4; y++)
          for (let z = 0; z < 4; z++)
            for (let x = 0; x < 4; x++) {
              const l = light[w.index(x, y, z)];
              expect(l).toBeGreaterThanOrEqual(0);
              expect(l).toBeLessThanOrEqual(MAX_LIGHT);
              const opaque = isOpaque(w.get(x, y, z));
              if (opaque) expect(l).toBe(0);
              else if (skyExposed(w, x, y, z)) expect(l).toBe(MAX_LIGHT);
              if (!opaque && !skyExposed(w, x, y, z) && l > 0) {
                let brighter = false;
                for (const [dx, dy, dz] of NB) {
                  if (!w.inBounds(x + dx, y + dy, z + dz)) continue;
                  if (light[w.index(x + dx, y + dy, z + dz)] >= l + 1) brighter = true;
                }
                expect(brighter).toBe(true);
              }
            }
      }),
      { numRuns: 200 },
    );
  });

  // METAMORPHIC (shadow): replacing any cell with an opaque non-emitter can only
  // DARKEN — it removes light there and blocks paths through it, never creating light
  // or opening a path. Pins that a roof darkens everything beneath/around it.
  test("metamorphic: adding an opaque occluder never brightens any cell", () => {
    fc.assert(
      fc.property(randomCells, fc.nat(63), (cells, k) => {
        const w = fill(cells);
        const before = computeSkyLight(w);
        const x = k % 4,
          z = Math.floor(k / 4) % 4,
          y = Math.floor(k / 16);
        w.set(x, y, z, Block.Stone); // opaque, emission 0
        const after = computeSkyLight(w);
        for (let i = 0; i < w.volume; i++) expect(after[i]).toBeLessThanOrEqual(before[i]);
      }),
      { numRuns: 200 },
    );
  });

  // GOLDEN (integration + determinism): skylight over the real seeded 80×32×80 world.
  // The pinned hash is independently cross-checked against relaxSky below, and a second
  // run is identical. Re-pin only after re-deriving (relaxSky must still agree).
  test("golden: skylight over the seeded terrain is stable and matches relaxation", () => {
    const w = new World(80, 32, 80);
    generateTerrain(w, 20090513);
    const light = computeSkyLight(w);
    expect(fnv(light)).toBe("2519156e");
    expect(Array.from(light)).toEqual(Array.from(relaxSky(w)));
    expect(Array.from(computeSkyLight(w))).toEqual(Array.from(light)); // determinism
  });
});
