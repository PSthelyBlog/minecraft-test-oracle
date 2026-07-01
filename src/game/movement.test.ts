import { describe, test, expect } from "vitest";
import fc from "fast-check";
import { World } from "../core/world";
import { Block } from "../core/blocks";
import { boxIntersectsSolid } from "../core/physics";
import {
  stepMovement,
  resolveCrouch,
  type PlayerState,
  type MovementInput,
  type MovementTuning,
} from "./movement";
import type { Vec3 } from "../core/math";

const TUNING: MovementTuning = {
  run: 5,
  walk: 3,
  fly: 10,
  gravity: -28,
  jump: 9,
  half: [0.3, 0.9, 0.3],
  crouchHalfY: 0.75, // 1.5 tall crouched (vs 1.8 standing)
  swimDrag: 0.5,
  buoyancy: 0.8,
  swimUp: 4,
};
const NO_INPUT: MovementInput = {
  forward: 0,
  strafe: 0,
  up: 0,
  jump: false,
  crouch: false,
  walk: false,
};

// All movement test worlds are 16×24×16; this all-dry water field keeps submersion 0, so
// these dry-movement oracles exercise the strict-extension (s = 0) path unchanged.
const DRY = new Uint8Array(16 * 24 * 16);

function floorWorld(): World {
  const w = new World(16, 24, 16);
  for (let y = 0; y <= 3; y++)
    for (let z = 0; z < w.sizeZ; z++) for (let x = 0; x < w.sizeX; x++) w.set(x, y, z, Block.Stone);
  return w;
}

const fullWater = (): Uint8Array => new Uint8Array(16 * 24 * 16).fill(1);
// Water field wet for every cell strictly below `yLimit` (a flat pool with surface at yLimit).
function waterBelowY(yLimit: number): Uint8Array {
  const w = new World(16, 24, 16);
  const field = new Uint8Array(w.volume);
  for (let y = 0; y < yLimit && y < 24; y++)
    for (let z = 0; z < 16; z++) for (let x = 0; x < 16; x++) field[w.index(x, y, z)] = 1;
  return field;
}

function player(over: Partial<PlayerState> = {}): PlayerState {
  return {
    pos: [8, 10, 8],
    vel: [0, 0, 0],
    yaw: 0,
    pitch: 0,
    onGround: false,
    flying: false,
    crouching: false,
    ...over,
  };
}

describe("movement oracle", () => {
  // INVARIANT: gravity strictly decreases vertical velocity each airborne step
  // (no jump, not grounded, not flying). A wrong sign or dropped dt breaks this.
  test("gravity pulls vertical velocity down while airborne", () => {
    fc.assert(
      fc.property(fc.double({ min: 0.001, max: 0.05, noNaN: true }), (dt) => {
        const next = stepMovement(
          floorWorld(),
          DRY,
          player({ vel: [0, 0, 0] }),
          NO_INPUT,
          dt,
          TUNING,
        );
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
      DRY,
      player({ pos: [8, 4.9, 8], onGround: true }),
      { ...NO_INPUT, jump: true },
      0.016,
      TUNING,
    );
    expect(grounded.vel[1]).toBe(TUNING.jump); // launched

    const midair = stepMovement(
      w,
      DRY,
      player({ pos: [8, 12, 8], onGround: false }),
      { ...NO_INPUT, jump: true },
      0.016,
      TUNING,
    );
    expect(midair.vel[1]).toBeLessThanOrEqual(0); // gravity only, no launch
  });

  // METAMORPHIC: diagonal movement is not faster than cardinal movement. The default
  // (no walk modifier) horizontal speed is exactly `run`, one axis or two.
  const horizSpeed = (s: PlayerState) => Math.hypot(s.vel[0], s.vel[2]);
  test("diagonal speed equals cardinal speed (normalized)", () => {
    const w = floorWorld();
    const cardinal = stepMovement(
      w,
      DRY,
      player({ onGround: true }),
      { ...NO_INPUT, forward: 1 },
      0.016,
      TUNING,
    );
    const diagonal = stepMovement(
      w,
      DRY,
      player({ onGround: true }),
      { ...NO_INPUT, forward: 1, strafe: 1 },
      0.016,
      TUNING,
    );
    expect(horizSpeed(cardinal)).toBeCloseTo(TUNING.run, 9);
    expect(horizSpeed(diagonal)).toBeCloseTo(TUNING.run, 9);
  });

  // DEFAULT IS RUN, not walk: a plain input (walk flag off) moves at `run`. Pins the
  // ground-speed ternary's default branch — a swapped ternary would give `walk` here.
  test("default ground speed is run (not walk)", () => {
    const step = stepMovement(
      floorWorld(),
      DRY,
      player({ onGround: true }),
      { ...NO_INPUT, forward: 1 },
      0.016,
      TUNING,
    );
    expect(horizSpeed(step)).toBeCloseTo(TUNING.run, 9);
    expect(TUNING.run).not.toBeCloseTo(TUNING.walk, 9); // the tiers are genuinely distinct
  });

  // METAMORPHIC (walk tier): holding Ctrl (input.walk) scales the horizontal speed by
  // EXACTLY walk/run, for every direction — an independent magnitude re-derivation over
  // random yaw + forward/strafe. Kills any wrong scalar or a run/walk swap.
  test("walk modifier scales horizontal speed by exactly walk/run, at both tiers diagonal-safe", () => {
    const w = floorWorld();
    fc.assert(
      fc.property(
        fc.double({ min: -Math.PI, max: Math.PI, noNaN: true }),
        fc.integer({ min: -1, max: 1 }),
        fc.integer({ min: -1, max: 1 }),
        (yaw, forward, strafe) => {
          fc.pre(forward !== 0 || strafe !== 0); // need actual movement to compare speeds
          const start = player({ onGround: true, yaw });
          const run = stepMovement(w, DRY, start, { ...NO_INPUT, forward, strafe }, 0.016, TUNING);
          const walk = stepMovement(
            w,
            DRY,
            start,
            { ...NO_INPUT, forward, strafe, walk: true },
            0.016,
            TUNING,
          );
          // walk tier is exactly the run speed × (walk/run)
          expect(horizSpeed(walk)).toBeCloseTo(horizSpeed(run) * (TUNING.walk / TUNING.run), 9);
          // and each tier is direction-normalized to its own top speed (diagonal-safe)
          const top = Math.hypot(forward, strafe) > 0 ? TUNING.run : 0;
          expect(horizSpeed(run)).toBeCloseTo(top, 9);
        },
      ),
    );
  });

  // STRICT EXTENSION: the walk modifier is GROUND-only — flying ignores it (flying has its
  // own single speed), so a flying step is identical with the flag on or off.
  test("walk modifier has no effect while flying", () => {
    const start = player({ pos: [8, 12, 8], flying: true });
    const normal = stepMovement(
      floorWorld(),
      DRY,
      start,
      { ...NO_INPUT, forward: 1 },
      0.016,
      TUNING,
    );
    const held = stepMovement(
      floorWorld(),
      DRY,
      start,
      { ...NO_INPUT, forward: 1, walk: true },
      0.016,
      TUNING,
    );
    expect(horizSpeed(held)).toBeCloseTo(horizSpeed(normal), 9);
    expect(horizSpeed(normal)).toBeCloseTo(TUNING.fly, 9); // fly speed, not run/walk
  });

  // DIRECTION (golden): at yaw=0, W must move toward -Z and D toward +X — and the
  // position must actually advance by velocity*dt. Speed-only oracles are blind to
  // a flipped sin/cos, a swapped forward/strafe sign, or a mis-scaled displacement.
  test("at yaw=0, W goes -Z and D goes +X, and position advances by vel*dt", () => {
    const w = floorWorld();
    const dt = 0.1;
    const fwd = stepMovement(
      w,
      DRY,
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
      DRY,
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
      DRY,
      player({ pos: [8, 12, 8], flying: true, yaw }),
      { ...NO_INPUT, forward: 1 },
      0.05,
      TUNING,
    );
    expect(fwd.vel[0]).toBeCloseTo(-TUNING.fly, 9); // -X
    expect(fwd.vel[2]).toBeCloseTo(0, 9);

    const strafe = stepMovement(
      w,
      DRY,
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
      DRY,
      player({ pos: [8, 12, 8], flying: true, vel: [0, -50, 0] }),
      { ...NO_INPUT, up: 1 },
      0.016,
      TUNING,
    );
    expect(up.vel[1]).toBe(TUNING.fly);
    const hover = stepMovement(
      w,
      DRY,
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
    for (let i = 0; i < 200; i++) s = stepMovement(w, DRY, s, NO_INPUT, 1 / 60, TUNING);
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
    stepMovement(
      floorWorld(),
      DRY,
      s,
      { forward: 1, strafe: 1, up: 1, jump: true, crouch: true, walk: true },
      0.016,
      TUNING,
    );
    expect([...s.pos]).toEqual(frozenPos);
    expect([...s.vel]).toEqual(frozenVel);
  });
});

describe("swim physics (submersion-driven buoyancy & drag)", () => {
  const W = floorWorld(); // box stays at y≥10 in open air above the floor → no collision

  // STRICT EXTENSION: out of water (s = 0) the swim terms vanish — a dry step is exactly
  // gravity, byte-identical to pre-swim movement. (DRY field ⇒ submersion 0.)
  test("out of water (s=0) the swim tuning has no effect", () => {
    const dt = 0.02;
    const next = stepMovement(W, DRY, player({ pos: [8, 12, 8] }), NO_INPUT, dt, TUNING);
    expect(next.vel[1]).toBeCloseTo(TUNING.gravity * dt, 9); // pure gravity, no buoyancy/drag
  });

  // GOLDEN (buoyancy + drag): fully submerged, a falling player's vertical velocity is
  // (vy0 + gravity·dt·(1−buoyancy)) · (1−swimDrag), re-derived from the tuning — and is
  // strictly less negative than the same dry step (water slows the fall).
  test("fully submerged: gravity is lightened then damped, slower than a dry fall", () => {
    const dt = 0.02;
    const start = player({ pos: [8, 10, 8], vel: [0, -5, 0] });
    const wet = stepMovement(W, fullWater(), start, NO_INPUT, dt, TUNING).vel[1];
    const dry = stepMovement(W, DRY, start, NO_INPUT, dt, TUNING).vel[1];
    const expected =
      (start.vel[1] + TUNING.gravity * dt * (1 - TUNING.buoyancy)) * (1 - TUNING.swimDrag);
    expect(wet).toBeCloseTo(expected, 9);
    expect(wet).toBeGreaterThan(dry); // less negative — buoyancy + drag slow the descent
  });

  // DRAG (horizontal): fully submerged, walking speed is scaled by (1−swimDrag) and is
  // strictly slower than dry. Moving DIAGONALLY (forward + strafe) so BOTH the x and z
  // velocity components are non-zero — each must be damped (not just the resultant speed).
  test("fully submerged: both horizontal components are damped by drag", () => {
    const dt = 0.016;
    const input = { ...NO_INPUT, forward: 1, strafe: 1 };
    const wet = stepMovement(W, fullWater(), player({ pos: [8, 10, 8] }), input, dt, TUNING);
    const dry = stepMovement(W, DRY, player({ pos: [8, 10, 8] }), input, dt, TUNING);
    const sp = (s: PlayerState): number => Math.hypot(s.vel[0], s.vel[2]);
    expect(sp(wet)).toBeCloseTo(TUNING.run * (1 - TUNING.swimDrag), 9); // default (run) × drag
    // each component scaled by exactly (1 − swimDrag) vs the dry step (pins x and z, not just speed)
    expect(Math.abs(wet.vel[0])).toBeCloseTo(Math.abs(dry.vel[0]) * (1 - TUNING.swimDrag), 9);
    expect(Math.abs(wet.vel[2])).toBeCloseTo(Math.abs(dry.vel[2]) * (1 - TUNING.swimDrag), 9);
    expect(Math.abs(wet.vel[0])).toBeGreaterThan(0); // genuinely moving on x (mx ≠ 0)
  });

  // SWIM-UP: holding jump while submerged strokes upward at `swimUp` even when NOT on the
  // ground (you can't normally jump midair) — so a submerged player can rise to the surface.
  test("swim stroke: jump while submerged rises, even off the ground", () => {
    const up = stepMovement(W, fullWater(), player({ pos: [8, 10, 8], onGround: false }), { ...NO_INPUT, jump: true }, 0.016, TUNING); // prettier-ignore
    expect(up.vel[1]).toBe(TUNING.swimUp); // upward stroke
    expect(up.pos[1]).toBeGreaterThan(10); // actually rose
    // dry + midair + jump must NOT launch (gating still holds out of water)
    const dryMid = stepMovement(W, DRY, player({ pos: [8, 10, 8], onGround: false }), { ...NO_INPUT, jump: true }, 0.016, TUNING); // prettier-ignore
    expect(dryMid.vel[1]).toBeLessThanOrEqual(0);
  });

  // SWIM-DOWN (mirror of swim-up): holding crouch while submerged strokes downward at
  // −swimUp and the player descends — the exact negation of the jump stroke.
  test("swim stroke: crouch while submerged dives, the mirror of jump", () => {
    const start = player({ pos: [8, 10, 8], onGround: false });
    const down = stepMovement(W, fullWater(), start, { ...NO_INPUT, crouch: true }, 0.016, TUNING);
    const up = stepMovement(W, fullWater(), start, { ...NO_INPUT, jump: true }, 0.016, TUNING);
    expect(down.vel[1]).toBe(-TUNING.swimUp); // downward stroke
    expect(down.vel[1]).toBe(-up.vel[1]); // exact negation of the up stroke
    expect(down.pos[1]).toBeLessThan(10); // actually sank
  });

  // POSTURE-ONLY: crouch changes the box, never the velocity (Ctrl owns "slow"). A dry step
  // with crouch held has identical velocity to one without, but enters the crouched posture
  // and drops the centre by exactly (standHalfY − crouchHalfY) — feet anchored.
  test("crouch is posture-only: lowers the box without changing velocity", () => {
    const dt = 0.02;
    const start = player({ pos: [8, 12, 8] }); // standing, midair
    const withCrouch = stepMovement(W, DRY, start, { ...NO_INPUT, crouch: true }, dt, TUNING);
    const without = stepMovement(W, DRY, start, NO_INPUT, dt, TUNING);
    expect(withCrouch.vel).toEqual(without.vel); // velocity untouched
    expect(withCrouch.vel[1]).toBeCloseTo(TUNING.gravity * dt, 9); // pure gravity either way
    expect(withCrouch.crouching).toBe(true);
    expect(without.crouching).toBe(false);
    // both fell by the same vy·dt, so the residual gap is exactly the crouch centre drop
    expect(without.pos[1] - withCrouch.pos[1]).toBeCloseTo(TUNING.half[1] - TUNING.crouchHalfY, 9);
  });

  // METAMORPHIC (monotonic): the deeper the submersion, the less negative a falling
  // player's vertical velocity — dry < half-submerged < fully submerged.
  test("metamorphic: deeper submersion ⇒ a slower (less negative) fall", () => {
    const dt = 0.02;
    const start = player({ pos: [8, 10, 8], vel: [0, -5, 0] });
    const dry = stepMovement(W, DRY, start, NO_INPUT, dt, TUNING).vel[1];
    const half = stepMovement(W, waterBelowY(10), start, NO_INPUT, dt, TUNING).vel[1]; // box half under
    const full = stepMovement(W, fullWater(), start, NO_INPUT, dt, TUNING).vel[1];
    expect(dry).toBeLessThan(half);
    expect(half).toBeLessThan(full);
  });

  // BOUNDED INVARIANT: drag only ever slows — over random submersion depth, downward
  // input vy, and walk direction, the submerged step never speeds the fall vs dry and
  // never reverses the horizontal velocity's sign (the keep-fraction stays in (0,1]).
  test("invariant: drag slows but never reverses or speeds up", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 24 }), // pool surface height → submersion depth
        fc.double({ min: -10, max: 0, noNaN: true }), // a downward (or zero) vy
        fc.constantFrom(-1, 0, 1), // forward input
        (yLimit, vy0, forward) => {
          const start = player({ pos: [8, 10, 8], vel: [0, vy0, 0] });
          const wet = stepMovement(W, waterBelowY(yLimit), start, { ...NO_INPUT, forward }, 0.02, TUNING); // prettier-ignore
          const dry = stepMovement(W, DRY, start, { ...NO_INPUT, forward }, 0.02, TUNING);
          // never accelerates the fall beyond dry; horizontal keeps dry's sign, magnitude ≤ dry.
          expect(wet.vel[1]).toBeGreaterThanOrEqual(dry.vel[1] - 1e-9);
          expect(Math.sign(wet.vel[2]) === 0 || Math.sign(wet.vel[2]) === Math.sign(dry.vel[2])).toBe(true); // prettier-ignore
          expect(Math.abs(wet.vel[2])).toBeLessThanOrEqual(Math.abs(dry.vel[2]) + 1e-9);
        },
      ),
      { numRuns: 200 },
    );
  });
});

describe("crouch posture (resolveCrouch)", () => {
  const STAND_HALF: Vec3 = TUNING.half;
  const CROUCH_HALF: Vec3 = [TUNING.half[0], TUNING.crouchHalfY, TUNING.half[2]];
  const dHalf = STAND_HALF[1] - TUNING.crouchHalfY; // centre drop / rise on a toggle (0.15)
  const bottom = (pos: Vec3, half: Vec3) => pos[1] - half[1]; // the anchored feet line

  // FEET-ANCHOR (crouch down): standing → crouch shrinks the box from the TOP. The box
  // bottom is unchanged, the centre drops by dHalf, and the head drops by 2·dHalf.
  test("crouch down keeps the feet, drops the head", () => {
    const w = floorWorld();
    const pos: Vec3 = [8, 4.9, 8]; // standing on the floor: feet at 4.0
    const r = resolveCrouch(w, pos, false, true, STAND_HALF, CROUCH_HALF);
    expect(r.crouching).toBe(true);
    expect(r.half).toEqual(CROUCH_HALF);
    expect(bottom(r.pos, r.half)).toBeCloseTo(bottom(pos, STAND_HALF), 9); // feet fixed
    expect(pos[1] - r.pos[1]).toBeCloseTo(dHalf, 9); // centre dropped by dHalf
    const headBefore = pos[1] + STAND_HALF[1];
    const headAfter = r.pos[1] + r.half[1];
    expect(headBefore - headAfter).toBeCloseTo(2 * dHalf, 9); // head dropped by 2·dHalf
    expect([r.pos[0], r.pos[2]]).toEqual([pos[0], pos[2]]); // x/z untouched
  });

  // NO-OP branches: no transition leaves position + half exactly as they were.
  test("no transition keeps the current posture", () => {
    const w = floorWorld();
    const standing: Vec3 = [8, 4.9, 8];
    const stay = resolveCrouch(w, standing, false, false, STAND_HALF, CROUCH_HALF);
    expect(stay).toEqual({ pos: standing, half: STAND_HALF, crouching: false });

    const crouched: Vec3 = [8, 4.75, 8];
    const held = resolveCrouch(w, crouched, true, true, STAND_HALF, CROUCH_HALF);
    expect(held).toEqual({ pos: crouched, half: CROUCH_HALF, crouching: true });
  });

  // STAND UP (clear headroom): crouched → stand grows the box UP from the same feet.
  test("stand up with headroom raises the head, feet fixed", () => {
    const w = floorWorld(); // open air well above the floor
    const crouched: Vec3 = [8, 8.75, 8]; // feet at 8.0
    const r = resolveCrouch(w, crouched, true, false, STAND_HALF, CROUCH_HALF);
    expect(r.crouching).toBe(false);
    expect(r.half).toEqual(STAND_HALF);
    expect(bottom(r.pos, r.half)).toBeCloseTo(bottom(crouched, CROUCH_HALF), 9); // feet fixed
    expect(r.pos[1] - crouched[1]).toBeCloseTo(dHalf, 9); // centre rose by dHalf
  });

  // STAND UP (blocked): a ceiling within the standing head-room but above the crouched head
  // must keep you crouched — standing would clip you into the block. Independently re-derived:
  // the crouched box is clear of the ceiling, the standing box is not.
  test("stand up is refused when a ceiling has no head-room", () => {
    const w = new World(16, 24, 16);
    w.set(8, 6, 8, Block.Stone); // ceiling occupying cell y∈[6,7]
    const crouched: Vec3 = [8, 5.25, 8]; // feet at 4.5; crouched head 6.0 (clears), standing head 6.3 (hits)
    const standCenter: Vec3 = [8, 4.5 + STAND_HALF[1], 8]; // where standing would put the centre
    // independent witness: crouched fits, standing does not
    expect(boxIntersectsSolid(w, crouched, CROUCH_HALF)).toBe(false);
    expect(boxIntersectsSolid(w, standCenter, STAND_HALF)).toBe(true);
    const r = resolveCrouch(w, crouched, true, false, STAND_HALF, CROUCH_HALF);
    expect(r.crouching).toBe(true); // stayed crouched
    expect(r).toEqual({ pos: crouched, half: CROUCH_HALF, crouching: true });
  });

  // FEET-ANCHOR INVARIANT (metamorphic, headline): for ANY world, position, and toggle, the
  // box bottom (feet) is invariant and x/z never move — the anchor never slips. Re-derives
  // the feet line from the PRE-state half, independent of which branch resolveCrouch takes.
  test("box bottom is invariant across every transition", () => {
    const w = floorWorld();
    w.set(8, 8, 8, Block.Stone); // a mid-air obstacle so the stand-up-blocked branch is exercised
    fc.assert(
      fc.property(
        fc.double({ min: 3, max: 12, noNaN: true }), // pos.y
        fc.boolean(), // wasCrouching
        fc.boolean(), // wantCrouch
        (y, was, want) => {
          const prevHalfY = was ? CROUCH_HALF[1] : STAND_HALF[1];
          const pos: Vec3 = [8.4, y, 8.4];
          const r = resolveCrouch(w, pos, was, want, STAND_HALF, CROUCH_HALF);
          expect(bottom(r.pos, r.half)).toBeCloseTo(pos[1] - prevHalfY, 9); // feet never move
          expect([r.pos[0], r.pos[2]]).toEqual([pos[0], pos[2]]); // x/z never move
          expect([STAND_HALF[1], CROUCH_HALF[1]]).toContain(r.half[1]); // half is one of the two
        },
      ),
    );
  });

  // GATE: flying keeps Shift for descend, so a flying step never enters the crouch posture.
  test("flying ignores crouch (Shift stays descend)", () => {
    const start = player({ pos: [8, 12, 8], flying: true });
    const step = stepMovement(
      floorWorld(),
      DRY,
      start,
      { ...NO_INPUT, crouch: true },
      0.016,
      TUNING,
    );
    expect(step.crouching).toBe(false);
  });
});
