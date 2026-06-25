import { describe, test, expect } from "vitest";
import fc from "fast-check";
import { add, sub, scale, dot, length, normalize, directionFromYawPitch } from "./math";

const real = fc.double({ min: -1000, max: 1000, noNaN: true, noDefaultInfinity: true });
const vec = fc.tuple(real, real, real);

describe("math oracle", () => {
  // INVARIANT: a camera direction is ALWAYS unit length, for every angle.
  // A dropped cos(pitch) factor or a swapped sin/cos breaks this loudly.
  test("directionFromYawPitch is always unit length", () => {
    fc.assert(
      fc.property(real, fc.double({ min: -1.5, max: 1.5, noNaN: true }), (yaw, pitch) => {
        expect(length(directionFromYawPitch(yaw, pitch))).toBeCloseTo(1, 10);
      }),
    );
  });

  // GOLDEN: the documented convention is pinned. yaw=0,pitch=0 looks down -Z.
  test("golden: canonical angles map to canonical axes", () => {
    const eps = 1e-12;
    const near = (v: readonly number[], e: readonly number[]) =>
      v.every((c, i) => Math.abs(c - e[i]) < eps);
    expect(near(directionFromYawPitch(0, 0), [0, 0, -1])).toBe(true);
    expect(near(directionFromYawPitch(0, Math.PI / 2), [0, 1, 0])).toBe(true); // straight up
    expect(near(directionFromYawPitch(Math.PI / 2, 0), [-1, 0, 0])).toBe(true); // yaw left
    expect(near(directionFromYawPitch(Math.PI, 0), [0, 0, 1])).toBe(true); // behind
  });

  // METAMORPHIC: yaw is periodic in 2π — same look direction.
  test("metamorphic: yaw is 2π-periodic", () => {
    fc.assert(
      fc.property(real, fc.double({ min: -1.5, max: 1.5, noNaN: true }), (yaw, pitch) => {
        const a = directionFromYawPitch(yaw, pitch);
        const b = directionFromYawPitch(yaw + 2 * Math.PI, pitch);
        a.forEach((c, i) => expect(c).toBeCloseTo(b[i], 9));
      }),
    );
  });

  // ROUND-TRIP / INVERSE: add and sub undo each other exactly.
  test("add/sub are inverses", () => {
    fc.assert(
      fc.property(vec, vec, (a, b) => {
        const back = sub(add(a, b), b);
        expect(back).toHaveLength(3); // guard against a vacuous empty-array result
        back.forEach((c, i) => expect(c).toBeCloseTo(a[i], 9));
      }),
    );
  });

  // GOLDEN: a generic non-axis direction with BOTH yaw and pitch non-zero, so a
  // dropped/divided cos(pitch) factor (which is invisible at pitch=0) shows up.
  test("golden: a generic (yaw,pitch) maps to exact components", () => {
    const d = directionFromYawPitch(0.7, 0.5);
    const cp = Math.cos(0.5);
    expect(d[0]).toBeCloseTo(-Math.sin(0.7) * cp, 12);
    expect(d[1]).toBeCloseTo(Math.sin(0.5), 12);
    expect(d[2]).toBeCloseTo(-Math.cos(0.7) * cp, 12);
  });

  // INVARIANT: normalize yields unit length (or zero for the zero vector).
  test("normalize gives unit length for non-zero vectors", () => {
    fc.assert(
      fc.property(vec, (v) => {
        const len = length(v);
        fc.pre(len > 1e-6);
        expect(length(normalize(v))).toBeCloseTo(1, 9);
      }),
    );
    expect(normalize([0, 0, 0])).toEqual([0, 0, 0]);
  });

  // METAMORPHIC: scaling by s scales length by |s|; dot is commutative.
  test("scale multiplies length by |s|; dot is symmetric", () => {
    fc.assert(
      fc.property(vec, fc.double({ min: -50, max: 50, noNaN: true }), (v, s) => {
        expect(length(scale(v, s))).toBeCloseTo(Math.abs(s) * length(v), 6);
      }),
    );
    fc.assert(
      fc.property(vec, vec, (a, b) => {
        expect(dot(a, b)).toBeCloseTo(dot(b, a), 9);
      }),
    );
  });
});
