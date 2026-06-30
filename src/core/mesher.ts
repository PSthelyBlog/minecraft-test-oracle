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
 *
 * Finally, faces are LIGHT-aware in COLOUR: each face is dimmed per channel by the
 * propagated RGB light (`computeLightRGB`) sampled at the open cell it looks into, via
 * `lightFactor`. The light field is passed in (computed by `core/light.ts`); when it is
 * omitted every channel's factor is 1, so the mesh is byte-identical to the unlit one —
 * and a grey (uncoloured) field reproduces the old greyscale colour exactly. Light is a
 * strict extension of the shade × AO colour, exactly as AO extended the flat shade. The
 * final per-channel vertex colour is `texel × faceShade × AO × light_c`; the greedy merge
 * key includes the RGB triple, so faces only merge when all three channels match.
 */

import type { World } from "./world";
import { Block, isOpaque, type BlockId } from "./blocks";
import { tileIndexFor } from "./atlas";
import { MAX_LIGHT, type RGBLight } from "./light";

/**
 * Whether a block contributes geometry to the OPAQUE terrain mesh. Air is empty;
 * Water is non-empty but drawn separately as a translucent fluid (see `waterMesh.ts`),
 * so the terrain mesher skips both. Water stays non-opaque, so it still reveals the
 * faces of solid blocks behind it — you see the lakebed through it.
 */
export function rendersInTerrain(id: BlockId): boolean {
  return id !== Block.Air && id !== Block.Water;
}

export interface ChunkMesh {
  readonly positions: Float32Array; // xyz per vertex
  readonly normals: Float32Array; // xyz per vertex
  readonly colors: Float32Array; // rgb per vertex — per-face shade × per-vertex AO × per-channel light
  readonly uvs: Float32Array; // st per vertex — TILE-LOCAL [0,1] (a unit quad covers one tile)
  readonly layers: Float32Array; // tile index per vertex — selects the tile (= texture-array layer)
  readonly indices: Uint32Array; // two triangles per quad
  /** Number of quads (visible faces) emitted. */
  readonly faceCount: number;
}

/** The 6 face directions and the unit quad. */
export interface Face {
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

export const FACES: readonly Face[] = [
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
export const FACE_UV: readonly (readonly [number, number])[] = [
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

/** Brightness floor for a fully-dark cell — caves stay dark but never pure black. */
export const LIGHT_MIN = 0.12;
/**
 * Brightness multiplier for a light level `0..MAX_LIGHT`: linear from `LIGHT_MIN`
 * (fully dark) to `1` at full light, so a fully-lit face keeps exactly its
 * shade × AO colour and lighting only ever darkens. Mirrors `aoFactor`.
 */
export function lightFactor(level: number): number {
  return LIGHT_MIN + ((1 - LIGHT_MIN) * level) / MAX_LIGHT;
}

/**
 * RGB light levels at cell (x,y,z) for face shading, each `0..MAX_LIGHT`. A face is
 * dimmed by the light in the OPEN cell it looks into. When no light field is supplied,
 * or the cell is out of bounds (the world edge reads as open sky), every channel is full
 * light — so each factor is `1` and the colour is unchanged (the unlit/uncoloured path).
 */
function lightAt(
  light: RGBLight | undefined,
  world: World,
  x: number,
  y: number,
  z: number,
): [number, number, number] {
  if (!light) return [MAX_LIGHT, MAX_LIGHT, MAX_LIGHT];
  if (!world.inBounds(x, y, z)) return [MAX_LIGHT, MAX_LIGHT, MAX_LIGHT];
  const i = world.index(x, y, z);
  return [light.r[i], light.g[i], light.b[i]];
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
  light?: RGBLight,
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
        if (!rendersInTerrain(id)) continue;

        for (let fi = 0; fi < FACES.length; fi++) {
          if (!isFaceVisible(world, x, y, z, fi)) continue;
          const f = FACES[fi];
          const layer = tileIndexFor(id, fi);
          const baseVertex = positions.length / 3;
          // Light is sampled once per face (RGB), at the open cell the face looks into,
          // and dims all four vertices equally per channel (AO still varies per-vertex).
          const [lr, lg, lb] = lightAt(light, world, x + f.normal[0], y + f.normal[1], z + f.normal[2]); // prettier-ignore
          const lfR = lightFactor(lr);
          const lfG = lightFactor(lg);
          const lfB = lightFactor(lb);

          const levels: number[] = [];
          for (let k = 0; k < 4; k++) {
            const c = f.corners[k];
            positions.push(x + c[0], y + c[1], z + c[2]);
            normals.push(f.normal[0], f.normal[1], f.normal[2]);
            // Vertex colour = the block's atlas texel × this shade, PER CHANNEL. The base
            // shade is the face's flat directional shade modulated by per-vertex ambient
            // occlusion (an unoccluded vertex keeps the old per-face value at AO level 3),
            // then each channel is dimmed by that channel's light factor (1 when fully
            // lit, so an uncoloured/full field is byte-identical to the old grey colour).
            const level = cornerAO(world, x, y, z, f, c);
            levels.push(level);
            const base = f.shade * aoFactor(level);
            colors.push(base * lfR, base * lfG, base * lfB);
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
export function buildMesh(world: World, light?: RGBLight): ChunkMesh {
  return meshRange(world, 0, 0, 0, world.sizeX, world.sizeY, world.sizeZ, light);
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
  light?: RGBLight,
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
    light,
  );
}

// ---------------------------------------------------------------------------
// Greedy meshing — merge coplanar, adjacent, same-tile, uniformly-lit faces into
// larger quads, so a flat region becomes a few big quads instead of one per cell.
//
// A face is "mergeable" only when its four AO corners are EQUAL (uniform lighting):
// merging across an AO gradient would lose the per-corner shading the GPU can only
// interpolate, so faces whose AO varies are emitted 1×1 with their exact per-corner
// AO (just like the naive mesher) and never merged. Mergeable faces sharing the same
// (tile/layer, AO level) on a slice merge into maximal rectangles.
//
// The merged quad's tile-local UVs run 0..w and 0..h, so the tile REPEATS once per
// cell (the texture-array layer is RepeatWrapped) — this is what the Phase-A texture
// array unblocked. Coverage is identical to the naive mesher: every visible unit face
// is emitted exactly once, just grouped — pinned by the area-conservation census.
// ---------------------------------------------------------------------------

function meshRangeGreedy(
  world: World,
  x0: number,
  y0: number,
  z0: number,
  x1: number,
  y1: number,
  z1: number,
  light?: RGBLight,
): ChunkMesh {
  const positions: number[] = [];
  const normals: number[] = [];
  const colors: number[] = [];
  const uvs: number[] = [];
  const layers: number[] = [];
  const indices: number[] = [];
  let faceCount = 0;
  const lo = [x0, y0, z0];
  const hi = [x1, y1, z1];

  for (let d = 0; d < FACES.length; d++) {
    const f = FACES[d];
    const aAxis = f.normal[0] !== 0 ? 0 : f.normal[1] !== 0 ? 1 : 2;
    const [u, v] = aAxis === 0 ? [1, 2] : aAxis === 1 ? [0, 2] : [0, 1];
    // The tangent axis the UV's s-component advances along (where corner1 differs
    // from corner0); the other tangent carries t. Lets a w×h merge scale s,t correctly.
    const sAxis =
      f.corners[1][0] !== f.corners[0][0] ? 0 : f.corners[1][1] !== f.corners[0][1] ? 1 : 2;
    const U = hi[u] - lo[u];
    const V = hi[v] - lo[v];
    const A = hi[aAxis] - lo[aAxis];

    // Emit one quad covering w×h cells from base cell B (world coords), with the four
    // per-corner AO `levels` (all equal for a merged quad; the real four for a 1×1) and
    // the face's light level `lvl` (uniform across the merge — part of the merge key).
    const emit = (
      B: number[],
      w: number,
      h: number,
      levels: number[],
      layer: number,
      lvl: [number, number, number],
    ): void => {
      const sExtent = sAxis === u ? w : h;
      const tExtent = sAxis === u ? h : w;
      const lfR = lightFactor(lvl[0]);
      const lfG = lightFactor(lvl[1]);
      const lfB = lightFactor(lvl[2]);
      const base = positions.length / 3;
      for (let k = 0; k < 4; k++) {
        const c = f.corners[k];
        const p = [0, 0, 0];
        p[aAxis] = B[aAxis] + c[aAxis];
        p[u] = B[u] + (c[u] ? w : 0);
        p[v] = B[v] + (c[v] ? h : 0);
        positions.push(p[0], p[1], p[2]);
        normals.push(f.normal[0], f.normal[1], f.normal[2]);
        const shadeBase = f.shade * aoFactor(levels[k]);
        colors.push(shadeBase * lfR, shadeBase * lfG, shadeBase * lfB);
        uvs.push(FACE_UV[k][0] * sExtent, FACE_UV[k][1] * tExtent);
        layers.push(layer);
      }
      // Same brighter-diagonal split as the naive mesher (a no-op for a uniform merge,
      // where both diagonals are equal, so it takes the default 0–2 split).
      if (levels[0] + levels[2] < levels[1] + levels[3]) {
        indices.push(base + 1, base + 2, base + 3, base + 1, base + 3, base);
      } else {
        indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
      }
      faceCount++;
    };

    for (let sa = 0; sa < A; sa++) {
      // Build the mergeable-face mask for this slice; emit non-uniform faces 1×1 now.
      const key: (string | null)[] = new Array(U * V).fill(null);
      const keyLevel: number[] = new Array(U * V);
      const keyLayer: number[] = new Array(U * V);
      const keyLightR: number[] = new Array(U * V);
      const keyLightG: number[] = new Array(U * V);
      const keyLightB: number[] = new Array(U * V);
      for (let sv = 0; sv < V; sv++) {
        for (let su = 0; su < U; su++) {
          const cell = [0, 0, 0];
          cell[aAxis] = lo[aAxis] + sa;
          cell[u] = lo[u] + su;
          cell[v] = lo[v] + sv;
          const id = world.get(cell[0], cell[1], cell[2]);
          if (!rendersInTerrain(id)) continue;
          if (!isFaceVisible(world, cell[0], cell[1], cell[2], d)) continue;
          const levels = [0, 0, 0, 0];
          for (let k = 0; k < 4; k++)
            levels[k] = cornerAO(world, cell[0], cell[1], cell[2], f, f.corners[k]);
          const layer = tileIndexFor(id, d);
          // Face light at the open cell (RGB) — uniform across the face, so all three
          // channels join the merge key: faces at different light (any channel) never
          // merge (else a merged quad would average lighting the GPU can only
          // interpolate, just like an AO seam).
          const lvl = lightAt(
            light,
            world,
            cell[0] + f.normal[0],
            cell[1] + f.normal[1],
            cell[2] + f.normal[2],
          );
          if (levels[0] === levels[1] && levels[1] === levels[2] && levels[2] === levels[3]) {
            const idx = su + U * sv;
            key[idx] = `${layer},${levels[0]},${lvl[0]},${lvl[1]},${lvl[2]}`;
            keyLevel[idx] = levels[0];
            keyLayer[idx] = layer;
            keyLightR[idx] = lvl[0];
            keyLightG[idx] = lvl[1];
            keyLightB[idx] = lvl[2];
          } else {
            emit(cell, 1, 1, levels, layer, lvl);
          }
        }
      }
      // Greedy maximal-rectangle extraction over the mask.
      const used = new Array(U * V).fill(false);
      for (let sv = 0; sv < V; sv++) {
        for (let su = 0; su < U; su++) {
          const idx = su + U * sv;
          if (key[idx] === null || used[idx]) continue;
          let w = 1;
          while (su + w < U && key[idx + w] === key[idx] && !used[idx + w]) w++;
          let h = 1;
          grow: while (sv + h < V) {
            for (let k = 0; k < w; k++) {
              const j = su + k + U * (sv + h);
              if (key[j] !== key[idx] || used[j]) break grow;
            }
            h++;
          }
          for (let hh = 0; hh < h; hh++)
            for (let ww = 0; ww < w; ww++) used[su + ww + U * (sv + hh)] = true;
          const B = [0, 0, 0];
          B[aAxis] = lo[aAxis] + sa;
          B[u] = lo[u] + su;
          B[v] = lo[v] + sv;
          const L = keyLevel[idx];
          emit(B, w, h, [L, L, L, L], keyLayer[idx], [
            keyLightR[idx],
            keyLightG[idx],
            keyLightB[idx],
          ]);
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

/** Greedy-mesh the whole world in one geometry (the merged counterpart of `buildMesh`). */
export function buildGreedyMesh(world: World, light?: RGBLight): ChunkMesh {
  return meshRangeGreedy(world, 0, 0, 0, world.sizeX, world.sizeY, world.sizeZ, light);
}

/**
 * Greedy-mesh a single chunk (the merged counterpart of `buildChunkMesh`). Merges
 * only within the chunk's own cells but culls + samples AO against the full world,
 * so seams stay correct and the per-chunk union still covers every visible unit face.
 */
export function buildGreedyChunkMesh(
  world: World,
  cx: number,
  cy: number,
  cz: number,
  chunkSize: number = CHUNK_SIZE,
  light?: RGBLight,
): ChunkMesh {
  const x0 = cx * chunkSize;
  const y0 = cy * chunkSize;
  const z0 = cz * chunkSize;
  return meshRangeGreedy(
    world,
    x0,
    y0,
    z0,
    Math.min(x0 + chunkSize, world.sizeX),
    Math.min(y0 + chunkSize, world.sizeY),
    Math.min(z0 + chunkSize, world.sizeZ),
    light,
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
