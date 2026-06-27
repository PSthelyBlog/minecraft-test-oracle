import { describe, test, expect } from "vitest";
import fc from "fast-check";
import { World } from "../core/world";
import { Block } from "../core/blocks";
import {
  stepMovement,
  type PlayerState,
  type MovementInput,
  type MovementTuning,
} from "./movement";
import type { Vec3 } from "../core/math";

const TUNING: MovementTuning = {
  walk: 5,
  fly: 10,
  gravity: -28,
  jump: 9,
  half: [0.3, 0.9, 0.3],
};
const NO_INPUT: MovementInput = { forward: 0, strafe: 0, up: 0, jump: false };

function floorWorld(): World {
  const w = new World(16, 24, 16);
  for (let y = 0; y <= 3; y++)
    for (let z = 0; z < w.sizeZ; z++) for (let x = 0; x < w.sizeX; x++) w.set(x, y, z, Block.Stone);
  return w;
}

function player(over: Partial<PlayerState> = {}): PlayerState {
  return {
    pos: [8, 10, 8],
    vel: [0, 0, 0],
    yaw: 0,
    pitch: 0,
    onGround: false,
    flying: false,
    ...over,
  };
}

describe("movement oracle", () => {
  // INVARIANT: gravity strictly decreases vertical velocity each airborne step
  // (no jump, not grounded, not flying). A wrong sign or dropped dt breaks this.
  test("gravity pulls vertical velocity down while airborne", () => {
    fc.assert(
      fc.property(fc.double({ min: 0.001, max: 0.05, noNaN: true }), (dt) => {
        const next = stepMovement(floorWorld(), player({ vel: [0, 0, 0] }), NO_INPUT, dt, TUNING);
        expect(next.vel[1]).toBeCloseTo(TUNING.gravity * dt, 9);
        expect(next.vel[1]).toBeLessThan(0);
      }),
    );
  });

  // GATING: jump only fires when grounded. Pressing jump midair must NOT launch.
  test("jump only applies when on the ground", () => {
    const w = floorWorld();
    // resting ON the floor: box bottom at y=4 ⇒ centre y=4.9 (not embedded in it)
    const grounded = stepMovement(
      w,
      player({ pos: [8, 4.9, 8], onGround: true }),
      { ...NO_INPUT, jump: true },
      0.016,
      TUNING,
    );
    expect(grounded.vel[1]).toBe(TUNING.jump); // launched

    const midair = stepMovement(
      w,
      player({ pos: [8, 12, 8], onGround: false }),
      { ...NO_INPUT, jump: true },
      0.016,
      TUNING,
    );
    expect(midair.vel[1]).toBeLessThanOrEqual(0); // gravity only, no launch
  });

  // METAMORPHIC: diagonal movement is not faster than cardinal movement. The
  // horizontal speed is exactly `walk` whether one axis or two are pressed.
  test("diagonal speed equals cardinal speed (normalized)", () => {
    const w = floorWorld();
    const cardinal = stepMovement(
      w,
      player({ onGround: true }),
      { ...NO_INPUT, forward: 1 },
      0.016,
      TUNING,
    );
    const diagonal = stepMovement(
      w,
      player({ onGround: true }),
      { ...NO_INPUT, forward: 1, strafe: 1 },
      0.016,
      TUNING,
    );
    const sp = (s: PlayerState) => Math.hypot(s.vel[0], s.vel[2]);
    expect(sp(cardinal)).toBeCloseTo(TUNING.walk, 9);
    expect(sp(diagonal)).toBeCloseTo(TUNING.walk, 9);
  });

  // DIRECTION (golden): at yaw=0, W must move toward -Z and D toward +X — and the
  // position must actually advance by velocity*dt. Speed-only oracles are blind to
  // a flipped sin/cos, a swapped forward/strafe sign, or a mis-scaled displacement.
  test("at yaw=0, W goes -Z and D goes +X, and position advances by vel*dt", () => {
    const w = floorWorld();
    const dt = 0.1;
    const fwd = stepMovement(
      w,
      player({ pos: [8, 12, 8], flying: true }),
      { ...NO_INPUT, forward: 1 },
      dt,
      TUNING,
    );
    expect(fwd.vel[0]).toBeCloseTo(0, 9);
    expect(fwd.vel[2]).toBeCloseTo(-TUNING.fly, 9); // -Z
    expect(fwd.pos[2]).toBeCloseTo(8 - TUNING.fly * dt, 9); // displacement applied
    expect(fwd.pos[0]).toBeCloseTo(8, 9);

    const strafe = stepMovement(
      w,
      player({ pos: [8, 12, 8], flying: true }),
      { ...NO_INPUT, strafe: 1 },
      dt,
      TUNING,
    );
    expect(strafe.vel[0]).toBeCloseTo(TUNING.fly, 9); // +X
    expect(strafe.vel[2]).toBeCloseTo(0, 9);
    expect(strafe.pos[0]).toBeCloseTo(8 + TUNING.fly * dt, 9);
    expect(strafe.pos[2]).toBeCloseTo(8, 9);
  });

  // DIRECTION at yaw=π/2 (sin=1, cos=0): needed because at yaw=0 the sin terms are
  // zero, so a flipped sin sign is invisible. Here W must go -X and D must go -Z.
  test("at yaw=π/2, W goes -X and D goes -Z", () => {
    const w = floorWorld();
    const yaw = Math.PI / 2;
    const fwd = stepMovement(
      w,
      player({ pos: [8, 12, 8], flying: true, yaw }),
      { ...NO_INPUT, forward: 1 },
      0.05,
      TUNING,
    );
    expect(fwd.vel[0]).toBeCloseTo(-TUNING.fly, 9); // -X
    expect(fwd.vel[2]).toBeCloseTo(0, 9);

    const strafe = stepMovement(
      w,
      player({ pos: [8, 12, 8], flying: true, yaw }),
      { ...NO_INPUT, strafe: 1 },
      0.05,
      TUNING,
    );
    expect(strafe.vel[2]).toBeCloseTo(-TUNING.fly, 9); // -Z
    expect(strafe.vel[0]).toBeCloseTo(0, 9);
  });

  // FLY: in fly mode gravity is ignored and vertical velocity is driven directly
  // by the up input (no accumulation from the previous step).
  test("flying ignores gravity and uses the up input directly", () => {
    const w = floorWorld();
    const up = stepMovement(
      w,
      player({ pos: [8, 12, 8], flying: true, vel: [0, -50, 0] }),
      { ...NO_INPUT, up: 1 },
      0.016,
      TUNING,
    );
    expect(up.vel[1]).toBe(TUNING.fly);
    const hover = stepMovement(
      w,
      player({ pos: [8, 12, 8], flying: true, vel: [0, -50, 0] }),
      { ...NO_INPUT, up: 0 },
      0.016,
      TUNING,
    );
    expect(hover.vel[1]).toBe(0); // no gravity drift
  });

  // INVARIANT: the player never ends a step embedded in solid ground, and landing
  // on the floor reports onGround. (Delegates to the tested collision resolver, but
  // pins that stepMovement wires it correctly.)
  test("a falling player lands on the floor and is never inside it", () => {
    const w = floorWorld(); // floor top at y=3 → surface plane y=4
    let s = player({ pos: [8, 6, 8], vel: [0, 0, 0] });
    for (let i = 0; i < 200; i++) s = stepMovement(w, s, NO_INPUT, 1 / 60, TUNING);
    expect(s.onGround).toBe(true);
    expect(s.pos[1]).toBeGreaterThanOrEqual(4 - 1e-6); // box bottom rests at/above y=4
    expect(s.pos[1]).toBeLessThan(6); // it actually fell
    expect(s.vel[1]).toBe(0); // vertical velocity bled off on contact (not still accelerating)
  });

  // PURITY: stepMovement does not mutate the input state.
  test("does not mutate the input state", () => {
    const s = player({ pos: [8, 10, 8] as Vec3, vel: [1, 2, 3] });
    const frozenPos = [...s.pos];
    const frozenVel = [...s.vel];
    stepMovement(floorWorld(), s, { forward: 1, strafe: 1, up: 1, jump: true }, 0.016, TUNING);
    expect([...s.pos]).toEqual(frozenPos);
    expect([...s.vel]).toEqual(frozenVel);
  });
});
