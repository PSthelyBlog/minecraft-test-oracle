/**
 * Face-culled mesh builder.
 *
 * For every block, each of its 6 faces is emitted as a quad ONLY when the
 * neighbour across that face does not hide it — i.e. the neighbour is not
 * opaque (air, glass, water, leaves, or out-of-bounds reveal the face). This is
 * the single biggest perf win in a voxel renderer and a notorious silent bug
 * surface (wrong neighbour, wrong winding, double-counted interior faces), so
 * the per-face census is oracle-tested.
 *
 * Visible faces are also ambient-occluded: each vertex is darkened by how many of
 * the three neighbour voxels touching it are opaque (see `vertexAO`), and the quad
 * is split along the diagonal joining its brighter corners to avoid an interpolation
 * seam. With no occluders this reduces to the old flat per-face shade.
 */

import type { World } from "./world";
import { Block, isOpaque } from "./blocks";
import { tileIndexFor } from "./atlas";

export interface ChunkMesh {
  readonly positions: Float32Array; // xyz per vertex
  readonly normals: Float32Array; // xyz per vertex
  readonly colors: Float32Array; // rgb per vertex — per-face shade × per-vertex AO (greyscale)
  readonly uvs: Float32Array; // st per vertex — TILE-LOCAL [0,1] (a unit quad covers one tile)
  readonly layers: Float32Array; // tile index per vertex — selects the tile (= texture-array layer)
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
  {
    // +X
    normal: [1, 0, 0],
    shade: 0.8,
    corners: [
      [1, 1, 0],
      [1, 1, 1],
      [1, 0, 1],
      [1, 0, 0],
    ],
  },
  {
    // -X
    normal: [-1, 0, 0],
    shade: 0.8,
    corners: [
      [0, 1, 1],
      [0, 1, 0],
      [0, 0, 0],
      [0, 0, 1],
    ],
  },
  {
    // +Y (top, brightest)
    normal: [0, 1, 0],
    shade: 1.0,
    corners: [
      [0, 1, 1],
      [1, 1, 1],
      [1, 1, 0],
      [0, 1, 0],
    ],
  },
  {
    // -Y (bottom, darkest)
    normal: [0, -1, 0],
    shade: 0.5,
    corners: [
      [0, 0, 0],
      [1, 0, 0],
      [1, 0, 1],
      [0, 0, 1],
    ],
  },
  {
    // +Z
    normal: [0, 0, 1],
    shade: 0.9,
    corners: [
      [1, 1, 1],
      [0, 1, 1],
      [0, 0, 1],
      [1, 0, 1],
    ],
  },
  {
    // -Z
    normal: [0, 0, -1],
    shade: 0.9,
    corners: [
      [0, 1, 0],
      [1, 1, 0],
      [1, 0, 0],
      [0, 0, 0],
    ],
  },
];

/**
 * A face of `block` is visible when the neighbour across it does not fully hide
 * it. Out-of-bounds neighbours read as Air (visible). A block never culls
 * against itself-type unless that neighbour is opaque.
 */
/**
 * TILE-LOCAL UV for the 4 corners of every face, in the same winding order as
 * `Face.corners`. (s, t) ∈ {0,1}² are the corners of the single tile the face
 * samples; the tile itself is selected per-vertex by the `layers` channel (the
 * tile index → texture-array layer). A unit quad therefore covers exactly one tile;
 * a future greedy quad spanning N×M cells emits UVs up to (N, M) so the tile repeats.
 * Pinned by the mesher's golden-UV and per-face UV/layer-census oracles.
 */
const FACE_UV: readonly (readonly [number, number])[] = [
  [0, 1],
  [1, 1],
  [1, 0],
  [0, 0],
];

export function isFaceVisible(
  world: World,
  x: number,
  y: number,
  z: number,
  faceIndex: number,
): boolean {
  const f = FACES[faceIndex];
  const nx = x + f.normal[0];
  const ny = y + f.normal[1];
  const nz = z + f.normal[2];
  return !isOpaque(world.get(nx, ny, nz));
}

// ---------------------------------------------------------------------------
// Ambient occlusion — darken a vertex by how many of the three neighbour voxels
// touching it (in the face's open layer) are opaque. Replaces the old flat
// per-face shade with per-vertex shading so corners and crevices read as recessed.
// ---------------------------------------------------------------------------

/**
 * Ambient-occlusion level for a vertex, `0` (darkest) … `3` (brightest), from the
 * three neighbour voxels that touch it in the face's OPEN layer: the two
 * edge-adjacent `side` cells and the diagonal `corner` cell, each `1` if opaque
 * else `0`. The standard voxel-AO rule: if BOTH sides are opaque the vertex is
 * fully occluded regardless of the corner; otherwise it darkens one step per
 * opaque neighbour. Pinned by the AO truth-table and census oracles.
 */
export function vertexAO(side1: number, side2: number, corner: number): number {
  if (side1 && side2) return 0;
  return 3 - (side1 + side2 + corner);
}

/** Brightness multiplier for an AO level: linear from AO_MIN (fully occluded) to 1 (open). */
const AO_MIN = 0.5;
function aoFactor(level: number): number {
  return AO_MIN + ((1 - AO_MIN) * level) / 3;
}

/**
 * AO level for one corner `c` of `face` on the block at (x, y, z). The occluders
 * live in the face's open neighbour cell (x,y,z)+normal; the two tangent axes are
 * the non-face axes, and the corner's 0/1 offset along each picks the −/+ side to
 * sample. Returns `vertexAO` of the two side cells and the diagonal corner cell.
 */
function cornerAO(
  world: World,
  x: number,
  y: number,
  z: number,
  face: Face,
  c: readonly [number, number, number],
): number {
  const n = face.normal;
  const faceAxis = n[0] !== 0 ? 0 : n[1] !== 0 ? 1 : 2;
  // The open cell this face looks into (guaranteed non-opaque: the face is visible).
  const bx = x + n[0],
    by = y + n[1],
    bz = z + n[2];
  const [u, v] = faceAxis === 0 ? [1, 2] : faceAxis === 1 ? [0, 2] : [0, 1];
  // Unit step along each tangent axis toward this corner's side (c[axis] 1 → +, 0 → −).
  const su: [number, number, number] = [0, 0, 0];
  const sv: [number, number, number] = [0, 0, 0];
  su[u] = c[u] === 1 ? 1 : -1;
  sv[v] = c[v] === 1 ? 1 : -1;
  const occ = (ox: number, oy: number, oz: number) =>
    isOpaque(world.get(bx + ox, by + oy, bz + oz)) ? 1 : 0;
  const side1 = occ(su[0], su[1], su[2]);
  const side2 = occ(sv[0], sv[1], sv[2]);
  const corner = occ(su[0] + sv[0], su[1] + sv[1], su[2] + sv[2]);
  return vertexAO(side1, side2, corner);
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
        const id = world.get(x, y, z);
        if (id === Block.Air) continue;

        for (let fi = 0; fi < FACES.length; fi++) {
          if (!isFaceVisible(world, x, y, z, fi)) continue;
          const f = FACES[fi];
          const layer = tileIndexFor(id, fi);
          const baseVertex = positions.length / 3;

          const levels: number[] = [];
          for (let k = 0; k < 4; k++) {
            const c = f.corners[k];
            positions.push(x + c[0], y + c[1], z + c[2]);
            normals.push(f.normal[0], f.normal[1], f.normal[2]);
            // Vertex colour = the block's atlas texel × this shade. The shade is the
            // face's flat directional shade modulated by per-vertex ambient occlusion,
            // so an unoccluded vertex keeps exactly the old per-face value (AO level 3).
            const level = cornerAO(world, x, y, z, f, c);
            levels.push(level);
            const shade = f.shade * aoFactor(level);
            colors.push(shade, shade, shade);
            // Tile-local UV: the 4 corners map straight onto the unit tile [0,1]²;
            // the tile is chosen per-vertex by `layer`. (A greedy quad would scale s,t.)
            const [s, t] = FACE_UV[k];
            uvs.push(s, t);
            layers.push(layer);
          }

          // Two triangles. Split along the diagonal joining the two BRIGHTER corners
          // so the dark pair doesn't bleed across the shared edge (the classic AO
          // anisotropy fix). Default diagonal 0–2; flip to 1–3 when that pair is
          // brighter. Both triangulations stay CCW-outward; only `indices` reorders.
          if (levels[0] + levels[2] < levels[1] + levels[3]) {
            indices.push(
              baseVertex + 1,
              baseVertex + 2,
              baseVertex + 3,
              baseVertex + 1,
              baseVertex + 3,
              baseVertex,
            );
          } else {
            indices.push(
              baseVertex,
              baseVertex + 1,
              baseVertex + 2,
              baseVertex,
              baseVertex + 2,
              baseVertex + 3,
            );
          }
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
export function chunkDims(
  world: World,
  chunkSize: number = CHUNK_SIZE,
): { nx: number; ny: number; nz: number } {
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
  cx: number,
  cy: number,
  cz: number,
  chunkSize: number = CHUNK_SIZE,
): ChunkMesh {
  const x0 = cx * chunkSize;
  const y0 = cy * chunkSize;
  const z0 = cz * chunkSize;
  return meshRange(
    world,
    x0,
    y0,
    z0,
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
  x: number,
  y: number,
  z: number,
  chunkSize: number = CHUNK_SIZE,
): [number, number, number][] {
  // The cell itself plus its 6 axis-neighbours. This list is symmetric (each axis
  // appears as both +1 and -1), so computing a neighbour as `coord - delta` instead
  // of `coord + delta` yields the SAME set — those sign mutants are equivalent and
  // unkillable (documented in docs/TESTING.md), which is fine: only the resulting
  // chunk set matters here, not the visiting order.
  const offsets: readonly [number, number, number][] = [
    [0, 0, 0],
    [1, 0, 0],
    [-1, 0, 0],
    [0, 1, 0],
    [0, -1, 0],
    [0, 0, 1],
    [0, 0, -1],
  ];
  const seen = new Set<string>();
  const out: [number, number, number][] = [];
  for (const [dx, dy, dz] of offsets) {
    const px = x + dx,
      py = y + dy,
      pz = z + dz;
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
