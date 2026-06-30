import { describe, test, expect } from "vitest";
import fc from "fast-check";
import { World } from "./world";
import { Block, isOpaque, emissionOf, emissionColorOf } from "./blocks";
import {
  computeBlockLight,
  computeSkyLight,
  computeLight,
  computeBlockLightRGB,
  computeLightRGB,
  updateBlockLight,
  updateSkyLight,
  updateLight,
  MAX_LIGHT,
} from "./light";
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

describe("combined-light oracle", () => {
  // CENSUS: computeLight is the cell-wise MAX of block-light and skylight — a cell is
  // as lit as the brighter of the two reaches it. Re-derived independently (the test
  // takes its own max), over random worlds, so `max → min`/`+`/either-source-dropped
  // all disagree. Bounds and the ≥-each-component invariant are checked too.
  test("census: combined light is the cell-wise max of block-light and skylight", () => {
    fc.assert(
      fc.property(randomCells, (cells) => {
        const w = fill(cells);
        const block = computeBlockLight(w);
        const sky = computeSkyLight(w);
        const combined = computeLight(w);
        for (let i = 0; i < w.volume; i++) {
          expect(combined[i]).toBe(Math.max(block[i], sky[i]));
          expect(combined[i]).toBeGreaterThanOrEqual(block[i]);
          expect(combined[i]).toBeGreaterThanOrEqual(sky[i]);
          expect(combined[i]).toBeLessThanOrEqual(MAX_LIGHT);
        }
      }),
      { numRuns: 200 },
    );
  });
});

// A 5×5×5 world is small enough to recompute from scratch after every edit, yet tall
// enough (columns of 5) to exercise skylight's column rule and light reach across cells.
const editBlocks = [
  Block.Air,
  Block.Stone, // opaque non-emitter
  Block.Glass, // transparent
  Block.Leaves, // transparent
  Block.Glowstone, // opaque emitter (15)
];
const cube = fc.array(fc.constantFrom(...editBlocks), { minLength: 125, maxLength: 125 });
const fill5 = (cells: number[]): World => {
  const w = new World(5, 5, 5);
  cells.forEach((b, i) => (w.data[i] = b));
  return w;
};
// Invert world.index = x + 5*(z + 5*y): x fastest, then z, then y (y-major).
const decode5 = (idx: number): [number, number, number] => [
  idx % 5,
  Math.floor(idx / 25),
  Math.floor(idx / 5) % 5,
];

describe("incremental-light oracle", () => {
  // DIFFERENTIAL (headline): replaying a random sequence of block edits through the
  // incremental updaters must leave block / sky / combined byte-identical to a
  // from-scratch recompute — after EVERY edit. Any missed case in the two-pass
  // removal/add logic or the skylight column rule shows up as a mismatch. Mirrors the
  // chunksAffectedByEdit differential and is independent of the incremental internals.
  test("differential: incremental == from-scratch recompute, edit by edit", () => {
    fc.assert(
      fc.property(
        cube,
        fc.array(fc.tuple(fc.nat(124), fc.constantFrom(...editBlocks)), {
          minLength: 1,
          maxLength: 12,
        }),
        (initial, edits) => {
          const w = fill5(initial);
          const block = computeBlockLight(w);
          const sky = computeSkyLight(w);
          const combined = computeLight(w);
          for (const [idx, nb] of edits) {
            const [x, y, z] = decode5(idx);
            w.data[idx] = nb; // apply the edit (== w.set within bounds)
            updateLight(w, block, sky, combined, x, y, z);
            expect(Array.from(block)).toEqual(Array.from(computeBlockLight(w)));
            expect(Array.from(sky)).toEqual(Array.from(computeSkyLight(w)));
            expect(Array.from(combined)).toEqual(Array.from(computeLight(w)));
          }
        },
      ),
      { numRuns: 200 },
    );
  });

  // The two single-field updaters individually match their from-scratch counterparts —
  // pins each in isolation (so a regression points at block vs sky, not just combined).
  test("differential: updateBlockLight / updateSkyLight each match their recompute", () => {
    fc.assert(
      fc.property(cube, fc.nat(124), fc.constantFrom(...editBlocks), (initial, idx, nb) => {
        const w = fill5(initial);
        const block = computeBlockLight(w);
        const sky = computeSkyLight(w);
        const [x, y, z] = decode5(idx);
        w.data[idx] = nb;
        updateBlockLight(w, block, x, y, z);
        updateSkyLight(w, sky, x, y, z);
        expect(Array.from(block)).toEqual(Array.from(computeBlockLight(w)));
        expect(Array.from(sky)).toEqual(Array.from(computeSkyLight(w)));
      }),
      { numRuns: 300 },
    );
  });

  // PER-FIELD CHANGED-SET CENSUS: each single-field updater returns EXACTLY the cells
  // whose own field changed (vs a before-snapshot), duplicate-free. Pins the change-
  // tracking bookkeeping directly (the first-touch original capture, the junk-free
  // result list) — which `updateLight` then filters, so only this test sees it.
  test("census: updateBlockLight / updateSkyLight return exactly their field's changed cells", () => {
    fc.assert(
      fc.property(cube, fc.nat(124), fc.constantFrom(...editBlocks), (initial, idx, nb) => {
        const w = fill5(initial);
        const block = computeBlockLight(w);
        const sky = computeSkyLight(w);
        const b0 = Array.from(block);
        const s0 = Array.from(sky);
        const [x, y, z] = decode5(idx);
        w.data[idx] = nb;
        const cb = updateBlockLight(w, block, x, y, z);
        const cs = updateSkyLight(w, sky, x, y, z);
        const actualB = new Set<number>();
        for (let i = 0; i < block.length; i++) if (block[i] !== b0[i]) actualB.add(i);
        const actualS = new Set<number>();
        for (let i = 0; i < sky.length; i++) if (sky[i] !== s0[i]) actualS.add(i);
        expect(new Set(cb)).toEqual(actualB);
        expect(new Set(cs)).toEqual(actualS);
        expect(cb.length).toBe(new Set(cb).size); // duplicate-free
        expect(cs.length).toBe(new Set(cs).size);
      }),
      { numRuns: 300 },
    );
  });

  // CHANGED-SET CENSUS: the indices updateLight returns are EXACTLY the cells whose
  // combined light changed — no stale omission (a missed cell ⇒ a stale-lit chunk) and
  // no spurious entry, and the list is duplicate-free. This is what the renderer trusts
  // to decide which chunks to remesh.
  test("census: the returned changed set is exactly the cells whose combined light changed", () => {
    fc.assert(
      fc.property(cube, fc.nat(124), fc.constantFrom(...editBlocks), (initial, idx, nb) => {
        const w = fill5(initial);
        const block = computeBlockLight(w);
        const sky = computeSkyLight(w);
        const combined = computeLight(w);
        const before = Array.from(combined);
        const [x, y, z] = decode5(idx);
        w.data[idx] = nb;
        const changed = updateLight(w, block, sky, combined, x, y, z);
        const actual = new Set<number>();
        for (let i = 0; i < combined.length; i++) if (combined[i] !== before[i]) actual.add(i);
        expect(new Set(changed)).toEqual(actual);
        expect(changed.length).toBe(new Set(changed).size); // no duplicates
      }),
      { numRuns: 300 },
    );
  });
});

/**
 * INDEPENDENT per-channel relaxation: identical to `relaxLight`, but each cell's seed is
 * `round(emission · emissionColor[c])` instead of the scalar emission. Re-derives one
 * colour channel of the RGB block-light by a different mechanism than light.ts's BFS.
 */
function relaxChannel(w: World, c: number): Uint8Array {
  const L = new Uint8Array(w.volume);
  const seedOf = (id: number): number => Math.round(emissionOf(id) * emissionColorOf(id)[c]);
  for (let y = 0; y < w.sizeY; y++)
    for (let z = 0; z < w.sizeZ; z++)
      for (let x = 0; x < w.sizeX; x++) L[w.index(x, y, z)] = seedOf(w.get(x, y, z));
  let changed = true;
  while (changed) {
    changed = false;
    for (let y = 0; y < w.sizeY; y++)
      for (let z = 0; z < w.sizeZ; z++)
        for (let x = 0; x < w.sizeX; x++) {
          if (isOpaque(w.get(x, y, z))) continue;
          let v = seedOf(w.get(x, y, z));
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

describe("coloured-light oracle", () => {
  // RE-DERIVATION (headline): each RGB channel equals an INDEPENDENT per-channel
  // relaxation seeded at round(emission · tint[c]). A swapped channel, a wrong seed
  // scale, or a per-channel flood bug disagrees with the relaxation.
  test("re-derivation: each RGB channel equals an independent per-channel relaxation", () => {
    fc.assert(
      fc.property(randomCells, (cells) => {
        const w = fill(cells);
        const rgb = computeBlockLightRGB(w);
        expect(Array.from(rgb.r)).toEqual(Array.from(relaxChannel(w, 0)));
        expect(Array.from(rgb.g)).toEqual(Array.from(relaxChannel(w, 1)));
        expect(Array.from(rgb.b)).toEqual(Array.from(relaxChannel(w, 2)));
      }),
      { numRuns: 250 },
    );
  });

  // REDUCTION (strict-extension proof): Glowstone's tint has red = 1.0, so the RED
  // channel seeds at round(15·1) = 15 = the scalar emission and floods identically — the
  // red channel must be BYTE-IDENTICAL to scalar computeBlockLight on every world.
  test("reduction: the red channel reproduces scalar block-light byte-for-byte", () => {
    fc.assert(
      fc.property(randomCells, (cells) => {
        const w = fill(cells);
        expect(Array.from(computeBlockLightRGB(w).r)).toEqual(Array.from(computeBlockLight(w)));
      }),
      { numRuns: 250 },
    );
  });

  // CENSUS: computeLightRGB is the per-channel cell-wise max of coloured block-light and
  // WHITE skylight (the scalar skylight applied to every channel) — re-derived independently.
  test("census: computeLightRGB is the per-channel max of block-RGB and white skylight", () => {
    fc.assert(
      fc.property(randomCells, (cells) => {
        const w = fill(cells);
        const block = computeBlockLightRGB(w);
        const sky = computeSkyLight(w);
        const combined = computeLightRGB(w);
        for (let i = 0; i < w.volume; i++) {
          expect(combined.r[i]).toBe(Math.max(block.r[i], sky[i]));
          expect(combined.g[i]).toBe(Math.max(block.g[i], sky[i]));
          expect(combined.b[i]).toBe(Math.max(block.b[i], sky[i]));
        }
      }),
      { numRuns: 200 },
    );
  });

  // INVARIANT: Glowstone's warm tint is ordered red ≥ green ≥ blue (1.0 ≥ 0.85 ≥ 0.55),
  // and the flood is monotone in the seed, so the channels stay ordered r ≥ g ≥ b at EVERY
  // cell. A channel swap (e.g. green using the red tint) breaks the ordering.
  test("invariant: a warm emitter's channels stay ordered r ≥ g ≥ b everywhere", () => {
    fc.assert(
      fc.property(randomCells, (cells) => {
        const w = fill(cells);
        const { r, g, b } = computeBlockLightRGB(w);
        for (let i = 0; i < w.volume; i++) {
          expect(r[i]).toBeGreaterThanOrEqual(g[i]);
          expect(g[i]).toBeGreaterThanOrEqual(b[i]);
        }
      }),
      { numRuns: 200 },
    );
  });

  // GOLDEN / CLOSED FORM: a lone Glowstone in open air. Each channel decays by Manhattan
  // distance from its own seed: red 15, green round(15·0.85)=13, blue round(15·0.55)=8.
  // Pins the per-channel seed scale and the decay independently of the relaxation.
  test("golden: a lone warm emitter decays per channel from its tinted seed", () => {
    const w = new World(11, 11, 11);
    const cx = 5;
    w.set(cx, cx, cx, Block.Glowstone);
    const { r, g, b } = computeBlockLightRGB(w);
    for (let y = 0; y < 11; y++)
      for (let z = 0; z < 11; z++)
        for (let x = 0; x < 11; x++) {
          const d = Math.abs(x - cx) + Math.abs(y - cx) + Math.abs(z - cx);
          const i = w.index(x, y, z);
          expect(r[i]).toBe(Math.max(0, 15 - d));
          expect(g[i]).toBe(Math.max(0, 13 - d));
          expect(b[i]).toBe(Math.max(0, 8 - d));
        }
  });
});
