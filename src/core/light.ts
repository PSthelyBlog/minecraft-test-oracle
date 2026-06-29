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
  onWrite?: (index: number, oldValue: number) => void,
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
        if (onWrite) onWrite(ni, light[ni]);
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
 * Per-voxel combined light (`0..15`): the brighter of block-light and skylight at
 * each cell, `max(computeBlockLight, computeSkyLight)`. This is the field the mesher
 * dims faces by — a cell counts as lit if EITHER the sky or a nearby emitter reaches
 * it. (Recomputed whole on each edit until incremental updates land in #66.)
 */
export function computeLight(world: World): Uint8Array {
  const block = computeBlockLight(world);
  const sky = computeSkyLight(world);
  const out = new Uint8Array(world.volume);
  for (let i = 0; i < out.length; i++) out[i] = block[i] > sky[i] ? block[i] : sky[i];
  return out;
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

// ---------------------------------------------------------------------------
// Incremental updates — after a single block edit, mutate the existing light
// fields in place instead of recomputing the whole world, and report exactly which
// cells changed (so the renderer can remesh only the affected chunks).
//
// Both fields use the classic two-pass scheme: a REMOVAL flood first clears every
// cell whose light traced back to what the edit darkened (queuing brighter, still-
// independent cells it bumps into as re-light sources), then an ADD flood (the same
// `floodLight`) re-propagates from those border sources plus the edit's new sources.
// The end result is identical to a from-scratch recompute — pinned by the headline
// DIFFERENTIAL oracle (incremental == `computeBlockLight`/`computeSkyLight`/
// `computeLight`) over random edit sequences.
// ---------------------------------------------------------------------------

/** Records each cell's value as it was BEFORE this update, so the changed set is exact. */
type Origins = Map<number, number>;

/** Cells whose field value differs from the recorded original — the exact changed set. */
function changedCells(orig: Origins, field: Uint8Array): number[] {
  const out: number[] = [];
  for (const [i, was] of orig) if (field[i] !== was) out.push(i);
  return out;
}

/**
 * Removal flood. Each seeded cell has already been cleared to 0 (with its old level
 * recorded in `rlvl` and its original captured in `orig`). For every lit neighbour
 * DIMMER than the cell it came from, that light depended on the removed cell → clear
 * and enqueue it; a neighbour at least as bright is an INDEPENDENT source → stash it
 * in the add-queue to re-light from. Mirrors `floodLight`'s traversal in reverse.
 */
function removalPass(
  world: World,
  field: Uint8Array,
  rqx: number[],
  rqy: number[],
  rqz: number[],
  rlvl: number[],
  aqx: number[],
  aqy: number[],
  aqz: number[],
  orig: Origins,
): void {
  for (let head = 0; head < rqx.length; head++) {
    const x = rqx[head];
    const y = rqy[head];
    const z = rqz[head];
    const lvl = rlvl[head];
    for (const [dx, dy, dz] of NEIGHBORS) {
      const nx = x + dx;
      const ny = y + dy;
      const nz = z + dz;
      if (!world.inBounds(nx, ny, nz)) continue;
      const ni = world.index(nx, ny, nz);
      const nl = field[ni];
      if (nl === 0) continue; // already dark (or opaque) — nothing to remove or re-light
      if (nl < lvl) {
        if (!orig.has(ni)) orig.set(ni, nl);
        field[ni] = 0;
        rqx.push(nx);
        rqy.push(ny);
        rqz.push(nz);
        rlvl.push(nl);
      } else {
        // at least as bright → its light does not depend on the removed cell; re-light from it
        aqx.push(nx);
        aqy.push(ny);
        aqz.push(nz);
      }
    }
  }
}

/** True iff every cell strictly above (x, y, z) in its column is non-opaque (open sky). */
function columnOpenAbove(world: World, x: number, y: number, z: number): boolean {
  for (let yy = y + 1; yy < world.sizeY; yy++) if (isOpaque(world.get(x, yy, z))) return false;
  return true;
}

/**
 * Incrementally update block-light after the block at (x, y, z) has been changed in
 * `world`. Mutates `light` in place and returns the flat indices whose value changed.
 * Driven by the OLD value still in `light` plus the NEW block in `world`, so it needs
 * no record of the previous block id and handles brighten and darken symmetrically.
 */
export function updateBlockLight(
  world: World,
  light: Uint8Array,
  x: number,
  y: number,
  z: number,
): number[] {
  const orig: Origins = new Map();
  const rqx: number[] = [x],
    rqy: number[] = [y],
    rqz: number[] = [z];
  const i0 = world.index(x, y, z);
  const rlvl: number[] = [light[i0]];
  const aqx: number[] = [],
    aqy: number[] = [],
    aqz: number[] = [];
  // Seed removal from the edited cell with its old level (the loop also re-lights any
  // brighter neighbour, so a cell that just became transparent fills back in too).
  orig.set(i0, light[i0]);
  light[i0] = 0;
  removalPass(world, light, rqx, rqy, rqz, rlvl, aqx, aqy, aqz, orig);

  // Re-add the cell's own emission (an opaque emitter still radiates), then flood.
  const e = emissionOf(world.get(x, y, z));
  if (e > 0) {
    light[i0] = e;
    aqx.push(x);
    aqy.push(y);
    aqz.push(z);
  }
  floodLight(world, light, aqx, aqy, aqz, (i, was) => {
    if (!orig.has(i)) orig.set(i, was);
  });
  return changedCells(orig, light);
}

/**
 * Incrementally update skylight after the block at (x, y, z) has been changed in
 * `world`. Same two-pass scheme as block-light, plus the column rule: skylight's
 * sources are the open-sky columns, so an opacity change re-seeds the column BELOW the
 * edit — making it opaque removes the full-strength sky seed from the shadowed column;
 * making it transparent (under open sky) re-seeds that column at full strength.
 */
export function updateSkyLight(
  world: World,
  light: Uint8Array,
  x: number,
  y: number,
  z: number,
): number[] {
  const orig: Origins = new Map();
  const rqx: number[] = [x],
    rqy: number[] = [y],
    rqz: number[] = [z];
  const i0 = world.index(x, y, z);
  const rlvl: number[] = [light[i0]];
  const aqx: number[] = [],
    aqy: number[] = [],
    aqz: number[] = [];
  const openAbove = columnOpenAbove(world, x, y, z);
  const nowOpaque = isOpaque(world.get(x, y, z));

  orig.set(i0, light[i0]);
  light[i0] = 0;
  // If the edit now blocks an open column, the cells below lose their sky seed too.
  if (nowOpaque && openAbove) {
    for (let yy = y - 1; yy >= 0; yy--) {
      if (isOpaque(world.get(x, yy, z))) break;
      const ci = world.index(x, yy, z);
      if (!orig.has(ci)) orig.set(ci, light[ci]);
      rqx.push(x);
      rqy.push(yy);
      rqz.push(z);
      rlvl.push(light[ci]);
      light[ci] = 0;
    }
  }
  removalPass(world, light, rqx, rqy, rqz, rlvl, aqx, aqy, aqz, orig);

  // If the edited cell is now open to the sky, it and the open column below are full-
  // strength sky sources; otherwise it only receives via the re-light borders above.
  if (!nowOpaque && openAbove) {
    if (!orig.has(i0)) orig.set(i0, light[i0]);
    light[i0] = MAX_LIGHT;
    aqx.push(x);
    aqy.push(y);
    aqz.push(z);
    for (let yy = y - 1; yy >= 0; yy--) {
      if (isOpaque(world.get(x, yy, z))) break;
      const ci = world.index(x, yy, z);
      if (!orig.has(ci)) orig.set(ci, light[ci]);
      light[ci] = MAX_LIGHT;
      aqx.push(x);
      aqy.push(yy);
      aqz.push(z);
    }
  }
  floodLight(world, light, aqx, aqy, aqz, (i, was) => {
    if (!orig.has(i)) orig.set(i, was);
  });
  return changedCells(orig, light);
}

/**
 * Incrementally update both light fields and the combined `max` field after the block
 * at (x, y, z) has changed in `world`. Mutates all three arrays in place and returns
 * the flat indices whose COMBINED light changed (what the renderer remeshes around).
 */
export function updateLight(
  world: World,
  blockLight: Uint8Array,
  skyLight: Uint8Array,
  combined: Uint8Array,
  x: number,
  y: number,
  z: number,
): number[] {
  const touched = new Set<number>();
  for (const i of updateBlockLight(world, blockLight, x, y, z)) touched.add(i);
  for (const i of updateSkyLight(world, skyLight, x, y, z)) touched.add(i);
  const changed: number[] = [];
  for (const i of touched) {
    const v = blockLight[i] > skyLight[i] ? blockLight[i] : skyLight[i];
    if (combined[i] !== v) {
      combined[i] = v;
      changed.push(i);
    }
  }
  return changed;
}
