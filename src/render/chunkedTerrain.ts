/**
 * Renders a World as a grid of per-chunk meshes so a block edit rebuilds only
 * the chunk(s) it touches, not the whole world. Each chunk has TWO meshes: the
 * opaque terrain (solid blocks) and the translucent water surface, in separate
 * groups so the water can draw in its own alpha-blended pass.
 *
 * This is thin Three.js wiring — all the real logic (which cells a chunk owns,
 * how seams are culled, which chunks an edit affects, light + water fields) lives in
 * the oracle-tested core (`mesher.ts`, `light.ts`, `water.ts`, `waterMesh.ts`). The
 * round-trip is pinned by `chunkedTerrain.test.ts`; the look by the smoke test.
 */

import { Group, Mesh, type Material } from "three";
import type { World } from "../core/world";
import { buildGreedyChunkMesh, chunkDims, chunksAffectedByEdit, CHUNK_SIZE } from "../core/mesher";
import { computeLightRGB, type RGBLight } from "../core/light";
import { computeWater } from "../core/water";
import { settle } from "../core/gravity";
import { buildWaterChunkMesh } from "../core/waterMesh";
import { geometryFromMesh } from "./chunkGeometry";

export class ChunkedTerrain {
  /** Opaque terrain meshes (add to the scene). */
  readonly group = new Group();
  /** Translucent water meshes (add to the scene; drawn in its own alpha pass). */
  readonly waterGroup = new Group();

  private readonly dims: { nx: number; ny: number; nz: number };
  private readonly meshes: (Mesh | null)[]; // one terrain slot per chunk; null = empty
  private readonly waterMeshes: (Mesh | null)[]; // one water slot per chunk; null = no water
  // Combined RGB light + the water presence field, both recomputed and diffed per edit
  // (both are sub-10 ms on this world, so the per-edit recompute is imperceptible — see
  // the incremental discussion in #86). The mesher dims faces by `light`; the water mesh
  // is built from `water` and shaded by `light`.
  private light: RGBLight;
  private water: Uint8Array;

  constructor(
    private readonly world: World,
    private readonly material: Material,
    private readonly waterMaterial: Material,
    private readonly chunkSize: number = CHUNK_SIZE,
  ) {
    this.dims = chunkDims(world, chunkSize);
    const n = this.dims.nx * this.dims.ny * this.dims.nz;
    this.meshes = new Array(n).fill(null);
    this.waterMeshes = new Array(n).fill(null);
    this.light = computeLightRGB(world);
    this.water = computeWater(world);
    for (let cy = 0; cy < this.dims.ny; cy++)
      for (let cz = 0; cz < this.dims.nz; cz++)
        for (let cx = 0; cx < this.dims.nx; cx++) {
          this.buildChunk(cx, cy, cz);
          this.buildWaterChunk(cx, cy, cz);
        }
  }

  /** The current water presence field (0/1), for player physics (submersion). */
  get waterField(): Uint8Array {
    return this.water;
  }

  private slot(cx: number, cy: number, cz: number): number {
    return cx + this.dims.nx * (cz + this.dims.nz * cy);
  }

  /** (Re)build a chunk's opaque terrain mesh, disposing whatever was there before. */
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

  /** (Re)build a chunk's translucent water mesh, disposing whatever was there before. */
  private buildWaterChunk(cx: number, cy: number, cz: number): void {
    const i = this.slot(cx, cy, cz);
    const old = this.waterMeshes[i];
    if (old) {
      this.waterGroup.remove(old);
      old.geometry.dispose();
      this.waterMeshes[i] = null;
    }
    const mesh = buildWaterChunkMesh(
      this.world,
      this.water,
      this.light,
      cx,
      cy,
      cz,
      this.chunkSize,
    );
    if (mesh.faceCount === 0) return; // no water in this chunk → no draw call
    const m = new Mesh(geometryFromMesh(mesh), this.waterMaterial);
    this.waterMeshes[i] = m;
    this.waterGroup.add(m);
  }

  /**
   * Rebuild the chunks a block edit at (x, y, z) can have changed — in geometry,
   * gravity, lighting, OR water. First loose blocks settle: `settle` drops any sand/gravel
   * the edit left unsupported, and the moved cells are applied to the world and folded into
   * the remesh union (settle runs BEFORE the light/water recompute so those reflect the fallen
   * blocks). The RGB light and water fields are then each recomputed and diffed against the
   * previous field (all sub-10 ms here). A chunk must remesh if its geometry, a settled cell,
   * the light at a face's open cell, or its water changed — for each such cell that is exactly
   * `chunksAffectedByEdit(cell)`, so we union it over the edit and every changed cell, then
   * rebuild both meshes there.
   */
  rebuildAround(x: number, y: number, z: number): void {
    // Gravity: settle loose blocks the edit may have unsupported, apply the moves in place,
    // and record the changed cells so their chunks remesh too.
    const settled = settle(this.world);
    const gravityChanged: number[] = [];
    for (let i = 0; i < this.world.volume; i++)
      if (settled.data[i] !== this.world.data[i]) {
        gravityChanged.push(i);
        this.world.data[i] = settled.data[i];
      }

    const nextLight = computeLightRGB(this.world);
    const lightChanged: number[] = [];
    for (let i = 0; i < this.world.volume; i++)
      if (
        nextLight.r[i] !== this.light.r[i] ||
        nextLight.g[i] !== this.light.g[i] ||
        nextLight.b[i] !== this.light.b[i]
      )
        lightChanged.push(i);
    this.light = nextLight;

    const next = computeWater(this.world);
    const waterChanged: number[] = [];
    for (let i = 0; i < next.length; i++) if (next[i] !== this.water[i]) waterChanged.push(i);
    this.water = next;

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
    const considerIndex = (i: number): void =>
      consider(i % sizeX, Math.floor(i / (sizeX * sizeZ)), Math.floor(i / sizeX) % sizeZ);

    consider(x, y, z); // the geometry edit itself
    for (const i of gravityChanged) considerIndex(i);
    for (const i of lightChanged) considerIndex(i);
    for (const i of waterChanged) considerIndex(i);

    for (const [cx, cy, cz] of toBuild) {
      this.buildChunk(cx, cy, cz);
      this.buildWaterChunk(cx, cy, cz);
    }
  }
}
