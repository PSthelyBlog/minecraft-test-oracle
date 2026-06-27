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
import { Block, isOpaque } from "./blocks";
import { tileIndexFor, uvRectForTile } from "./atlas";

export interface ChunkMesh {
  readonly positions: Float32Array; // xyz per vertex
  readonly normals: Float32Array; // xyz per vertex
  readonly colors: Float32Array; // rgb per vertex — per-face ambient shade (greyscale)
  readonly uvs: Float32Array; // st per vertex — into the texture atlas
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
/**
 * UV multipliers for the 4 corners of every face, in the same winding order as
 * `Face.corners`. (s, t) ∈ {0,1}² selects a corner of the face's atlas tile, so the
 * quad's corners 0..3 map to (u0,v1), (u1,v1), (u1,v0), (u0,v0). Pinned by the
 * mesher's golden-UV and per-face UV-census oracles.
 */
const FACE_UV: readonly (readonly [number, number])[] = [
  [0, 1], [1, 1], [1, 0], [0, 0],
];

export function isFaceVisible(world: World, x: number, y: number, z: number, faceIndex: number): boolean {
  const f = FACES[faceIndex];
  const nx = x + f.normal[0];
  const ny = y + f.normal[1];
  const nz = z + f.normal[2];
  return !isOpaque(world.get(nx, ny, nz));
}

/**
 * Mesh the cells in the half-open box [x0,x1) × [y0,y1) × [z0,z1).
 *
 * Crucially, face culling still reads neighbours from the *full* `world` (via
 * `world.get`, which returns Air out of bounds) — so a face on the box's border
 * is culled by the real block in the adjacent box, not treated as exposed. This
 * is what makes per-chunk meshing seamless: `buildMesh` is just the whole-world
 * box, and `buildChunkMesh` is one chunk's box, sharing this exact emission path.
 *
 * Vertices are emitted in WORLD coordinates, so every range's geometry sits in
 * the same space and can be uploaded at the origin.
 */
function meshRange(
  world: World,
  x0: number, y0: number, z0: number,
  x1: number, y1: number, z1: number,
): ChunkMesh {
  const positions: number[] = [];
  const normals: number[] = [];
  const colors: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  let faceCount = 0;

  for (let y = y0; y < y1; y++) {
    for (let z = z0; z < z1; z++) {
      for (let x = x0; x < x1; x++) {
        const id = world.get(x, y, z);
        if (id === Block.Air) continue;

        for (let fi = 0; fi < FACES.length; fi++) {
          if (!isFaceVisible(world, x, y, z, fi)) continue;
          const f = FACES[fi];
          const r = uvRectForTile(tileIndexFor(id, fi));
          const baseVertex = positions.length / 3;

          for (let k = 0; k < 4; k++) {
            const c = f.corners[k];
            positions.push(x + c[0], y + c[1], z + c[2]);
            normals.push(f.normal[0], f.normal[1], f.normal[2]);
            // Vertex colour carries only the per-face ambient shade now; the block's
            // colour comes from the sampled atlas texel (texel × shade).
            colors.push(f.shade, f.shade, f.shade);
            // Map the 4 corners (in winding order) onto the tile's 4 UV corners.
            const [s, t] = FACE_UV[k];
            uvs.push(r.u0 + s * (r.u1 - r.u0), r.v0 + t * (r.v1 - r.v0));
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
    uvs: new Float32Array(uvs),
    indices: new Uint32Array(indices),
    faceCount,
  };
}

/** Mesh the whole world in one geometry (fine up to ~100³; larger worlds chunk). */
export function buildMesh(world: World): ChunkMesh {
  return meshRange(world, 0, 0, 0, world.sizeX, world.sizeY, world.sizeZ);
}

// ---------------------------------------------------------------------------
// Chunked meshing — split a large world into fixed cubes so an edit rebuilds
// only the affected chunk(s) instead of the entire world.
// ---------------------------------------------------------------------------

/** Edge length of a chunk, in cells. */
export const CHUNK_SIZE = 16;

/** Number of chunks along each axis to cover the world (the last one may be partial). */
export function chunkDims(world: World, chunkSize: number = CHUNK_SIZE): { nx: number; ny: number; nz: number } {
  return {
    nx: Math.ceil(world.sizeX / chunkSize),
    ny: Math.ceil(world.sizeY / chunkSize),
    nz: Math.ceil(world.sizeZ / chunkSize),
  };
}

/**
 * Mesh a single chunk at chunk-coordinate (cx, cy, cz). Iterates only that
 * chunk's cells (clamped to the world's edge for the last, partial chunk) but
 * culls against the full world, so chunk seams are face-culled correctly.
 * The chunks tile the world exactly, so summing every chunk's faceCount
 * reproduces `buildMesh(world).faceCount` — pinned by the census oracle.
 */
export function buildChunkMesh(
  world: World,
  cx: number, cy: number, cz: number,
  chunkSize: number = CHUNK_SIZE,
): ChunkMesh {
  const x0 = cx * chunkSize;
  const y0 = cy * chunkSize;
  const z0 = cz * chunkSize;
  return meshRange(
    world,
    x0, y0, z0,
    Math.min(x0 + chunkSize, world.sizeX),
    Math.min(y0 + chunkSize, world.sizeY),
    Math.min(z0 + chunkSize, world.sizeZ),
  );
}

/**
 * The chunks whose mesh can change when the block at (x, y, z) is edited: the
 * cell's own chunk, plus the chunk of each of its 6 axis-neighbours (which
 * differs only when the cell sits on a chunk border). A neighbour's visible
 * faces depend on this cell's opacity, so its chunk must be rebuilt too —
 * otherwise the seam goes stale. Out-of-bounds neighbours are omitted; the list
 * is deduplicated. The render layer rebuilds exactly this set.
 */
export function chunksAffectedByEdit(
  world: World,
  x: number, y: number, z: number,
  chunkSize: number = CHUNK_SIZE,
): [number, number, number][] {
  // The cell itself plus its 6 axis-neighbours. This list is symmetric (each axis
  // appears as both +1 and -1), so computing a neighbour as `coord - delta` instead
  // of `coord + delta` yields the SAME set — those sign mutants are equivalent and
  // unkillable (documented in docs/TESTING.md), which is fine: only the resulting
  // chunk set matters here, not the visiting order.
  const offsets: readonly [number, number, number][] = [
    [0, 0, 0], [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1],
  ];
  const seen = new Set<string>();
  const out: [number, number, number][] = [];
  for (const [dx, dy, dz] of offsets) {
    const px = x + dx, py = y + dy, pz = z + dz;
    if (!world.inBounds(px, py, pz)) continue; // a neighbour outside the world has no chunk
    const cx = Math.floor(px / chunkSize);
    const cy = Math.floor(py / chunkSize);
    const cz = Math.floor(pz / chunkSize);
    const key = `${cx},${cy},${cz}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push([cx, cy, cz]);
  }
  return out;
}
