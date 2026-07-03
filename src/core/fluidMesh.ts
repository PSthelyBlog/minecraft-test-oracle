/**
 * Fluid mesh builder — the fluid-surface counterpart of the terrain mesher,
 * parameterised over WHICH fluid (water's or lava's presence field + block tile).
 *
 * A fluid is a derived PRESENCE field (0/1, see `water.ts` / `lava.ts`), not stored
 * blocks, so it gets its own geometry pass (water drawn translucent, lava opaque). A
 * fluid cell emits a full unit cube; a face is shown only where the neighbour across
 * it is open air to look through — i.e. not in the SAME field and not opaque — so
 * fluid-vs-same-fluid faces and faces buried against rock are culled, leaving just
 * the visible surface of each body. (The two fluids cull independently: where they
 * transiently overlap pre-reaction, each still draws its own surface.)
 *
 * Faces share the terrain mesher's winding-verified `FACES`/`FACE_UV` tables and the
 * fluid block's atlas tile, and are shaded per channel `faceShade × lightFactor(light_c)`
 * (no AO — a fluid surface needs no corner darkening). This is oracle-tested against an
 * independent "where the visible fluid faces are" census, the shade, and outward
 * winding — run for BOTH fluids.
 */

import type { World } from "./world";
import { type BlockId, isOpaque } from "./blocks";
import { tileIndexFor } from "./atlas";
import { MAX_LIGHT, type RGBLight } from "./light";
import { FACES, FACE_UV, lightFactor, CHUNK_SIZE, type ChunkMesh } from "./mesher";

/** Fluid presence at a cell, with out-of-bounds (the world edge) reading as dry. */
function fluidAt(field: Uint8Array, world: World, x: number, y: number, z: number): number {
  if (!world.inBounds(x, y, z)) return 0;
  return field[world.index(x, y, z)];
}

/** RGB light at a cell for shading, with out-of-bounds (open sky) reading as full light. */
function lightAt(
  light: RGBLight,
  world: World,
  x: number,
  y: number,
  z: number,
): [number, number, number] {
  if (!world.inBounds(x, y, z)) return [MAX_LIGHT, MAX_LIGHT, MAX_LIGHT];
  const i = world.index(x, y, z);
  return [light.r[i], light.g[i], light.b[i]];
}

/**
 * A fluid cell's face (in direction `fi`) is visible iff the neighbour across it is
 * open air to see through: it is not in the same field AND is not opaque. (Out of
 * bounds reads as dry, non-opaque air, so the world-edge face shows — like the solid
 * mesher.)
 */
export function isFluidFaceVisible(
  world: World,
  field: Uint8Array,
  x: number,
  y: number,
  z: number,
  fi: number,
): boolean {
  const n = FACES[fi].normal;
  const nx = x + n[0],
    ny = y + n[1],
    nz = z + n[2];
  if (fluidAt(field, world, nx, ny, nz) > 0) return false; // neighbour is the same fluid → internal face
  if (isOpaque(world.get(nx, ny, nz))) return false; // neighbour is rock → buried face
  return true;
}

/**
 * Mesh the fluid in the half-open box [x0,x1) × [y0,y1) × [z0,z1). Like the terrain
 * mesher, it iterates only the box's cells but reads neighbours from the full world +
 * field, so per-chunk fluid meshes are seam-correct. Vertices are world-space; every
 * face samples the fluid block's tile.
 */
function meshFluidRange(
  world: World,
  field: Uint8Array,
  light: RGBLight,
  block: BlockId,
  x0: number,
  y0: number,
  z0: number,
  x1: number,
  y1: number,
  z1: number,
): ChunkMesh {
  const positions: number[] = [];
  const normals: number[] = [];
  const colors: number[] = [];
  const uvs: number[] = [];
  const layers: number[] = [];
  const indices: number[] = [];
  let faceCount = 0;

  for (let y = y0; y < y1; y++) {
    for (let z = z0; z < z1; z++) {
      for (let x = x0; x < x1; x++) {
        if (field[world.index(x, y, z)] === 0) continue; // no fluid in this cell

        for (let fi = 0; fi < FACES.length; fi++) {
          if (!isFluidFaceVisible(world, field, x, y, z, fi)) continue;
          const f = FACES[fi];
          const layer = tileIndexFor(block, fi);
          // Shade by the RGB light at the open cell the face looks into (same convention
          // as solid faces), per channel — no AO (a fluid surface needs no corner darkening).
          const [lr, lg, lb] = lightAt(light, world, x + f.normal[0], y + f.normal[1], z + f.normal[2]); // prettier-ignore
          const shadeR = f.shade * lightFactor(lr);
          const shadeG = f.shade * lightFactor(lg);
          const shadeB = f.shade * lightFactor(lb);
          const base = positions.length / 3;
          for (let k = 0; k < 4; k++) {
            const c = f.corners[k];
            positions.push(x + c[0], y + c[1], z + c[2]);
            normals.push(f.normal[0], f.normal[1], f.normal[2]);
            colors.push(shadeR, shadeG, shadeB);
            uvs.push(FACE_UV[k][0], FACE_UV[k][1]);
            layers.push(layer);
          }
          // Two outward-wound triangles (FACES corners are CCW-outward; no AO so the
          // default 0–2 diagonal is fine).
          indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
          faceCount++;
        }
      }
    }
  }

  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    colors: new Float32Array(colors),
    uvs: new Float32Array(uvs),
    layers: new Float32Array(layers),
    indices: new Uint32Array(indices),
    faceCount,
  };
}

/** Whole-world fluid mesh (the oracle reference the per-chunk union is checked against). */
export function buildFluidMesh(
  world: World,
  field: Uint8Array,
  light: RGBLight,
  block: BlockId,
): ChunkMesh {
  return meshFluidRange(world, field, light, block, 0, 0, 0, world.sizeX, world.sizeY, world.sizeZ);
}

/** Fluid mesh for a single chunk (culling/shading against the full world, so seam-correct). */
export function buildFluidChunkMesh(
  world: World,
  field: Uint8Array,
  light: RGBLight,
  block: BlockId,
  cx: number,
  cy: number,
  cz: number,
  chunkSize: number = CHUNK_SIZE,
): ChunkMesh {
  const x0 = cx * chunkSize;
  const y0 = cy * chunkSize;
  const z0 = cz * chunkSize;
  return meshFluidRange(
    world,
    field,
    light,
    block,
    x0,
    y0,
    z0,
    Math.min(x0 + chunkSize, world.sizeX),
    Math.min(y0 + chunkSize, world.sizeY),
    Math.min(z0 + chunkSize, world.sizeZ),
  );
}
