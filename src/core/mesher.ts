/**
 * Face-culled mesh builder.
 *
 * For every block, each of its 6 faces is emitted as a quad ONLY when the
 * neighbour across that face does not hide it — i.e. the neighbour is not
 * opaque (air, glass, water, leaves, or out-of-bounds reveal the face). This is
 * the single biggest perf win in a voxel renderer and a notorious silent bug
 * surface (wrong neighbour, wrong winding, double-counted interior faces), so
 * the per-face census is oracle-tested.
 */

import type { World } from "./world";
import { Block, blockDef, isOpaque } from "./blocks";

export interface ChunkMesh {
  readonly positions: Float32Array; // xyz per vertex
  readonly normals: Float32Array; // xyz per vertex
  readonly colors: Float32Array; // rgb per vertex
  readonly indices: Uint32Array; // two triangles per quad
  /** Number of quads (visible faces) emitted. */
  readonly faceCount: number;
}

/** The 6 face directions and the unit quad. */
interface Face {
  readonly normal: readonly [number, number, number];
  /**
   * 4 corner offsets, ordered counter-clockwise as seen from OUTSIDE the block,
   * so the fan (0,1,2)/(0,2,3) faces outward (front-facing under default CCW
   * winding). Verified by the mesher winding oracle.
   */
  readonly corners: readonly (readonly [number, number, number])[];
  /** Ambient shade applied to this face (cheap fake lighting). */
  readonly shade: number;
}

const FACES: readonly Face[] = [
  { // +X
    normal: [1, 0, 0], shade: 0.8,
    corners: [[1, 1, 0], [1, 1, 1], [1, 0, 1], [1, 0, 0]],
  },
  { // -X
    normal: [-1, 0, 0], shade: 0.8,
    corners: [[0, 1, 1], [0, 1, 0], [0, 0, 0], [0, 0, 1]],
  },
  { // +Y (top, brightest)
    normal: [0, 1, 0], shade: 1.0,
    corners: [[0, 1, 1], [1, 1, 1], [1, 1, 0], [0, 1, 0]],
  },
  { // -Y (bottom, darkest)
    normal: [0, -1, 0], shade: 0.5,
    corners: [[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]],
  },
  { // +Z
    normal: [0, 0, 1], shade: 0.9,
    corners: [[1, 1, 1], [0, 1, 1], [0, 0, 1], [1, 0, 1]],
  },
  { // -Z
    normal: [0, 0, -1], shade: 0.9,
    corners: [[0, 1, 0], [1, 1, 0], [1, 0, 0], [0, 0, 0]],
  },
];

/**
 * A face of `block` is visible when the neighbour across it does not fully hide
 * it. Out-of-bounds neighbours read as Air (visible). A block never culls
 * against itself-type unless that neighbour is opaque.
 */
export function isFaceVisible(world: World, x: number, y: number, z: number, faceIndex: number): boolean {
  const f = FACES[faceIndex];
  const nx = x + f.normal[0];
  const ny = y + f.normal[1];
  const nz = z + f.normal[2];
  return !isOpaque(world.get(nx, ny, nz));
}

export function buildMesh(world: World): ChunkMesh {
  const positions: number[] = [];
  const normals: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];
  let faceCount = 0;

  for (let y = 0; y < world.sizeY; y++) {
    for (let z = 0; z < world.sizeZ; z++) {
      for (let x = 0; x < world.sizeX; x++) {
        const id = world.get(x, y, z);
        if (id === Block.Air) continue;
        const def = blockDef(id);

        for (let fi = 0; fi < FACES.length; fi++) {
          if (!isFaceVisible(world, x, y, z, fi)) continue;
          const f = FACES[fi];
          const baseVertex = positions.length / 3;

          for (const c of f.corners) {
            positions.push(x + c[0], y + c[1], z + c[2]);
            normals.push(f.normal[0], f.normal[1], f.normal[2]);
            colors.push(def.color[0] * f.shade, def.color[1] * f.shade, def.color[2] * f.shade);
          }

          // Two triangles: (0,1,2) and (0,2,3).
          indices.push(
            baseVertex, baseVertex + 1, baseVertex + 2,
            baseVertex, baseVertex + 2, baseVertex + 3,
          );
          faceCount++;
        }
      }
    }
  }

  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    colors: new Float32Array(colors),
    indices: new Uint32Array(indices),
    faceCount,
  };
}
