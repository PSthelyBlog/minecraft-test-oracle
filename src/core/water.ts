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
 *
 * `updateWater` maintains the field INCREMENTALLY after a single block edit (the
 * counterpart of `light.ts`'s `updateBlockLight`): a removal flood clears the cells the
 * edit could have dried, collecting still-fed cells as re-flood borders, then the same
 * add flood re-propagates — identical to a from-scratch `computeWater`, which is exactly
 * what the headline DIFFERENTIAL oracle checks over random edit sequences.
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
 * Drive the flow flood from the cells already seeded in the parallel coordinate queue
 * (head index, no `shift()`): each watered cell fills the open cell below it to
 * `MAX_WATER` (fall) and raises each open horizontal neighbour to `level - 1` (spread),
 * enqueueing every cell it raises. `water` must already hold the seed levels. Raising
 * only (each guard is a strict `<`), so it converges to the least fixpoint regardless of
 * seed order — shared by the from-scratch `computeWater` and `updateWater`'s add pass.
 * The `level > 0` fall guard is a no-op for `computeWater` (it only ever queues watered
 * cells) but keeps `updateWater` correct if a collected border was since cleared to 0.
 */
function floodWater(
  world: World,
  water: Uint8Array,
  qx: number[],
  qy: number[],
  qz: number[],
  onWrite?: (index: number, oldValue: number) => void,
): void {
  for (let head = 0; head < qx.length; head++) {
    const x = qx[head];
    const y = qy[head];
    const z = qz[head];
    const level = water[world.index(x, y, z)];

    // Fall: the cell directly below fills to full (a falling column never weakens).
    if (level > 0 && world.inBounds(x, y - 1, z) && canHold(world, x, y - 1, z)) {
      const bi = world.index(x, y - 1, z);
      if (water[bi] < MAX_WATER) {
        if (onWrite) onWrite(bi, water[bi]);
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
        if (onWrite) onWrite(ni, water[ni]);
        water[ni] = spread;
        qx.push(nx);
        qy.push(y);
        qz.push(nz);
      }
    }
  }
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

  floodWater(world, water, qx, qy, qz);
  return water;
}

// ---------------------------------------------------------------------------
// Incremental update — after a single block edit, mutate the existing water field
// in place instead of recomputing the whole world, and report exactly which cells
// changed (so the renderer remeshes only the affected chunks). Mirrors light.ts's
// two-pass scheme, but water flow is DIRECTIONAL: a cell's level depends only on the
// cell ABOVE it (fall) and its HORIZONTAL neighbours (spread) — never the cell below
// (water never flows up). So the removal flood walks DOWN + horizontal-dependent to
// clear, and collects ABOVE + horizontal-independent + below-source cells as the
// borders to re-flood from. Pinned by the headline DIFFERENTIAL oracle (incremental ==
// from-scratch computeWater after every edit of random edit-sequences).
// ---------------------------------------------------------------------------

/** Records each cell's level as it was BEFORE this update, so the changed set is exact. */
type Origins = Map<number, number>;

/** Cells whose level differs from the recorded original — the exact changed set. */
function changedCells(orig: Origins, water: Uint8Array): number[] {
  const out: number[] = [];
  for (const [i, was] of orig) if (water[i] !== was) out.push(i);
  return out;
}

/**
 * Removal flood. Each seeded cell has already been cleared to 0 (old level recorded in
 * `rlvl`, original captured in `orig`). For a cleared cell at old level `lvl`, the cells
 * it FED downstream lose that inflow → clear and recurse; the cells that fed IT (or are
 * independently sourced) become re-flood borders in the add-queue:
 *
 *   - below (fall target): `lvl > 0` means this cell fell `MAX_WATER` into it. A
 *     `Block.Water` source there is independent (re-flood from it); any other watered
 *     cell had no other cell above it, so it loses its only fall source → clear it.
 *   - horizontal: a neighbour DIMMER than `lvl` could only have come from this cell's
 *     spread (`lvl - 1`) → clear it; one at least as bright is independent → re-flood.
 *   - above: water never flows up, so it is never cleared — but a still-watered cell
 *     above is an independent inflow that must re-fall into the cleared region.
 */
function removalPass(
  world: World,
  water: Uint8Array,
  rqx: number[],
  rqy: number[],
  rqz: number[],
  rlvl: number[],
  aqx: number[],
  aqy: number[],
  aqz: number[],
  orig: Origins,
): void {
  const clear = (i: number, nx: number, ny: number, nz: number): void => {
    if (!orig.has(i)) orig.set(i, water[i]);
    rlvl.push(water[i]);
    water[i] = 0;
    rqx.push(nx);
    rqy.push(ny);
    rqz.push(nz);
  };
  const border = (nx: number, ny: number, nz: number): void => {
    aqx.push(nx);
    aqy.push(ny);
    aqz.push(nz);
  };

  for (let head = 0; head < rqx.length; head++) {
    const x = rqx[head];
    const y = rqy[head];
    const z = rqz[head];
    const lvl = rlvl[head];

    // Below: the fall target this cell sustained.
    if (lvl > 0 && world.inBounds(x, y - 1, z)) {
      const bi = world.index(x, y - 1, z);
      if (water[bi] > 0) {
        if (world.get(x, y - 1, z) === Block.Water) border(x, y - 1, z);
        else clear(bi, x, y - 1, z);
      }
    }

    // Horizontal: spread targets (dimmer) vs independent inflows (at least as bright).
    for (const [dx, dz] of HORIZONTAL) {
      const nx = x + dx;
      const nz = z + dz;
      if (!world.inBounds(nx, y, nz)) continue;
      const ni = world.index(nx, y, nz);
      const nl = water[ni];
      if (nl === 0) continue;
      if (nl < lvl) clear(ni, nx, y, nz);
      else border(nx, y, nz);
    }

    // Above: an independent fall source for the cleared region (never flows up → never cleared).
    if (world.inBounds(x, y + 1, z) && water[world.index(x, y + 1, z)] > 0) border(x, y + 1, z);
  }
}

/**
 * Incrementally update the water field after the block at (x, y, z) has changed in
 * `world`. Mutates `water` in place and returns the flat indices whose level changed.
 * Driven by the OLD level still in `water` plus the NEW block in `world`, so it needs no
 * record of the previous block and handles damming and opening symmetrically.
 */
export function updateWater(
  world: World,
  water: Uint8Array,
  x: number,
  y: number,
  z: number,
): number[] {
  const orig: Origins = new Map();
  const i0 = world.index(x, y, z);
  const rqx: number[] = [x],
    rqy: number[] = [y],
    rqz: number[] = [z];
  const rlvl: number[] = [water[i0]];
  const aqx: number[] = [],
    aqy: number[] = [],
    aqz: number[] = [];
  // Seed removal from the edited cell with its old level (the pass also collects the
  // borders that re-fill it if it is now open and still fed).
  orig.set(i0, water[i0]);
  water[i0] = 0;
  removalPass(world, water, rqx, rqy, rqz, rlvl, aqx, aqy, aqz, orig);

  // Re-seed the edited cell if it is now a full source; the add flood (plus the borders
  // the removal collected) restores everything else to the fixpoint.
  if (world.get(x, y, z) === Block.Water) {
    water[i0] = MAX_WATER;
    aqx.push(x);
    aqy.push(y);
    aqz.push(z);
  }
  floodWater(world, water, aqx, aqy, aqz, (i, was) => {
    if (!orig.has(i)) orig.set(i, was);
  });
  return changedCells(orig, water);
}
