/**
 * Minimal 3D vector math used by the voxel core.
 *
 * Kept as plain readonly tuples (not Three.js) so the core logic is pure,
 * dependency-free, and trivially testable in isolation.
 */

export type Vec3 = readonly [number, number, number];

export function add(a: Vec3, b: Vec3): Vec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

export function sub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

export function scale(a: Vec3, s: number): Vec3 {
  return [a[0] * s, a[1] * s, a[2] * s];
}

export function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

export function length(a: Vec3): number {
  return Math.sqrt(dot(a, a));
}

/** Returns a unit-length copy of `a`. A zero vector is returned unchanged. */
export function normalize(a: Vec3): Vec3 {
  const len = length(a);
  if (len === 0) return [0, 0, 0];
  return [a[0] / len, a[1] / len, a[2] / len];
}

/**
 * Unit forward direction for a camera at the given yaw/pitch (radians).
 *
 * Convention (matches the renderer):
 *   - yaw   = 0 looks toward -Z, increasing yaw rotates toward -X (left).
 *   - pitch > 0 looks up (+Y), pitch < 0 looks down.
 *   - The result is always unit length.
 */
export function directionFromYawPitch(yaw: number, pitch: number): Vec3 {
  const cosPitch = Math.cos(pitch);
  return [-Math.sin(yaw) * cosPitch, Math.sin(pitch), -Math.cos(yaw) * cosPitch];
}
