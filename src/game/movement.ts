/**
 * Pure player-movement step. Extracted from the render shell so the silent-failure
 * surfaces here — gravity integration, jump gating (only when grounded), fly mode,
 * and diagonal-speed normalization — are oracle-testable. All world collision is
 * delegated to the already-tested `moveAndCollide`.
 */

import type { World } from "../core/world";
import { moveAndCollide } from "../core/physics";
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
  jump: boolean; // Space, used when walking
}

export interface MovementTuning {
  walk: number;
  fly: number;
  gravity: number; // negative
  jump: number; // positive impulse
  half: Vec3;
}

/**
 * Advance the player by `dt` seconds and return the next state (no mutation of
 * the input). Pure given (world, state, input, dt, tuning).
 */
export function stepMovement(
  world: World,
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

  const speed = state.flying ? t.fly : t.walk;
  const vx = mx * speed;
  const vz = mz * speed;
  let vy = state.vel[1];

  if (state.flying) {
    vy = input.up * t.fly;
  } else {
    vy += t.gravity * dt;
    if (state.onGround && input.jump) vy = t.jump;
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
