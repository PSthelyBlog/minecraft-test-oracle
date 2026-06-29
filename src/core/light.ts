/**
 * Block-light propagation.
 *
 * Light sources (blocks with `emission > 0`) flood light through the world: a
 * cell's level is its own emission, or one less than the brightest neighbour the
 * light can reach. Light only travels INTO non-opaque cells, so opaque blocks cast
 * shadow (and never light up internally) — but an opaque emitter still holds and
 * radiates its own emission. The result is a max-fixpoint (a multi-source
 * shortest-path / BFS distance field), so it is independent of traversal order.
 *
 * This is a classic silent-failure surface — off-by-one decay, a missed neighbour,
 * light leaking through walls — so it is oracle-tested against an INDEPENDENT
 * relaxation, an open-air distance golden, a shadow metamorphic, and invariants.
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
 * Per-voxel block-light level (`0..15`), as a flat array in the world's index
 * order (`world.index`). Every emitter is seeded with its emission (even if
 * opaque); a BFS then propagates `level - 1` into non-opaque neighbours, so opaque
 * non-emitters stay dark and block the spread.
 */
export function computeBlockLight(world: World): Uint8Array {
  const { sizeX, sizeY, sizeZ } = world;
  const light = new Uint8Array(world.volume);

  // Seed: every light-emitting block holds its emission. A parallel coordinate
  // queue (head index, no shift()) drives the flood.
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

  return light;
}
