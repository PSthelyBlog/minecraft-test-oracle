/**
 * Lava flow — a BOUNDED deterministic flood fill, the second fluid (v0.7).
 *
 * Like water, lava is BINARY (a derived 0/1 field, not stored blocks): `Block.Lava`
 * cells are SOURCES, and lava spreads SIDEWAYS or straight DOWN — never up. Unlike
 * water's unbounded flood, lava carries a BUDGET of `LAVA_RANGE` horizontal steps:
 * a horizontal step costs 1, a down step is FREE (the budget is carried, not reset),
 * and a cell holds lava iff some source reaches it within budget. So lava makes short
 * tongues that pour down any depth of cliff and puddle at the bottom, instead of
 * flooding a whole cave system. The field is the max-fixpoint over per-cell remaining
 * budget, so it is independent of traversal order.
 *
 * Same silent-failure surface as water (lava from nowhere, leaking through walls,
 * climbing, over-spreading), plus the budget arithmetic — so it is oracle-tested
 * against an INDEPENDENT budget relaxation, a subset differential vs `computeWater`
 * (bounded ⊆ unbounded — deliberately NO shared code with water.ts, so a mutant
 * can't move both sides at once), an inflow-witness invariant, diamond/shaft goldens
 * that pin the exact range, and a damming metamorphic.
 */

import type { World } from "./world";
import { Block, isSolid } from "./blocks";

/** Horizontal steps a source's lava can spend; down steps are free. */
export const LAVA_RANGE = 3;

/** The four horizontal neighbour offsets (same y); lava also pours straight down. */
const HORIZONTAL: readonly (readonly [number, number])[] = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

/** A cell can hold lava iff it is not solid; solid blocks dam it out (like water). */
function canHold(world: World, x: number, y: number, z: number): boolean {
  return !isSolid(world.get(x, y, z));
}

/**
 * Per-voxel lava presence (`0` dry / `1` lava), a flat array in the world's index
 * order. Every `Block.Lava` cell is a source with a budget of `LAVA_RANGE`; a BFS
 * spreads lava into non-solid cells — a horizontal step spends one unit of budget,
 * a straight-down step spends none, and there is no upward step — so the lava set
 * is exactly the cells reachable from a source by a non-rising path with at most
 * `LAVA_RANGE` horizontal steps.
 */
export function computeLava(world: World): Uint8Array {
  const { sizeX, sizeY, sizeZ } = world;
  // Per-cell best budget, encoded as remaining horizontal steps + 1 (so 0 = dry and
  // 1 = lava that can still pour down but spread no further sideways).
  const budget = new Uint8Array(world.volume);

  // Seed: every lava block is a full-budget source. A parallel coordinate queue
  // drives the flood.
  const qx: number[] = [];
  const qy: number[] = [];
  const qz: number[] = [];
  for (let y = 0; y < sizeY; y++) {
    for (let z = 0; z < sizeZ; z++) {
      for (let x = 0; x < sizeX; x++) {
        if (world.get(x, y, z) === Block.Lava) {
          budget[world.index(x, y, z)] = LAVA_RANGE + 1;
          qx.push(x);
          qy.push(y);
          qz.push(z);
        }
      }
    }
  }

  // Flood: raise any non-solid neighbour whose stored budget is beaten, and enqueue
  // it. Re-queueing on improvement makes the result the max-fixpoint over budgets,
  // independent of traversal order.
  const relax = (nx: number, ny: number, nz: number, nb: number): void => {
    if (nb < 1) return; // out of budget: the tongue stops
    if (!world.inBounds(nx, ny, nz)) return;
    if (!canHold(world, nx, ny, nz)) return;
    const ni = world.index(nx, ny, nz);
    if (budget[ni] < nb) {
      budget[ni] = nb;
      qx.push(nx);
      qy.push(ny);
      qz.push(nz);
    }
  };
  for (let head = 0; head < qx.length; head++) {
    const x = qx[head];
    const y = qy[head];
    const z = qz[head];
    const b = budget[world.index(x, y, z)];
    relax(x, y - 1, z, b); // straight down is free (never up — no +Y step exists)
    for (const [dx, dz] of HORIZONTAL) relax(x + dx, y, z + dz, b - 1); // sideways costs 1
  }

  // Presence field: any positive budget is lava.
  const lava = new Uint8Array(world.volume);
  for (let i = 0; i < lava.length; i++) lava[i] = budget[i] > 0 ? 1 : 0;
  return lava;
}
