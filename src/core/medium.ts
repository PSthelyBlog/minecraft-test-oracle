/**
 * The *medium* an observer is immersed in — air or water — as distinct from the
 * block that occupies a cell.
 *
 * The rest of the core answers "what block is at (x,y,z)?" (`world`) and "does water
 * flood this cell?" (`water`). Neither answers "what is the camera *inside* right now?"
 * — the fact that decides atmosphere (fog colour/range, an underwater light dimming).
 * Physics already reads a related quantity (`submersion`, the fraction of the player box
 * in water) for buoyancy/drag; this module names the *observer's* medium at a point so the
 * shell can swap fog/background when the eye dips below the surface. Above water it is a
 * strict no-op: `Air` carries exactly today's sky fog, so nothing renders differently.
 *
 * Like `blocks.ts`, this is a hand-authored registry: a single wrong fog value or a
 * swapped classifier branch fails silently, so `MEDIA` is pinned by a golden/injection
 * census and `mediumAt` by a partition census + a differential against `submersion`.
 */

import type { Vec3 } from "./math";
import type { World } from "./world";
import { isSolid } from "./blocks";

export type MediumId = number;

/** The media an observer can be immersed in. Contiguous from 0. */
export const Medium = {
  Air: 0,
  Water: 1,
  Solid: 2,
} as const;

export type MediumKey = keyof typeof Medium;

export interface MediumDef {
  readonly id: MediumId;
  readonly name: string;
  /** Fog / background colour while immersed, `[r, g, b]` in 0..1. */
  readonly fogColor: readonly [number, number, number];
  /** Linear-fog near plane (distance at which fog starts), in blocks. */
  readonly fogNear: number;
  /** Linear-fog far plane (distance at which fog is opaque), in blocks. */
  readonly fogFar: number;
  /** Brightness multiplier applied while immersed, in 0..1 (`1` = no dimming). */
  readonly lightMultiplier: number;
}

// The current sky/clear colour (main.ts `SKY = 0x8fbcff`), as the single source of
// truth for the *air* atmosphere so the shell derives fog+background from the medium
// alone. Kept here (not imported from the shell) so the core stays dependency-free —
// the strict-extension golden pins these to today's `Fog(SKY, 40, 110)`.
const SKY_RGB: readonly [number, number, number] = [0x8f / 255, 0xbc / 255, 0xff / 255];

/**
 * Definitions indexed by medium id, total over every defined id. `Air` reproduces
 * today's atmosphere exactly (a strict extension: above water is byte-identical);
 * `Water` is a blue, close-pulled fog with a mild dimming. `Solid` is a fallback for an
 * eye embedded in a block — rendered like air, present only to make `mediumAt` a total
 * 3-way partition the census can pin.
 */
export const MEDIA: Readonly<Record<MediumId, MediumDef>> = {
  [Medium.Air]: {
    id: Medium.Air,
    name: "Air",
    fogColor: SKY_RGB,
    fogNear: 40,
    fogFar: 110,
    lightMultiplier: 1,
  },
  [Medium.Water]: {
    id: Medium.Water,
    name: "Water",
    fogColor: [0.15, 0.3, 0.62], // deep blue, matching the water tile
    fogNear: 0.1,
    fogFar: 18,
    lightMultiplier: 0.75,
  },
  [Medium.Solid]: {
    id: Medium.Solid,
    name: "Solid",
    fogColor: SKY_RGB,
    fogNear: 40,
    fogFar: 110,
    lightMultiplier: 1,
  },
};

export function mediumDef(id: MediumId): MediumDef {
  return MEDIA[id] ?? MEDIA[Medium.Air];
}

/**
 * The medium filling cell `(x, y, z)`, given the world and its water field.
 *
 * A total, disjoint 3-way partition: `Water` if the cell is flooded, else `Solid` if the
 * block collides, else `Air`. Water and solid never overlap because the flood never waters
 * a solid cell (a property of `computeWater` the oracle checks independently, not assumed).
 * Out of bounds reads as `Air` — the world edge is open sky, matching `world.get` (Air) and
 * the dry-edge convention of the water field.
 */
export function mediumAt(
  world: World,
  water: Uint8Array,
  x: number,
  y: number,
  z: number,
): MediumId {
  if (!world.inBounds(x, y, z)) return Medium.Air;
  if (water[world.index(x, y, z)] === 1) return Medium.Water;
  if (isSolid(world.get(x, y, z))) return Medium.Solid;
  return Medium.Air;
}

/**
 * The medium at a continuous point (e.g. the camera eye), classified by the voxel cell
 * that contains it. `[x, x+1)` belongs to cell `x`, so a point exactly on a boundary
 * takes the higher cell — the same `Math.floor` convention as `submersion`/`raycast`.
 */
export function mediumAtPoint(world: World, water: Uint8Array, point: Vec3): MediumId {
  return mediumAt(world, water, Math.floor(point[0]), Math.floor(point[1]), Math.floor(point[2]));
}
