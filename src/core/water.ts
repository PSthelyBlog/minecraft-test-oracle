/**
 * Water flow — a deterministic cellular automaton over the voxel grid.
 *
 * Water is modelled as a per-cell LEVEL `0..MAX_WATER` (a derived field, like light,
 * not stored as blocks). `Block.Water` cells are SOURCES, held at full level. From a
 * source, water:
 *
 *   - FALLS: a non-solid cell whose cell directly ABOVE holds water (> 0) fills to
 *     `MAX_WATER` — a falling column never weakens.
 *   - SPREADS horizontally: otherwise a non-solid cell takes `max(horizontal
 *     neighbour) - 1`, so flow thins out and dies `MAX_WATER` cells from a drop.
 *   - never flows UP, and never enters a solid cell (which stays `0`).
 *
 * Those rules are a monotone operator; seeding the sources at `MAX_WATER` and flooding
 * converges to its least fixpoint — independent of traversal order. This is a classic
 * silent-failure surface (water appearing from nowhere, the wrong decay, flowing up or
 * through walls), so it is oracle-tested against the fixpoint condition itself, an
 * independent relaxation, a reachability invariant, a damming metamorphic, and a golden.
 */

import type { World } from "./world";
import { Block, isSolid } from "./blocks";

/** Full water level — a source, or the head of a falling column. */
export const MAX_WATER = 7;

/** The four horizontal neighbours water spreads to (no vertical: fall is special). */
const HORIZONTAL: readonly (readonly [number, number])[] = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

/** A cell can hold water iff it is not solid (air or water); solid blocks dam it out. */
function canHold(world: World, x: number, y: number, z: number): boolean {
  return !isSolid(world.get(x, y, z));
}

/**
 * Per-voxel water level (`0..MAX_WATER`), a flat array in the world's index order.
 * Every `Block.Water` cell is seeded at `MAX_WATER`; a BFS then floods `MAX_WATER`
 * straight down into open cells (falling) and `level - 1` sideways (spreading), never
 * upward and never into solid cells. The result is the least fixpoint of the flow rule.
 */
export function computeWater(world: World): Uint8Array {
  const { sizeX, sizeY, sizeZ } = world;
  const water = new Uint8Array(world.volume);

  // Seed: every water block is a full source. A parallel coordinate queue drives the flood.
  const qx: number[] = [];
  const qy: number[] = [];
  const qz: number[] = [];
  for (let y = 0; y < sizeY; y++) {
    for (let z = 0; z < sizeZ; z++) {
      for (let x = 0; x < sizeX; x++) {
        if (world.get(x, y, z) === Block.Water) {
          water[world.index(x, y, z)] = MAX_WATER;
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
    const level = water[world.index(x, y, z)];

    // Fall: the cell directly below fills to full (a falling column never weakens).
    if (world.inBounds(x, y - 1, z) && canHold(world, x, y - 1, z)) {
      const bi = world.index(x, y - 1, z);
      if (water[bi] < MAX_WATER) {
        water[bi] = MAX_WATER;
        qx.push(x);
        qy.push(y - 1);
        qz.push(z);
      }
    }

    // Spread: horizontal neighbours take one less (no effect once level is 1).
    const spread = level - 1;
    for (const [dx, dz] of HORIZONTAL) {
      const nx = x + dx;
      const nz = z + dz;
      if (!world.inBounds(nx, y, nz)) continue;
      if (!canHold(world, nx, y, nz)) continue;
      const ni = world.index(nx, y, nz);
      if (water[ni] < spread) {
        water[ni] = spread;
        qx.push(nx);
        qy.push(y);
        qz.push(nz);
      }
    }
  }

  return water;
}
