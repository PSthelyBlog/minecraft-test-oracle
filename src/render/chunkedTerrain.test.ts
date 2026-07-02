import { describe, test, expect } from "vitest";
import fc from "fast-check";
import { MeshBasicMaterial, type Mesh } from "three";
import { World } from "../core/world";
import { Block } from "../core/blocks";
import { buildMesh } from "../core/mesher";
import { ChunkedTerrain } from "./chunkedTerrain";

/**
 * The chunk manager's contract: the union of its per-chunk geometries must cover
 * exactly the whole-world mesh, AND an incremental `rebuildAround` after an edit
 * must leave the scene identical to a from-scratch rebuild. A manager that rebuilt
 * the wrong chunks (or missed one) would pass a screenshot smoke test yet leave a
 * stale seam — so we pin it as a round-trip against the independent whole-world
 * mesher. (Three.js geometry is pure JS; no WebGL context needed.)
 *
 * Because the chunks are GREEDY-meshed (coplanar faces merged into bigger quads),
 * the comparison is in UNIT-FACE space: every quad is decomposed by its normal into
 * the `cell,faceDir` unit faces it covers, so a merged quad and the naive mesher's
 * unit faces compare equal exactly when they cover the same surface.
 */

const MAT = new MeshBasicMaterial();
const WATER_MAT = new MeshBasicMaterial({ transparent: true });

const normalToDir = (nx: number, ny: number, nz: number): number =>
  nx === 1 ? 0 : nx === -1 ? 1 : ny === 1 ? 2 : ny === -1 ? 3 : nz === 1 ? 4 : 5;
const faceAxes = (d: number): { a: number; u: number; v: number } => {
  const a = d < 2 ? 0 : d < 4 ? 1 : 2;
  const [u, v] = a === 0 ? [1, 2] : a === 1 ? [0, 2] : [0, 1];
  return { a, u, v };
};

/** Decompose quads (position + normal arrays, 4 verts/quad) into `cell,dir` unit faces. */
function unitFaces(pos: ArrayLike<number>, norm: ArrayLike<number>, quadCount: number): string[] {
  const keys: string[] = [];
  for (let f = 0; f < quadCount; f++) {
    const n = [norm[f * 12], norm[f * 12 + 1], norm[f * 12 + 2]];
    const d = normalToDir(n[0], n[1], n[2]);
    const { a, u, v } = faceAxes(d);
    const cs = [0, 1, 2, 3].map((k) => [
      pos[(f * 4 + k) * 3],
      pos[(f * 4 + k) * 3 + 1],
      pos[(f * 4 + k) * 3 + 2],
    ]);
    const planeA = cs[0][a];
    const umin = Math.min(...cs.map((c) => c[u]));
    const vmin = Math.min(...cs.map((c) => c[v]));
    const w = Math.max(...cs.map((c) => c[u])) - umin;
    const h = Math.max(...cs.map((c) => c[v])) - vmin;
    for (let i = 0; i < w; i++)
      for (let j = 0; j < h; j++) {
        const cell = [0, 0, 0];
        cell[a] = planeA - (n[a] > 0 ? 1 : 0);
        cell[u] = umin + i;
        cell[v] = vmin + j;
        keys.push(`${cell[0]},${cell[1]},${cell[2]},${d}`);
      }
  }
  return keys;
}

/** The unit faces the group's (greedy) geometries cover, sorted. */
function groupFaceKeys(terrain: ChunkedTerrain): string[] {
  const keys: string[] = [];
  for (const child of terrain.group.children) {
    const geo = (child as Mesh).geometry;
    const pos = geo.getAttribute("position");
    keys.push(...unitFaces(pos.array, geo.getAttribute("normal").array, pos.count / 4));
  }
  return keys.sort();
}

/** The same unit faces, derived independently from the whole-world (naive) mesher. */
function wholeFaceKeys(w: World): string[] {
  const m = buildMesh(w);
  return unitFaces(m.positions, m.normals, m.faceCount).sort();
}

describe("ChunkedTerrain oracle", () => {
  // ROUND-TRIP: the freshly-built chunked scene carries exactly the whole-world faces.
  test("initial build: union of chunk geometries == whole-world mesh", () => {
    const w = new World(20, 12, 20); // spans several 16-chunks incl. partial ones
    w.set(3, 1, 3, Block.Stone);
    w.set(18, 5, 2, Block.Glass);
    w.set(10, 8, 17, Block.Leaves);
    for (let x = 0; x < 20; x++) w.set(x, 0, x % 20, Block.Grass);
    const terrain = new ChunkedTerrain(w, MAT, WATER_MAT, 16);
    expect(groupFaceKeys(terrain)).toEqual(wholeFaceKeys(w));
  });

  // DIFFERENTIAL: after a sequence of random edits applied via rebuildAround, the
  // incrementally-maintained scene still equals a from-scratch whole-world mesh.
  // If rebuildAround under-reported the affected chunks, a stale seam would survive
  // here and the keys would diverge.
  test("incremental rebuildAround stays equal to a full rebuild after edits", () => {
    const id = fc.constantFrom(Block.Air, Block.Stone, Block.Glass, Block.Leaves);
    fc.assert(
      fc.property(
        fc.array(id, { minLength: 125, maxLength: 125 }), // initial 5×5×5 fill
        fc.array(
          fc.record({ flat: fc.nat(124), id }),
          { minLength: 1, maxLength: 12 }, // a batch of edits
        ),
        fc.constantFrom(2, 3, 4, 16),
        (cells, edits, chunkSize) => {
          const w = new World(5, 5, 5);
          cells.forEach((b, i) => (w.data[i] = b));
          const terrain = new ChunkedTerrain(w, MAT, WATER_MAT, chunkSize);

          for (const { flat, id: newId } of edits) {
            const x = flat % 5,
              z = Math.floor(flat / 5) % 5,
              y = Math.floor(flat / 25);
            w.set(x, y, z, newId);
            terrain.rebuildAround(x, y, z);
          }
          // The independent truth: a full mesh of the post-edit world.
          expect(groupFaceKeys(terrain)).toEqual(wholeFaceKeys(w));
        },
      ),
      { numRuns: 120 },
    );
  });

  // GRAVITY INTEGRATION: an edit that leaves a loose block unsupported must settle it — the
  // world is mutated (sand falls) AND the rendered scene equals a full mesh of the SETTLED
  // world. (Would fail before rebuildAround learned to run `settle`.)
  test("rebuildAround settles loose blocks and stays equal to the settled world", () => {
    const w = new World(5, 6, 5);
    for (let z = 0; z < 5; z++) for (let x = 0; x < 5; x++) w.set(x, 0, z, Block.Stone); // floor
    w.set(2, 4, 2, Block.Sand); // a sand block floating three cells above the floor
    const terrain = new ChunkedTerrain(w, MAT, WATER_MAT, 4);
    expect(w.get(2, 4, 2)).toBe(Block.Sand); // not settled yet (constructor doesn't settle)

    terrain.rebuildAround(2, 4, 2); // the edit's downstream settle

    expect(w.get(2, 4, 2)).toBe(Block.Air); // fell...
    expect(w.get(2, 1, 2)).toBe(Block.Sand); // ...to rest on the stone floor (y=0)
    expect(groupFaceKeys(terrain)).toEqual(wholeFaceKeys(w)); // scene matches the settled world
  });

  // An all-air world produces no draw calls (every chunk empty → no child meshes).
  test("empty world adds no chunk meshes", () => {
    const terrain = new ChunkedTerrain(new World(16, 16, 16), MAT, WATER_MAT, 8);
    expect(terrain.group.children.length).toBe(0);
  });
});
