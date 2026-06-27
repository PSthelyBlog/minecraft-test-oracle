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
import {
  buildChunkMesh,
  chunkDims,
  chunksAffectedByEdit,
  CHUNK_SIZE,
} from "../core/mesher";
import { geometryFromMesh } from "./chunkGeometry";

export class ChunkedTerrain {
  /** Add this to the scene; every chunk mesh is parented here (all in world space). */
  readonly group = new Group();

  private readonly dims: { nx: number; ny: number; nz: number };
  private readonly meshes: (Mesh | null)[]; // one slot per chunk; null = empty (no faces)

  constructor(
    private readonly world: World,
    private readonly material: Material,
    private readonly chunkSize: number = CHUNK_SIZE,
  ) {
    this.dims = chunkDims(world, chunkSize);
    this.meshes = new Array(this.dims.nx * this.dims.ny * this.dims.nz).fill(null);
    for (let cy = 0; cy < this.dims.ny; cy++)
      for (let cz = 0; cz < this.dims.nz; cz++)
        for (let cx = 0; cx < this.dims.nx; cx++)
          this.buildChunk(cx, cy, cz);
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
    const mesh = buildChunkMesh(this.world, cx, cy, cz, this.chunkSize);
    if (mesh.faceCount === 0) return; // empty chunk → no draw call
    const m = new Mesh(geometryFromMesh(mesh), this.material);
    this.meshes[i] = m;
    this.group.add(m);
  }

  /** Rebuild exactly the chunks a block edit at (x, y, z) can have changed. */
  rebuildAround(x: number, y: number, z: number): void {
    for (const [cx, cy, cz] of chunksAffectedByEdit(this.world, x, y, z, this.chunkSize)) {
      this.buildChunk(cx, cy, cz);
    }
  }
}
