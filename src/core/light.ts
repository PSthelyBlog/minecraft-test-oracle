/**
 * Light propagation — block-light (from emitters) and skylight (from open sky).
 *
 * Both are the SAME flood: a cell's level is its seed value, or one less than the
 * brightest neighbour the light can reach. Light only travels INTO non-opaque cells,
 * so opaque blocks cast shadow (and never light up internally). The result is a
 * max-fixpoint (a multi-source shortest-path / BFS distance field), so it is
 * independent of traversal order. Only the SEED differs:
 *
 *   - block-light: every emitter holds its `emission` (even if opaque, it still
 *     radiates its own light).
 *   - skylight: every cell open to the sky (nothing opaque strictly above it in its
 *     column) holds full light. Because the whole open column down to the first
 *     opaque block is seeded at MAX_LIGHT, a vertical drop through open air never
 *     attenuates (the Classic rule) — horizontal/downward spread into shadow costs
 *     one level, like block-light. No special down-step is needed: horizontal spread
 *     maxes at MAX_LIGHT-1, so a full level only ever exists in a seeded column.
 *
 * This is a classic silent-failure surface — off-by-one decay, a missed neighbour,
 * light leaking through walls, a mis-seeded sky column — so both are oracle-tested
 * against an INDEPENDENT relaxation, distance/shadow goldens, a shadow metamorphic,
 * and invariants.
 */

import type { World } from "./world";
import { isOpaque, emissionOf } from "./blocks";

/** Maximum light level — a source at full brightness. */
export const MAX_LIGHT = 15;

/** The six axis neighbours light can step to. */
const NEIGHBORS: readonly (readonly [number, number, number])[] = [
  [1, 0, 0],
  [-1, 0, 0],
  [0, 1, 0],
  [0, -1, 0],
  [0, 0, 1],
  [0, 0, -1],
];

/**
 * Drive the max-fixpoint flood: from each already-seeded cell in the parallel
 * coordinate queue (head index, no `shift()`), propagate `level - 1` into in-bounds
 * non-opaque neighbours that are currently darker, enqueueing each cell it brightens.
 * `light` must already hold the seed values at the seeded coordinates. Shared by
 * block-light and skylight — only the seeding differs.
 */
function floodLight(
  world: World,
  light: Uint8Array,
  qx: number[],
  qy: number[],
  qz: number[],
): void {
  for (let head = 0; head < qx.length; head++) {
    const x = qx[head];
    const y = qy[head];
    const z = qz[head];
    const level = light[world.index(x, y, z)];
    for (const [dx, dy, dz] of NEIGHBORS) {
      const nx = x + dx;
      const ny = y + dy;
      const nz = z + dz;
      if (!world.inBounds(nx, ny, nz)) continue;
      if (isOpaque(world.get(nx, ny, nz))) continue; // light cannot enter an opaque cell
      const ni = world.index(nx, ny, nz);
      if (light[ni] < level - 1) {
        light[ni] = level - 1;
        qx.push(nx);
        qy.push(ny);
        qz.push(nz);
      }
    }
  }
}

/**
 * Per-voxel block-light level (`0..15`), as a flat array in the world's index
 * order (`world.index`). Every emitter is seeded with its emission (even if
 * opaque); a BFS then propagates `level - 1` into non-opaque neighbours, so opaque
 * non-emitters stay dark and block the spread.
 */
export function computeBlockLight(world: World): Uint8Array {
  const { sizeX, sizeY, sizeZ } = world;
  const light = new Uint8Array(world.volume);

  // Seed: every light-emitting block holds its emission.
  const qx: number[] = [];
  const qy: number[] = [];
  const qz: number[] = [];
  for (let y = 0; y < sizeY; y++) {
    for (let z = 0; z < sizeZ; z++) {
      for (let x = 0; x < sizeX; x++) {
        const e = emissionOf(world.get(x, y, z));
        if (e > 0) {
          light[world.index(x, y, z)] = e;
          qx.push(x);
          qy.push(y);
          qz.push(z);
        }
      }
    }
  }

  floodLight(world, light, qx, qy, qz);
  return light;
}

/**
 * Per-voxel skylight level (`0..15`), as a flat array in the world's index order
 * (`world.index`). Seed: walking each column from the top down, every cell is open
 * to the sky and holds MAX_LIGHT until the first opaque block, which stops the
 * column (cells below it are shadowed and only receive spread light). A BFS then
 * propagates `level - 1` into non-opaque neighbours — so opaque cells stay dark, and
 * a roof darkens everything beneath it.
 */
export function computeSkyLight(world: World): Uint8Array {
  const { sizeX, sizeY, sizeZ } = world;
  const light = new Uint8Array(world.volume);

  // Seed: every cell with open sky above it (down to the first opaque block in its
  // column) holds full skylight.
  const qx: number[] = [];
  const qy: number[] = [];
  const qz: number[] = [];
  for (let z = 0; z < sizeZ; z++) {
    for (let x = 0; x < sizeX; x++) {
      for (let y = sizeY - 1; y >= 0; y--) {
        if (isOpaque(world.get(x, y, z))) break; // column blocked: nothing below is open to sky
        light[world.index(x, y, z)] = MAX_LIGHT;
        qx.push(x);
        qy.push(y);
        qz.push(z);
      }
    }
  }

  floodLight(world, light, qx, qy, qz);
  return light;
}
