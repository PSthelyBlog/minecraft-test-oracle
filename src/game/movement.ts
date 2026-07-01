/**
 * Pure player-movement step. Extracted from the render shell so the silent-failure
 * surfaces here — gravity integration, jump gating (only when grounded), fly mode,
 * and diagonal-speed normalization — are oracle-testable. All world collision is
 * delegated to the already-tested `moveAndCollide`.
 */

import type { World } from "../core/world";
import { moveAndCollide, submersion } from "../core/physics";
import type { Vec3 } from "../core/math";

export interface PlayerState {
  pos: Vec3;
  vel: readonly [number, number, number];
  yaw: number;
  pitch: number;
  onGround: boolean;
  flying: boolean;
}

export interface MovementInput {
  forward: number; // -1..1 (W - S)
  strafe: number; // -1..1 (D - A)
  up: number; // -1..1 (Space - Shift), only used when flying
  jump: boolean; // Space — jump (on ground) or swim up (submerged)
  crouch: boolean; // Shift — descend: swim down (submerged); no effect on land
  walk: boolean; // Ctrl — hold to move at the slower, precise walk speed (ground only)
}

export interface MovementTuning {
  run: number; // default ground speed
  walk: number; // slower ground speed while Ctrl (input.walk) is held
  fly: number;
  gravity: number; // negative
  jump: number; // positive impulse
  half: Vec3;
  /** Fraction of horizontal + vertical velocity damped at full submersion, `0..1`. */
  swimDrag: number;
  /** Fraction of gravity cancelled at full submersion, `0..1` (1 = neutral buoyancy). */
  buoyancy: number;
  /** Upward velocity of a swim stroke (jump held while submerged). */
  swimUp: number;
}

/**
 * Advance the player by `dt` seconds and return the next state (no mutation of
 * the input). Pure given (world, water, state, input, dt, tuning).
 *
 * When the player box is in water (submersion `s > 0`, walking only) buoyancy scales
 * gravity down by `s·buoyancy`, drag damps both horizontal speed and vertical velocity
 * by `s·swimDrag`, and holding jump swims upward at `swimUp` (or crouch swims downward at
 * `−swimUp`). With `s = 0` every factor is the identity, so dry movement is exactly as
 * before — a strict extension (crouch does nothing on land).
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

  // Submersion drives buoyancy + drag (none while flying). `drag` is the keep-fraction
  // of velocity; with swimDrag ≤ 1 it stays in [1−swimDrag, 1] > 0, so it never reverses
  // a velocity's sign — it only slows.
  const s = state.flying ? 0 : submersion(world, water, state.pos, t.half);
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
  const res = moveAndCollide(world, state.pos, t.half, delta);

  // A vertical collision (floor or ceiling) bleeds off vertical velocity.
  if (res.collided[1]) vy = 0;

  return {
    ...state,
    pos: res.pos,
    vel: [vx, vy, vz],
    onGround: res.onGround,
  };
}
