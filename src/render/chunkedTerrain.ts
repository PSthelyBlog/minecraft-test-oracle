/**
 * Renders a World as a grid of per-chunk meshes so a block edit rebuilds only
 * the chunk(s) it touches, not the whole world.
 *
 * This is thin Three.js wiring — all the real logic (which cells a chunk owns,
 * how seams are culled, which chunks an edit affects) lives in the oracle-tested
 * core (`src/core/mesher.ts`). Verified by the headless smoke test, not a unit
 * oracle, in keeping with the pure-core / thin-shell split.
 */

import { Group, Mesh, type Material } from "three";
import type { World } from "../core/world";
import { buildGreedyChunkMesh, chunkDims, chunksAffectedByEdit, CHUNK_SIZE } from "../core/mesher";
import { computeBlockLight, computeSkyLight, updateLight } from "../core/light";
import { geometryFromMesh } from "./chunkGeometry";

export class ChunkedTerrain {
  /** Add this to the scene; every chunk mesh is parented here (all in world space). */
  readonly group = new Group();

  private readonly dims: { nx: number; ny: number; nz: number };
  private readonly meshes: (Mesh | null)[]; // one slot per chunk; null = empty (no faces)
  // Block, sky, and the combined max field, maintained incrementally across edits.
  // The mesher dims faces by `light`; the two component fields are what `updateLight`
  // needs to keep the combination correct without a full recompute.
  private readonly blockLight: Uint8Array;
  private readonly skyLight: Uint8Array;
  private readonly light: Uint8Array;

  constructor(
    private readonly world: World,
    private readonly material: Material,
    private readonly chunkSize: number = CHUNK_SIZE,
  ) {
    this.dims = chunkDims(world, chunkSize);
    this.meshes = new Array(this.dims.nx * this.dims.ny * this.dims.nz).fill(null);
    this.blockLight = computeBlockLight(world);
    this.skyLight = computeSkyLight(world);
    this.light = new Uint8Array(world.volume);
    for (let i = 0; i < this.light.length; i++)
      this.light[i] = Math.max(this.blockLight[i], this.skyLight[i]);
    for (let cy = 0; cy < this.dims.ny; cy++)
      for (let cz = 0; cz < this.dims.nz; cz++)
        for (let cx = 0; cx < this.dims.nx; cx++) this.buildChunk(cx, cy, cz);
  }

  private slot(cx: number, cy: number, cz: number): number {
    return cx + this.dims.nx * (cz + this.dims.nz * cy);
  }

  /** (Re)build a single chunk's mesh, disposing whatever was there before. */
  private buildChunk(cx: number, cy: number, cz: number): void {
    const i = this.slot(cx, cy, cz);
    const old = this.meshes[i];
    if (old) {
      this.group.remove(old);
      old.geometry.dispose();
      this.meshes[i] = null;
    }
    const mesh = buildGreedyChunkMesh(this.world, cx, cy, cz, this.chunkSize, this.light);
    if (mesh.faceCount === 0) return; // empty chunk → no draw call
    const m = new Mesh(geometryFromMesh(mesh), this.material);
    this.meshes[i] = m;
    this.group.add(m);
  }

  /**
   * Rebuild the chunks a block edit at (x, y, z) can have changed.
   *
   * The light fields are updated incrementally (`updateLight`, two-pass add/remove),
   * which returns exactly the cells whose combined light changed. A chunk must remesh
   * if its geometry changed (the edit) OR a face it draws is now lit differently — a
   * face's light comes from the open cell across it, so a light change at cell `c`
   * affects faces in `c`'s own chunk and its axis-neighbour chunks. That is precisely
   * `chunksAffectedByEdit(c)`, so we union it over the edit and every changed cell.
   */
  rebuildAround(x: number, y: number, z: number): void {
    const changed = updateLight(this.world, this.blockLight, this.skyLight, this.light, x, y, z);

    const { sizeX, sizeZ } = this.world;
    const seen = new Set<number>();
    const toBuild: [number, number, number][] = [];
    const consider = (cellX: number, cellY: number, cellZ: number): void => {
      for (const [cx, cy, cz] of chunksAffectedByEdit(
        this.world,
        cellX,
        cellY,
        cellZ,
        this.chunkSize,
      )) {
        const key = this.slot(cx, cy, cz);
        if (seen.has(key)) continue;
        seen.add(key);
        toBuild.push([cx, cy, cz]);
      }
    };

    consider(x, y, z); // the geometry edit itself
    for (const i of changed) {
      const cx = i % sizeX;
      const cz = Math.floor(i / sizeX) % sizeZ;
      const cy = Math.floor(i / (sizeX * sizeZ));
      consider(cx, cy, cz);
    }
    for (const [cx, cy, cz] of toBuild) this.buildChunk(cx, cy, cz);
  }
}
