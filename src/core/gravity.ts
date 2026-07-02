/**
 * Gravity for loose blocks — sand and gravel fall.
 *
 * `settle(world)` returns the resting state: every Sand/Gravel cell drops **straight down**
 * (the Minecraft Classic rule — no sideways sliding) through Air until the cell directly below
 * is non-Air, and loose blocks pile up in their column. Only Sand and Gravel move; every other
 * block stays exactly where it is.
 *
 * Columns are independent (straight-down ⇒ no cross-column flow), so the render can re-settle
 * just the column(s) an edit touched. Water isn't handled here: loose blocks fall through the
 * Air cells that make up a flooded pool's interior, and since a settled block is solid, the
 * water field simply re-floods around it afterwards (a separate recompute).
 *
 * This is a silent-failure surface — a wrong bound or branch would make a block vanish,
 * duplicate, float, or drift sideways — so `gravity.test.ts` pins it with a conservation
 * census, a no-floating invariant, per-column conservation, idempotence, and column independence.
 */

import { World } from "./world";
import { Block, type BlockId } from "./blocks";

/** The loose blocks that fall under gravity. */
const FALLING: ReadonlySet<BlockId> = new Set([Block.Sand, Block.Gravel]);

/** Does this block fall under gravity (Sand / Gravel)? */
export function isFalling(id: BlockId): boolean {
  return FALLING.has(id);
}

/**
 * Return a new world with every Sand/Gravel block fallen straight down onto support.
 * Pure — `world` is not mutated. The output is the least state with no floating loose block,
 * reached by dropping each column's loose blocks onto the first non-Air cell beneath them.
 */
export function settle(world: World): World {
  const out = new World(world.sizeX, world.sizeY, world.sizeZ); // all Air (0)

  for (let z = 0; z < world.sizeZ; z++) {
    for (let x = 0; x < world.sizeX; x++) {
      // Walk the column bottom→top. Loose blocks accumulate in `pile`; a fixed (non-Air,
      // non-falling) block ends the segment, flushing the pile onto the cells just above the
      // previous support (`base`), then itself stays put and becomes the next support.
      let base = 0; // lowest free y in the current segment
      const pile: BlockId[] = [];
      for (let y = 0; y < world.sizeY; y++) {
        const id = world.get(x, y, z);
        if (isFalling(id)) {
          pile.push(id);
        } else if (id !== Block.Air) {
          for (let i = 0; i < pile.length; i++) out.set(x, base + i, z, pile[i]);
          out.set(x, y, z, id); // the support keeps its exact position
          pile.length = 0;
          base = y + 1;
        }
        // Air: leave `out` as Air here; loose blocks fall through it.
      }
      // Flush the top segment (loose blocks resting above the last support / the world floor).
      for (let i = 0; i < pile.length; i++) out.set(x, base + i, z, pile[i]);
    }
  }

  return out;
}
