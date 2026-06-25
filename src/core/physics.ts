/**
 * Axis-aligned bounding-box physics against the voxel grid.
 *
 * The player is an AABB (a box of half-extents around a centre). `moveAndCollide`
 * resolves movement one axis at a time so the player slides along walls instead of
 * sticking — the standard voxel approach. Per-axis resolution + the onGround flag
 * are silent-failure surfaces (a wrong sweep direction lets you fall through floors
 * or clip walls), so they are oracle-tested against an independent overlap check.
 */

import type { World } from "./world";
import { isSolid } from "./blocks";
import type { Vec3 } from "./math";

export interface AABB {
  /** Centre position. */
  pos: Vec3;
  /** Half-extents (half width, half height, half depth). */
  readonly half: Vec3;
}

export interface MoveResult {
  readonly pos: Vec3;
  /** True iff downward motion was stopped by a solid block this step. */
  readonly onGround: boolean;
  /** Per-axis collision flags [x, y, z]. */
  readonly collided: readonly [boolean, boolean, boolean];
}

/** Does the box [min,max] overlap any solid voxel? Half-open on the max edge. */
export function boxIntersectsSolid(world: World, center: Vec3, half: Vec3): boolean {
  const minX = Math.floor(center[0] - half[0]);
  const maxX = Math.ceil(center[0] + half[0]) - 1;
  const minY = Math.floor(center[1] - half[1]);
  const maxY = Math.ceil(center[1] + half[1]) - 1;
  const minZ = Math.floor(center[2] - half[2]);
  const maxZ = Math.ceil(center[2] + half[2]) - 1;

  for (let y = minY; y <= maxY; y++) {
    for (let z = minZ; z <= maxZ; z++) {
      for (let x = minX; x <= maxX; x++) {
        if (isSolid(world.get(x, y, z))) return true;
      }
    }
  }
  return false;
}

/**
 * Move `center` by `delta`, resolving collisions against solid voxels one axis
 * at a time (Y, then X, then Z). On collision along an axis, motion on that axis
 * is cancelled (velocity bleed is the caller's job). Assumes the starting box is
 * not already intersecting solid geometry.
 */
export function moveAndCollide(world: World, center: Vec3, half: Vec3, delta: Vec3): MoveResult {
  let [px, py, pz] = center;
  let onGround = false;
  const collided: [boolean, boolean, boolean] = [false, false, false];

  // Y axis.
  const tryY = py + delta[1];
  if (boxIntersectsSolid(world, [px, tryY, pz], half)) {
    collided[1] = true;
    if (delta[1] < 0) onGround = true;
  } else {
    py = tryY;
  }

  // X axis.
  const tryX = px + delta[0];
  if (boxIntersectsSolid(world, [tryX, py, pz], half)) {
    collided[0] = true;
  } else {
    px = tryX;
  }

  // Z axis.
  const tryZ = pz + delta[2];
  if (boxIntersectsSolid(world, [px, py, tryZ], half)) {
    collided[2] = true;
  } else {
    pz = tryZ;
  }

  return { pos: [px, py, pz], onGround, collided };
}
