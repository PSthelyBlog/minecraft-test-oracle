/**
 * Voxel ray cast (Amanatides & Woo "A Fast Voxel Traversal Algorithm").
 *
 * Walks the integer voxel grid from `origin` along unit `dir`, returning the
 * first solid block hit together with the face normal of entry — exactly what
 * block breaking (hit cell) and placing (hit cell + normal) need.
 *
 * This is a classic silent-failure surface: a wrong tMax/tDelta or step sign
 * yields a plausible-looking but subtly off selection, so it is oracle-tested.
 */

import type { World } from "./world";
import { isSolid } from "./blocks";
import type { Vec3 } from "./math";

export interface RayHit {
  /** Voxel coordinates of the solid block that was hit. */
  readonly block: Vec3;
  /** Unit face normal of the side the ray entered through (one axis ±1). */
  readonly normal: Vec3;
  /** Coordinates of the empty cell adjacent to the hit face (block + normal). */
  readonly place: Vec3;
  /** Distance from origin to the entry point, in world units. */
  readonly distance: number;
}

/**
 * @param world   world to traverse
 * @param origin  ray start (world units; e.g. the camera/eye position)
 * @param dir     ray direction (need not be normalized; zero vector ⇒ no hit)
 * @param maxDist maximum reach in world units
 * @param isHit   predicate for "stop here" (default: block is solid)
 */
export function raycast(
  world: World,
  origin: Vec3,
  dir: Vec3,
  maxDist: number,
  isHit: (id: number) => boolean = isSolid,
): RayHit | null {
  let [dx, dy, dz] = dir;
  const dirLen = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (dirLen === 0 || maxDist <= 0) return null;
  // Normalize so that `distance` accumulates in true world units.
  dx /= dirLen;
  dy /= dirLen;
  dz /= dirLen;

  // Current voxel (floor of the origin).
  let x = Math.floor(origin[0]);
  let y = Math.floor(origin[1]);
  let z = Math.floor(origin[2]);

  const stepX = dx > 0 ? 1 : dx < 0 ? -1 : 0;
  const stepY = dy > 0 ? 1 : dy < 0 ? -1 : 0;
  const stepZ = dz > 0 ? 1 : dz < 0 ? -1 : 0;

  // Distance (in t, where position = origin + t*dir) to the next grid line per axis.
  const tDeltaX = dx !== 0 ? Math.abs(1 / dx) : Infinity;
  const tDeltaY = dy !== 0 ? Math.abs(1 / dy) : Infinity;
  const tDeltaZ = dz !== 0 ? Math.abs(1 / dz) : Infinity;

  // t to the first voxel boundary on each axis.
  let tMaxX = boundaryT(origin[0], dx, stepX);
  let tMaxY = boundaryT(origin[1], dy, stepY);
  let tMaxZ = boundaryT(origin[2], dz, stepZ);

  // If we start inside a solid block, the entry is the origin itself.
  if (isHit(world.get(x, y, z))) {
    return { block: [x, y, z], normal: [0, 0, 0], place: [x, y, z], distance: 0 };
  }

  let normal: Vec3 = [0, 0, 0];
  let t = 0;

  while (t <= maxDist) {
    // Advance into the neighbouring voxel across the nearest boundary.
    if (tMaxX <= tMaxY && tMaxX <= tMaxZ) {
      x += stepX;
      t = tMaxX;
      tMaxX += tDeltaX;
      normal = [-stepX, 0, 0];
    } else if (tMaxY <= tMaxZ) {
      y += stepY;
      t = tMaxY;
      tMaxY += tDeltaY;
      normal = [0, -stepY, 0];
    } else {
      z += stepZ;
      t = tMaxZ;
      tMaxZ += tDeltaZ;
      normal = [0, 0, -stepZ];
    }

    if (t > maxDist) break;

    if (isHit(world.get(x, y, z))) {
      return {
        block: [x, y, z],
        normal,
        place: [x + normal[0], y + normal[1], z + normal[2]],
        distance: t,
      };
    }
  }

  return null;
}

/** t at which the ray first crosses a voxel boundary on one axis. */
function boundaryT(o: number, d: number, step: number): number {
  if (step === 0) return Infinity;
  const cell = Math.floor(o);
  // Next boundary is the far edge of the current cell in the travel direction.
  const nextBoundary = step > 0 ? cell + 1 : cell;
  return (nextBoundary - o) / d;
}
