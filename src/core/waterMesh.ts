/**
 * Water mesh builder — the translucent counterpart of the terrain mesher.
 *
 * Water is a derived LEVEL field (see `water.ts`), not stored blocks, so it gets its
 * own geometry pass drawn in a transparent material. A water cell (level > 0) emits a
 * full unit cube; a face is shown only where the neighbour across it is open air to
 * look through — i.e. no water there and not opaque — so water-vs-water faces and faces
 * buried against rock are culled, leaving just the visible surface of each body.
 *
 * Faces share the terrain mesher's winding-verified `FACES`/`FACE_UV` tables and the
 * water atlas tile, and are shaded `faceShade × lightFactor(light)` (no AO — a fluid
 * surface needs no corner darkening). This is oracle-tested against an independent
 * "where the visible water faces are" census, the shade, and the outward winding.
 */

import type { World } from "./world";
import { Block, isOpaque } from "./blocks";
import { tileIndexFor } from "./atlas";
import { MAX_LIGHT } from "./light";
import { FACES, FACE_UV, lightFactor, CHUNK_SIZE, type ChunkMesh } from "./mesher";

/** Water level at a cell, with out-of-bounds (the world edge) reading as dry. */
function waterAt(water: Uint8Array, world: World, x: number, y: number, z: number): number {
  if (!world.inBounds(x, y, z)) return 0;
  return water[world.index(x, y, z)];
}

/** Light at a cell for shading, with out-of-bounds (open sky) reading as full light. */
function lightAt(light: Uint8Array, world: World, x: number, y: number, z: number): number {
  if (!world.inBounds(x, y, z)) return MAX_LIGHT;
  return light[world.index(x, y, z)];
}

/**
 * A water cell's face (in direction `fi`) is visible iff the neighbour across it is
 * open air to see through: it holds no water AND is not opaque. (Out of bounds reads
 * as dry, non-opaque air, so the world-edge face shows — like the solid mesher.)
 */
export function isWaterFaceVisible(
  world: World,
  water: Uint8Array,
  x: number,
  y: number,
  z: number,
  fi: number,
): boolean {
  const n = FACES[fi].normal;
  const nx = x + n[0],
    ny = y + n[1],
    nz = z + n[2];
  if (waterAt(water, world, nx, ny, nz) > 0) return false; // neighbour is water → internal face
  if (isOpaque(world.get(nx, ny, nz))) return false; // neighbour is rock → buried face
  return true;
}

/**
 * Mesh the water in the half-open box [x0,x1) × [y0,y1) × [z0,z1). Like the terrain
 * mesher, it iterates only the box's cells but reads neighbours from the full world +
 * water field, so per-chunk water meshes are seam-correct. Vertices are world-space.
 */
function meshWaterRange(
  world: World,
  water: Uint8Array,
  light: Uint8Array,
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
        if (water[world.index(x, y, z)] === 0) continue; // no water in this cell

        for (let fi = 0; fi < FACES.length; fi++) {
          if (!isWaterFaceVisible(world, water, x, y, z, fi)) continue;
          const f = FACES[fi];
          const layer = tileIndexFor(Block.Water, fi);
          // Shade by the open cell the face looks into (same convention as solid faces).
          const lf = lightFactor(lightAt(light, world, x + f.normal[0], y + f.normal[1], z + f.normal[2])); // prettier-ignore
          const shade = f.shade * lf;
          const base = positions.length / 3;
          for (let k = 0; k < 4; k++) {
            const c = f.corners[k];
            positions.push(x + c[0], y + c[1], z + c[2]);
            normals.push(f.normal[0], f.normal[1], f.normal[2]);
            colors.push(shade, shade, shade);
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

/** Whole-world water mesh (the oracle reference the per-chunk union is checked against). */
export function buildWaterMesh(world: World, water: Uint8Array, light: Uint8Array): ChunkMesh {
  return meshWaterRange(world, water, light, 0, 0, 0, world.sizeX, world.sizeY, world.sizeZ);
}

/** Water mesh for a single chunk (culling/shading against the full world, so seam-correct). */
export function buildWaterChunkMesh(
  world: World,
  water: Uint8Array,
  light: Uint8Array,
  cx: number,
  cy: number,
  cz: number,
  chunkSize: number = CHUNK_SIZE,
): ChunkMesh {
  const x0 = cx * chunkSize;
  const y0 = cy * chunkSize;
  const z0 = cz * chunkSize;
  return meshWaterRange(
    world,
    water,
    light,
    x0,
    y0,
    z0,
    Math.min(x0 + chunkSize, world.sizeX),
    Math.min(y0 + chunkSize, world.sizeY),
    Math.min(z0 + chunkSize, world.sizeZ),
  );
}
