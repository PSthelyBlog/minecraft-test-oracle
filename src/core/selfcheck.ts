/**
 * Boot self-check — re-derives the cheapest core invariants in the SAME runtime as
 * production and THROWS if any is violated. Called once at startup (main.ts) so a
 * broken build fails loudly at the door instead of rendering a subtly wrong world.
 *
 * These mirror (a cheap subset of) the oracle suite; they are intentionally fast.
 */

import { World } from "./world";
import { Block, isOpaque, isSolid } from "./blocks";
import { buildMesh } from "./mesher";
import { raycast } from "./raycast";
import { length, directionFromYawPitch } from "./math";

class SelfCheckError extends Error {}
const must = (cond: boolean, msg: string): void => {
  if (!cond) throw new SelfCheckError(`boot self-check failed: ${msg}`);
};

export function selfCheck(): true {
  // 1) World index is a bijection on a small world (no collisions, full cover).
  {
    const w = new World(3, 4, 5);
    const seen = new Set<number>();
    for (let y = 0; y < w.sizeY; y++)
      for (let z = 0; z < w.sizeZ; z++)
        for (let x = 0; x < w.sizeX; x++) seen.add(w.index(x, y, z));
    must(seen.size === w.volume, "world index is not a bijection");
  }

  // 2) get/set round-trip at a corner cell.
  {
    const w = new World(4, 4, 4);
    w.set(3, 3, 3, Block.Stone);
    must(w.get(3, 3, 3) === Block.Stone, "world get/set round-trip");
    must(w.get(-1, 0, 0) === Block.Air, "out-of-bounds is not Air");
  }

  // 3) Face culling: a lone block shows 6 faces; two opaque neighbours show 10.
  {
    const a = new World(4, 4, 4);
    a.set(1, 1, 1, Block.Stone);
    must(buildMesh(a).faceCount === 6, "lone block != 6 faces");
    a.set(2, 1, 1, Block.Stone);
    must(buildMesh(a).faceCount === 10, "adjacent opaque pair != 10 faces");
  }

  // 4) Block facet sanity: opaque ⇒ solid; air is neither.
  must(!isSolid(Block.Air) && !isOpaque(Block.Air), "air must be non-solid/non-opaque");
  must(isOpaque(Block.Stone) && isSolid(Block.Stone), "stone must be solid+opaque");

  // 5) Raycast picks the obvious block with the correct entry normal.
  {
    const w = new World(8, 8, 8);
    w.set(5, 4, 4, Block.Stone);
    const hit = raycast(w, [0.5, 4.5, 4.5], [1, 0, 0], 16);
    must(!!hit && hit.block[0] === 5 && hit.normal[0] === -1, "raycast pick/normal");
  }

  // 6) Camera direction is unit length and faces -Z at rest.
  {
    const d = directionFromYawPitch(0, 0);
    must(Math.abs(length(d) - 1) < 1e-9, "camera dir not unit length");
    must(Math.abs(d[2] + 1) < 1e-9, "camera rest direction is not -Z");
  }

  return true;
}
