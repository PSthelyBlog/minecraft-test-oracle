import { describe, test, expect } from "vitest";
import fc from "fast-check";
import { MeshBasicMaterial, type Mesh } from "three";
import { World } from "../core/world";
import { Block } from "../core/blocks";
import { buildMesh } from "../core/mesher";
import { ChunkedTerrain } from "./chunkedTerrain";

/**
 * The chunk manager's contract: the union of its per-chunk geometries must equal
 * the whole-world mesh, AND an incremental `rebuildAround` after an edit must
 * leave the scene identical to a from-scratch rebuild. A manager that rebuilt the
 * wrong chunks (or missed one) would pass a screenshot smoke test yet leave a
 * stale seam — so we pin it as a round-trip against the independent whole-world
 * mesher. (Three.js geometry is pure JS; no WebGL context needed.)
 */

const MAT = new MeshBasicMaterial();

/** Canonical sorted set of faces (4 world-space corners each) carried by the group. */
function groupFaceKeys(terrain: ChunkedTerrain): string[] {
  const keys: string[] = [];
  for (const child of terrain.group.children) {
    const pos = (child as Mesh).geometry.getAttribute("position");
    const a = pos.array;
    for (let f = 0; f < pos.count / 4; f++) {
      const base = f * 4 * 3;
      const parts: number[] = [];
      for (let k = 0; k < 12; k++) parts.push(a[base + k]);
      keys.push(parts.join(","));
    }
  }
  return keys.sort();
}

/** The same canonical set, derived independently from the whole-world mesher. */
function wholeFaceKeys(w: World): string[] {
  const m = buildMesh(w);
  const keys: string[] = [];
  for (let f = 0; f < m.faceCount; f++) {
    const base = f * 4 * 3;
    const parts: number[] = [];
    for (let k = 0; k < 12; k++) parts.push(m.positions[base + k]);
    keys.push(parts.join(","));
  }
  return keys.sort();
}

describe("ChunkedTerrain oracle", () => {
  // ROUND-TRIP: the freshly-built chunked scene carries exactly the whole-world faces.
  test("initial build: union of chunk geometries == whole-world mesh", () => {
    const w = new World(20, 12, 20); // spans several 16-chunks incl. partial ones
    w.set(3, 1, 3, Block.Stone);
    w.set(18, 5, 2, Block.Glass);
    w.set(10, 8, 17, Block.Leaves);
    for (let x = 0; x < 20; x++) w.set(x, 0, x % 20, Block.Grass);
    const terrain = new ChunkedTerrain(w, MAT, 16);
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
        fc.array(id, { minLength: 125, maxLength: 125 }),                    // initial 5×5×5 fill
        fc.array(
          fc.record({ flat: fc.nat(124), id }),
          { minLength: 1, maxLength: 12 },                                   // a batch of edits
        ),
        fc.constantFrom(2, 3, 4, 16),
        (cells, edits, chunkSize) => {
          const w = new World(5, 5, 5);
          cells.forEach((b, i) => (w.data[i] = b));
          const terrain = new ChunkedTerrain(w, MAT, chunkSize);

          for (const { flat, id: newId } of edits) {
            const x = flat % 5, z = Math.floor(flat / 5) % 5, y = Math.floor(flat / 25);
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

  // An all-air world produces no draw calls (every chunk empty → no child meshes).
  test("empty world adds no chunk meshes", () => {
    const terrain = new ChunkedTerrain(new World(16, 16, 16), MAT, 8);
    expect(terrain.group.children.length).toBe(0);
  });
});
