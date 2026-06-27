import { describe, test, expect } from "vitest";
import { World } from "../core/world";
import { Block } from "../core/blocks";
import { buildMesh } from "../core/mesher";
import { buildChunkGeometry } from "./chunkGeometry";

/**
 * The geometry builder must upload the mesher's typed arrays into the
 * BufferGeometry FAITHFULLY — a dropped attribute or a wrong itemSize is a silent
 * rendering corruption. This is a round-trip oracle: what the mesher produced must
 * be exactly what the geometry carries. (Three.js BufferGeometry is pure JS and
 * needs no WebGL context, so it runs headless.)
 */
describe("chunkGeometry oracle", () => {
  test("uploads the mesh's arrays without loss or reshape", () => {
    const w = new World(4, 4, 4);
    w.set(1, 1, 1, Block.Stone);
    w.set(2, 1, 1, Block.Glass);
    w.set(1, 2, 1, Block.Leaves);
    const mesh = buildMesh(w);
    const geo = buildChunkGeometry(w);

    const pos = geo.getAttribute("position");
    const norm = geo.getAttribute("normal");
    const col = geo.getAttribute("color");
    const uv = geo.getAttribute("uv");
    const idx = geo.getIndex();

    // itemSize (3 for vectors, 2 for UVs, 1 for indices) — a wrong stride silently skews data.
    expect(pos.itemSize).toBe(3);
    expect(norm.itemSize).toBe(3);
    expect(col.itemSize).toBe(3);
    expect(uv.itemSize).toBe(2);

    // exact same contents as the mesher emitted
    expect(Array.from(pos.array)).toEqual(Array.from(mesh.positions));
    expect(Array.from(norm.array)).toEqual(Array.from(mesh.normals));
    expect(Array.from(col.array)).toEqual(Array.from(mesh.colors));
    expect(Array.from(uv.array)).toEqual(Array.from(mesh.uvs));
    expect(uv.count).toBe(mesh.faceCount * 4); // 4 UVs per face, itemSize 2
    expect(idx).not.toBeNull();
    expect(Array.from(idx!.array)).toEqual(Array.from(mesh.indices));

    // index/vertex bookkeeping stays consistent
    expect(idx!.count).toBe(mesh.faceCount * 6);
    expect(pos.count).toBe(mesh.faceCount * 4);
  });

  test("an empty world yields empty, valid geometry (no crash, no stray verts)", () => {
    const geo = buildChunkGeometry(new World(3, 3, 3));
    expect(geo.getAttribute("position").count).toBe(0);
    expect(geo.getIndex()!.count).toBe(0);
  });
});
