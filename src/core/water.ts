/**
 * Water flow — a deterministic flood fill, the Minecraft Classic (2009) model.
 *
 * Water is BINARY: a cell is water or dry (no finite levels). `Block.Water` cells are
 * SOURCES; from a source water floods into non-solid cells by stepping SIDEWAYS (the four
 * horizontal neighbours) or straight DOWN — never up. So water flows down cliffs and
 * along floors, floods low areas and caves connected to a source, and pools at the bottom
 * of a pit with a flat surface; it never climbs above where it flowed in. The watered set
 * is the least fixpoint of that rule — the cells reachable from a source by non-rising
 * steps — and is independent of traversal order.
 *
 * This is a classic silent-failure surface (water appearing from nowhere, leaking through
 * walls, flowing uphill), so it is oracle-tested against an INDEPENDENT reachability flood
 * and a relaxation, an inflow-witness invariant, a damming metamorphic, and a golden.
 */

import type { World } from "./world";
import { Block, isSolid } from "./blocks";

/**
 * The five directions water floods to: the four horizontal neighbours and straight down.
 * There is deliberately no `[0, +1, 0]` — water never climbs above where it flowed in.
 */
const FLOW: readonly (readonly [number, number, number])[] = [
  [1, 0, 0],
  [-1, 0, 0],
  [0, 0, 1],
  [0, 0, -1],
  [0, -1, 0],
];

/** A cell can hold water iff it is not solid (air or water); solid blocks dam it out. */
function canHold(world: World, x: number, y: number, z: number): boolean {
  return !isSolid(world.get(x, y, z));
}

/**
 * Per-voxel water presence (`0` dry / `1` water), a flat array in the world's index
 * order. Every `Block.Water` cell is a source; a BFS floods into non-solid cells
 * sideways and downward (never up), so the watered set is exactly the cells reachable
 * from a source by non-rising steps — the least fixpoint of the flood rule.
 */
export function computeWater(world: World): Uint8Array {
  const { sizeX, sizeY, sizeZ } = world;
  const water = new Uint8Array(world.volume);

  // Seed: every water block is a source. A parallel coordinate queue drives the flood.
  const qx: number[] = [];
  const qy: number[] = [];
  const qz: number[] = [];
  for (let y = 0; y < sizeY; y++) {
    for (let z = 0; z < sizeZ; z++) {
      for (let x = 0; x < sizeX; x++) {
        if (world.get(x, y, z) === Block.Water) {
          water[world.index(x, y, z)] = 1;
          qx.push(x);
          qy.push(y);
          qz.push(z);
        }
      }
    }
  }

  // Flood: from each watered cell, wet every non-solid sideways/downward neighbour that
  // is still dry, and enqueue it. (Never upward — `FLOW` has no +Y step.)
  for (let head = 0; head < qx.length; head++) {
    const x = qx[head];
    const y = qy[head];
    const z = qz[head];
    for (const [dx, dy, dz] of FLOW) {
      const nx = x + dx;
      const ny = y + dy;
      const nz = z + dz;
      if (!world.inBounds(nx, ny, nz)) continue;
      if (!canHold(world, nx, ny, nz)) continue;
      const ni = world.index(nx, ny, nz);
      if (water[ni] === 0) {
        water[ni] = 1;
        qx.push(nx);
        qy.push(ny);
        qz.push(nz);
      }
    }
  }

  return water;
}
