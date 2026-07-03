/**
 * Renders a World as a grid of per-chunk meshes so a block edit rebuilds only
 * the chunk(s) it touches, not the whole world. Each chunk has THREE meshes: the
 * opaque terrain (solid blocks), the translucent water surface, and the opaque
 * lava surface, in separate groups so each fluid draws in its own pass.
 *
 * This is thin Three.js wiring — all the real logic (which cells a chunk owns,
 * how seams are culled, which chunks an edit affects, light + fluid fields, the
 * gravity/reaction world rules) lives in the oracle-tested core (`mesher.ts`,
 * `light.ts`, `water.ts`, `lava.ts`, `fluidMesh.ts`, `gravity.ts`, `reaction.ts`).
 * The round-trip is pinned by `chunkedTerrain.test.ts`; the look by the smoke test.
 */

import { Group, Mesh, type Material } from "three";
import type { World } from "../core/world";
import { buildGreedyChunkMesh, chunkDims, chunksAffectedByEdit, CHUNK_SIZE } from "../core/mesher";
import { computeLightRGB, type EmissiveField, type RGBLight } from "../core/light";
import { computeWater } from "../core/water";
import { computeLava } from "../core/lava";
import { Block, emissionOf, emissionColorOf } from "../core/blocks";
import { settle } from "../core/gravity";
import { reactFully } from "../core/reaction";
import { buildFluidChunkMesh } from "../core/fluidMesh";
import { geometryFromMesh } from "./chunkGeometry";

export class ChunkedTerrain {
  /** Opaque terrain meshes (add to the scene). */
  readonly group = new Group();
  /** Translucent water meshes (add to the scene; drawn in its own alpha pass). */
  readonly waterGroup = new Group();
  /** Opaque lava meshes (add to the scene; the molten surface of the lava field). */
  readonly lavaGroup = new Group();

  private readonly dims: { nx: number; ny: number; nz: number };
  private readonly meshes: (Mesh | null)[]; // one terrain slot per chunk; null = empty
  private readonly waterMeshes: (Mesh | null)[]; // one water slot per chunk; null = no water
  private readonly lavaMeshes: (Mesh | null)[]; // one lava slot per chunk; null = no lava
  // Combined RGB light + the water and lava presence fields, each recomputed and diffed
  // per edit (all sub-10 ms on this world, so the per-edit recompute is imperceptible —
  // see the incremental discussion in #86). The mesher dims faces by `light`; the water
  // mesh is built from `water` and shaded by `light`. The lava field is fed into the
  // light recompute as an emissive field (the whole tongue glows, #114) and drives the
  // observer's Lava medium (`lavaField`).
  private light: RGBLight;
  private water: Uint8Array;
  private lava: Uint8Array;

  constructor(
    private readonly world: World,
    private readonly material: Material,
    private readonly waterMaterial: Material,
    private readonly lavaMaterial: Material,
    private readonly chunkSize: number = CHUNK_SIZE,
  ) {
    this.dims = chunkDims(world, chunkSize);
    const n = this.dims.nx * this.dims.ny * this.dims.nz;
    this.meshes = new Array(n).fill(null);
    this.waterMeshes = new Array(n).fill(null);
    this.lavaMeshes = new Array(n).fill(null);
    this.lava = computeLava(world); // before light: the glow seeds from this field
    this.light = computeLightRGB(world, this.lavaGlow());
    this.water = computeWater(world);
    for (let cy = 0; cy < this.dims.ny; cy++)
      for (let cz = 0; cz < this.dims.nz; cz++)
        for (let cx = 0; cx < this.dims.nx; cx++) {
          this.buildChunk(cx, cy, cz);
          this.buildWaterChunk(cx, cy, cz);
          this.buildLavaChunk(cx, cy, cz);
        }
  }

  /** The current water presence field (0/1), for player physics (submersion). */
  get waterField(): Uint8Array {
    return this.water;
  }

  /** The current lava presence field (0/1), for the observer's medium (atmosphere). */
  get lavaField(): Uint8Array {
    return this.lava;
  }

  /** The lava field as an emissive light field, glowing with Block.Lava's registry values. */
  private lavaGlow(): EmissiveField {
    return {
      field: this.lava,
      emission: emissionOf(Block.Lava),
      color: emissionColorOf(Block.Lava),
    };
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
    const mesh = buildFluidChunkMesh(
      this.world,
      this.water,
      this.light,
      Block.Water,
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

  /** (Re)build a chunk's opaque lava mesh, disposing whatever was there before. */
  private buildLavaChunk(cx: number, cy: number, cz: number): void {
    const i = this.slot(cx, cy, cz);
    const old = this.lavaMeshes[i];
    if (old) {
      this.lavaGroup.remove(old);
      old.geometry.dispose();
      this.lavaMeshes[i] = null;
    }
    const mesh = buildFluidChunkMesh(
      this.world,
      this.lava,
      this.light,
      Block.Lava,
      cx,
      cy,
      cz,
      this.chunkSize,
    );
    if (mesh.faceCount === 0) return; // no lava in this chunk → no draw call
    const m = new Mesh(geometryFromMesh(mesh), this.lavaMaterial);
    this.lavaMeshes[i] = m;
    this.lavaGroup.add(m);
  }

  /**
   * Rebuild the chunks a block edit at (x, y, z) can have changed — in geometry,
   * gravity, reaction, lighting, water, OR lava. First loose blocks settle: `settle` drops
   * any sand/gravel the edit left unsupported, and the moved cells are applied to the world
   * and folded into the remesh union (settle runs BEFORE the field recomputes so those
   * reflect the fallen blocks). Then the water↔lava REACTION runs to quiescence
   * (`reactFully`: lava touched by water turns to obsidian/stone — a world mutation, like
   * settle). The lava field is recomputed next — BEFORE light, whose emissive glow seeds
   * from it — then the RGB light and water fields, each diffed against the previous field
   * (all sub-10 ms here). A chunk must remesh if its geometry, a settled or reacted cell,
   * the light at a face's open cell, its water, or its lava changed — for each such cell
   * that is exactly `chunksAffectedByEdit(cell)`, so we union it over the edit and every
   * changed cell, then rebuild all three meshes there. Returns the coordinates of the
   * cells the REACTION converted, so the shell can play a quench effect at them.
   */
  rebuildAround(x: number, y: number, z: number): [number, number, number][] {
    // Gravity: settle loose blocks the edit may have unsupported, apply the moves in place,
    // and record the changed cells so their chunks remesh too.
    const settled = settle(this.world);
    const gravityChanged: number[] = [];
    for (let i = 0; i < this.world.volume; i++)
      if (settled.data[i] !== this.world.data[i]) {
        gravityChanged.push(i);
        this.world.data[i] = settled.data[i];
      }

    // Reaction: where the edit brought lava and water into contact, rock forms
    // (sources → obsidian, tongues → stone), iterated to quiescence.
    const reacted = reactFully(this.world);
    const reactionChanged: number[] = [];
    for (let i = 0; i < this.world.volume; i++)
      if (reacted.data[i] !== this.world.data[i]) {
        reactionChanged.push(i);
        this.world.data[i] = reacted.data[i];
      }

    const nextLava = computeLava(this.world);
    const lavaChanged: number[] = [];
    for (let i = 0; i < nextLava.length; i++) if (nextLava[i] !== this.lava[i]) lavaChanged.push(i);
    this.lava = nextLava;

    const nextLight = computeLightRGB(this.world, this.lavaGlow());
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
    for (const i of reactionChanged) considerIndex(i);
    for (const i of lavaChanged) considerIndex(i);
    for (const i of lightChanged) considerIndex(i);
    for (const i of waterChanged) considerIndex(i);

    for (const [cx, cy, cz] of toBuild) {
      this.buildChunk(cx, cy, cz);
      this.buildWaterChunk(cx, cy, cz);
      this.buildLavaChunk(cx, cy, cz);
    }

    return reactionChanged.map((i) => [
      i % sizeX,
      Math.floor(i / (sizeX * sizeZ)),
      Math.floor(i / sizeX) % sizeZ,
    ]);
  }
}
