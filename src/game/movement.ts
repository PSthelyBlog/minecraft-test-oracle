/**
 * Pure player-movement step. Extracted from the render shell so the silent-failure
 * surfaces here — gravity integration, jump gating (only when grounded), fly mode,
 * and diagonal-speed normalization — are oracle-testable. All world collision is
 * delegated to the already-tested `moveAndCollide`.
 */

import type { World } from "../core/world";
import { moveAndCollide, submersion, boxIntersectsSolid } from "../core/physics";
import type { Vec3 } from "../core/math";

export interface PlayerState {
  pos: Vec3;
  vel: readonly [number, number, number];
  yaw: number;
  pitch: number;
  onGround: boolean;
  flying: boolean;
  crouching: boolean; // in the crouched posture (shorter box + lower eye)
}

export interface MovementInput {
  forward: number; // -1..1 (W - S)
  strafe: number; // -1..1 (D - A)
  up: number; // -1..1 (Space - Shift), only used when flying
  jump: boolean; // Space — jump (on ground) or swim up (submerged)
  crouch: boolean; // Shift — crouch posture (not flying) + swim down (submerged)
  walk: boolean; // Ctrl — hold to move at the slower, precise walk speed (ground only)
}

export interface MovementTuning {
  run: number; // default ground speed
  walk: number; // slower ground speed while Ctrl (input.walk) is held
  fly: number;
  gravity: number; // negative
  jump: number; // positive impulse
  half: Vec3; // standing AABB half-extents
  /** Crouched AABB half-height (< `half[1]`); the box shrinks from the top, feet anchored. */
  crouchHalfY: number;
  /** Fraction of horizontal + vertical velocity damped at full submersion, `0..1`. */
  swimDrag: number;
  /** Fraction of gravity cancelled at full submersion, `0..1` (1 = neutral buoyancy). */
  buoyancy: number;
  /** Upward velocity of a swim stroke (jump held while submerged). */
  swimUp: number;
}

/**
 * Resolve the crouch posture for this step, anchored at the FEET.
 *
 * The box shrinks from the top: crouching keeps the box bottom (`pos.y − half.y`) fixed and
 * lowers the head/eye, so it never lifts you off a floor or clips your feet down. Standing
 * back up grows the box upward from the same feet — but only if the taller standing box has
 * headroom (no solid), otherwise you stay crouched (you can't stand into a ceiling). Pure:
 * returns the position, half-extents, and crouch flag to use; never mutates.
 */
export function resolveCrouch(
  world: World,
  pos: Vec3,
  wasCrouching: boolean,
  wantCrouch: boolean,
  standHalf: Vec3,
  crouchHalf: Vec3,
): { pos: Vec3; half: Vec3; crouching: boolean } {
  const prevHalfY = wasCrouching ? crouchHalf[1] : standHalf[1];
  const feetY = pos[1] - prevHalfY; // the anchor: box bottom, unchanged by any transition

  if (wantCrouch && !wasCrouching) {
    // Crouch down: shrink from the top, feet fixed.
    return { pos: [pos[0], feetY + crouchHalf[1], pos[2]], half: crouchHalf, crouching: true };
  }
  if (!wantCrouch && wasCrouching) {
    // Try to stand: only if the taller box fits at the feet-anchored standing centre.
    const standCenter: Vec3 = [pos[0], feetY + standHalf[1], pos[2]];
    if (!boxIntersectsSolid(world, standCenter, standHalf)) {
      return { pos: standCenter, half: standHalf, crouching: false };
    }
    // Blocked by a ceiling — stay crouched (box unchanged).
    return { pos, half: crouchHalf, crouching: true };
  }
  // No transition: keep the current posture's half.
  return { pos, half: wasCrouching ? crouchHalf : standHalf, crouching: wasCrouching };
}

/**
 * Advance the player by `dt` seconds and return the next state (no mutation of
 * the input). Pure given (world, water, state, input, dt, tuning).
 *
 * Holding crouch (while not flying) enters the crouched posture via `resolveCrouch` — a
 * shorter, feet-anchored box — before the movement is integrated.
 *
 * When the player box is in water (submersion `s > 0`, walking only) buoyancy scales
 * gravity down by `s·buoyancy`, drag damps both horizontal speed and vertical velocity
 * by `s·swimDrag`, and holding jump swims upward at `swimUp` (or crouch swims downward at
 * `−swimUp`). With `s = 0` every factor is the identity, so dry movement is exactly as before.
 */
export function stepMovement(
  world: World,
  water: Uint8Array,
  state: PlayerState,
  input: MovementInput,
  dt: number,
  t: MovementTuning,
): PlayerState {
  const sin = Math.sin(state.yaw),
    cos = Math.cos(state.yaw);
  const fwd: Vec3 = [-sin, 0, -cos];
  const right: Vec3 = [cos, 0, -sin];

  let mx = fwd[0] * input.forward + right[0] * input.strafe;
  let mz = fwd[2] * input.forward + right[2] * input.strafe;
  const mlen = Math.hypot(mx, mz);
  if (mlen > 0) {
    mx /= mlen;
    mz /= mlen;
  } // normalize so diagonals aren't faster

  // Crouch posture (Shift while not flying): shrink the box from the top, feet anchored,
  // gated so you can't stand back up into a ceiling. Resolved before movement so this step
  // uses the crouched position + half. Flying keeps Shift for descend (input.up), not crouch.
  const crouchHalf: Vec3 = [t.half[0], t.crouchHalfY, t.half[2]];
  const c = resolveCrouch(
    world,
    state.pos,
    state.crouching,
    input.crouch && !state.flying,
    t.half,
    crouchHalf,
  );
  const half = c.half;

  // Submersion drives buoyancy + drag (none while flying). `drag` is the keep-fraction
  // of velocity; with swimDrag ≤ 1 it stays in [1−swimDrag, 1] > 0, so it never reverses
  // a velocity's sign — it only slows.
  const s = state.flying ? 0 : submersion(world, water, c.pos, half);
  const drag = 1 - t.swimDrag * s;

  // Ground speed is the run default, or the slower walk while Ctrl is held. Flying is
  // unaffected by the walk modifier (it has its own single speed).
  const ground = input.walk ? t.walk : t.run;
  const speed = state.flying ? t.fly : ground;
  const vx = mx * speed * drag;
  const vz = mz * speed * drag;
  let vy = state.vel[1];

  if (state.flying) {
    vy = input.up * t.fly;
  } else {
    vy += t.gravity * dt * (1 - s * t.buoyancy); // buoyancy lightens gravity underwater
    vy *= drag; // drag damps the fall/rise
    if (s > 0 && input.jump)
      vy = t.swimUp; // swim-stroke upward while submerged
    else if (s > 0 && input.crouch)
      vy = -t.swimUp; // swim-stroke downward while submerged (mirror of jump)
    else if (state.onGround && input.jump) vy = t.jump; // normal jump on ground
  }

  const delta: Vec3 = [vx * dt, vy * dt, vz * dt];
  const res = moveAndCollide(world, c.pos, half, delta);

  // A vertical collision (floor or ceiling) bleeds off vertical velocity.
  if (res.collided[1]) vy = 0;

  return {
    ...state,
    pos: res.pos,
    vel: [vx, vy, vz],
    onGround: res.onGround,
    crouching: c.crouching,
  };
}
