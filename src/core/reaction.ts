/**
 * The water↔lava reaction — the Classic rule that stops the two fluids
 * interpenetrating: where lava meets water, rock forms.
 *
 * A cell REACTS iff it holds lava (per the lava field) AND is water-touched — the
 * cell itself is water-flooded, or a face neighbour is. What it becomes depends on
 * what the lava there is:
 *
 *   - a `Block.Lava` SOURCE quenches to **Obsidian** (the prize),
 *   - a flooded non-source cell (the flowing tongue, Air in the world) crusts to
 *     **Stone**.
 *
 * Water dominates and is never consumed: a `Block.Water` source is never overwritten
 * (even where the lava field overlaps it), and water-only or dry cells never
 * solidify. So the reaction only ever removes fluid reach — every converted cell is
 * solid and dams both floods.
 *
 * `react` is ONE deterministic pass against the given fields; `reactFully` iterates
 * pass + field recompute to quiescence (each pass converts ≥ 1 cell or stops, so it
 * terminates). This is a silent-failure surface — rock from nowhere, a consumed
 * water source, the wrong product, a reaction through a sealing wall — so it is
 * oracle-tested by an independent per-cell reaction census, a no-witness-no-change
 * census, quiescence, a fluid-shrinks monotonicity metamorphic, and goldens.
 */

import { World } from "./world";
import { Block } from "./blocks";
import { computeWater } from "./water";
import { computeLava } from "./lava";

/** The four face-neighbour offsets water contact is checked across, plus up/down. */
const NEIGHBORS: readonly (readonly [number, number, number])[] = [
  [1, 0, 0],
  [-1, 0, 0],
  [0, 1, 0],
  [0, -1, 0],
  [0, 0, 1],
  [0, 0, -1],
];

/** Is this cell water-touched: itself flooded, or any face neighbour flooded? */
function waterTouched(world: World, water: Uint8Array, x: number, y: number, z: number): boolean {
  if (water[world.index(x, y, z)] === 1) return true;
  for (const [dx, dy, dz] of NEIGHBORS) {
    const nx = x + dx;
    const ny = y + dy;
    const nz = z + dz;
    if (!world.inBounds(nx, ny, nz)) continue;
    if (water[world.index(nx, ny, nz)] === 1) return true;
  }
  return false;
}

/**
 * One reaction pass: a new world in which every lava cell that is water-touched has
 * turned to rock — `Block.Lava` sources to Obsidian, flooded non-source cells to
 * Stone — and every other cell (including every `Block.Water` source) is byte-
 * identical. Pure: `world` is not mutated, and both fields are only read.
 */
export function react(world: World, water: Uint8Array, lava: Uint8Array): World {
  const out = new World(world.sizeX, world.sizeY, world.sizeZ);
  out.data.set(world.data);
  for (let y = 0; y < world.sizeY; y++) {
    for (let z = 0; z < world.sizeZ; z++) {
      for (let x = 0; x < world.sizeX; x++) {
        const i = world.index(x, y, z);
        if (lava[i] !== 1) continue; // no lava here: nothing to quench
        const id = world.data[i];
        if (id === Block.Water) continue; // water is never consumed
        if (!waterTouched(world, water, x, y, z)) continue;
        out.data[i] = id === Block.Lava ? Block.Obsidian : Block.Stone;
      }
    }
  }
  return out;
}

/**
 * Iterate `react` with fresh fields until nothing changes, and return the quiescent
 * world: no remaining lava cell is water-touched (rock formed by one pass can reroute
 * the floods, so a single pass is not always enough). Terminates — every pass either
 * converts at least one cell to solid rock or is the last.
 */
export function reactFully(world: World): World {
  let current = world;
  for (;;) {
    const next = react(current, computeWater(current), computeLava(current));
    let changed = false;
    for (let i = 0; i < next.data.length; i++) {
      if (next.data[i] !== current.data[i]) {
        changed = true;
        break;
      }
    }
    if (!changed) return current;
    current = next;
  }
}
