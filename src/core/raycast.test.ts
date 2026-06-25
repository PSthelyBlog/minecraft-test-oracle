import { describe, test, expect } from "vitest";
import fc from "fast-check";
import { World } from "./world";
import { Block } from "./blocks";
import { raycast } from "./raycast";
import type { Vec3 } from "./math";

function single(blockX: number, blockY: number, blockZ: number): World {
  const w = new World(16, 16, 16);
  w.set(blockX, blockY, blockZ, Block.Stone);
  return w;
}

/**
 * Independent analytic ray vs unit-cube intersection (the "slab" method), used as
 * an oracle for the DDA. Returns the entry distance (origin..first face) and the
 * face normal, or null on a miss. `ambiguous` flags the degenerate case where two
 * axes enter at (nearly) the same t — a corner/edge graze where the face normal is
 * not well defined and should not be compared.
 */
function slabIntersect(
  origin: Vec3,
  dir: Vec3,
  block: readonly [number, number, number],
): { distance: number; normal: Vec3; ambiguous: boolean } | null {
  const len = Math.hypot(dir[0], dir[1], dir[2]);
  if (len === 0) return null;
  const d: Vec3 = [dir[0] / len, dir[1] / len, dir[2] / len];
  const min = block;
  const max: Vec3 = [block[0] + 1, block[1] + 1, block[2] + 1];

  let tEnter = -Infinity;
  let tExit = Infinity;
  let enterAxis = -1;
  let enterSign = 0;
  let secondEnter = -Infinity; // largest tEnter of the OTHER axes, for ambiguity check

  for (let a = 0; a < 3; a++) {
    if (d[a] === 0) {
      if (origin[a] < min[a] || origin[a] > max[a]) return null; // parallel & outside slab
      continue;
    }
    let t1 = (min[a] - origin[a]) / d[a];
    let t2 = (max[a] - origin[a]) / d[a];
    let sign = -1; // entering through the min face means the outward normal is -axis
    if (t1 > t2) {
      [t1, t2] = [t2, t1];
      sign = 1;
    }
    if (t1 > tEnter) {
      secondEnter = tEnter;
      tEnter = t1;
      enterAxis = a;
      enterSign = sign;
    } else if (t1 > secondEnter) {
      secondEnter = t1;
    }
    if (t2 < tExit) tExit = t2;
    if (tEnter > tExit) return null; // slabs don't overlap ⇒ miss
  }

  if (tExit < 0 || tEnter < 0) return null; // box behind the origin
  if (enterAxis < 0) return null;

  const normal: [number, number, number] = [0, 0, 0];
  normal[enterAxis] = enterSign;
  const ambiguous = Math.abs(tEnter - secondEnter) < 1e-6;
  return { distance: tEnter, normal, ambiguous };
}

describe("raycast oracle", () => {
  // GOLDEN: an axis-aligned shot hits the expected cell, with the entry normal
  // pointing back toward the shooter and the correct break/place cells.
  test("golden: +X ray hits the block, normal faces -X", () => {
    const w = single(5, 5, 5);
    const hit = raycast(w, [0.5, 5.5, 5.5], [1, 0, 0], 20);
    expect(hit).not.toBeNull();
    expect(hit!.block).toEqual([5, 5, 5]);
    expect(hit!.normal).toEqual([-1, 0, 0]);
    expect(hit!.place).toEqual([4, 5, 5]); // adjacent empty cell toward shooter
    expect(hit!.distance).toBeCloseTo(4.5, 9);
  });

  test("golden: -Y ray (looking down) hits top face, normal +Y", () => {
    const w = single(3, 2, 3);
    const hit = raycast(w, [3.5, 10, 3.5], [0, -1, 0], 20);
    expect(hit!.block).toEqual([3, 2, 3]);
    expect(hit!.normal).toEqual([0, 1, 0]);
    expect(hit!.place).toEqual([3, 3, 3]);
  });

  // TOTALITY: a ray through empty space, a zero direction, or zero reach all
  // return null rather than a bogus hit.
  test("misses return null", () => {
    const empty = new World(16, 16, 16);
    expect(raycast(empty, [0.5, 0.5, 0.5], [1, 0, 0], 32)).toBeNull();
    expect(raycast(single(5, 5, 5), [0.5, 5.5, 5.5], [0, 0, 0], 32)).toBeNull();
    expect(raycast(single(5, 5, 5), [0.5, 5.5, 5.5], [1, 0, 0], 0)).toBeNull();
    // pointing away from the only block
    expect(raycast(single(5, 5, 5), [0.5, 5.5, 5.5], [-1, 0, 0], 32)).toBeNull();
  });

  // INVARIANT (exercises the full DDA traversal): fire along an axis from a cell
  // `dist` away, from OUTSIDE the block, and verify the complete hit contract:
  //   - the exact block is hit, after real traversal (distance > 0),
  //   - the entry normal faces back toward the shooter,
  //   - place = block + normal and is empty, block itself is solid,
  //   - the reported distance equals the true geometric entry distance.
  test("axis-aligned shots from outside hit the block with a consistent contract", () => {
    const coord = fc.integer({ min: 3, max: 12 });
    const axis = fc.integer({ min: 0, max: 2 });
    const sign = fc.constantFrom(-1, 1);
    const dist = fc.integer({ min: 1, max: 3 });
    fc.assert(
      fc.property(coord, coord, coord, axis, sign, dist, (bx, by, bz, ax, sg, d) => {
        const w = single(bx, by, bz);
        const origin: [number, number, number] = [bx + 0.5, by + 0.5, bz + 0.5];
        origin[ax] += sg * d; // step `d` cells away along the chosen axis
        const dir: [number, number, number] = [0, 0, 0];
        dir[ax] = -sg; // aim back at the block

        const hit = raycast(w, origin as Vec3, dir as Vec3, 64);
        expect(hit).not.toBeNull();
        expect(hit!.block).toEqual([bx, by, bz]);

        const expectedNormal: [number, number, number] = [0, 0, 0];
        expectedNormal[ax] = sg; // face that points toward the shooter
        expect(hit!.normal).toEqual(expectedNormal);
        expect(hit!.place).toEqual([
          bx + expectedNormal[0], by + expectedNormal[1], bz + expectedNormal[2],
        ]);
        expect(w.get(hit!.block[0], hit!.block[1], hit!.block[2])).toBe(Block.Stone);
        expect(w.get(hit!.place[0], hit!.place[1], hit!.place[2])).toBe(Block.Air);
        expect(hit!.distance).toBeCloseTo(d - 0.5, 9); // entry is half a cell inside the gap
      }),
    );
  });

  // NON-UNIT DIRECTION: distance is reported in true world units regardless of
  // the input direction's magnitude. A broken normalization (`*=` instead of `/=`)
  // is invisible for unit dirs but shows here.
  test("distance is independent of direction magnitude", () => {
    const w = single(5, 5, 5);
    const origin: Vec3 = [0.5, 5.5, 5.5];
    for (const mag of [1, 2, 5, 13]) {
      const hit = raycast(w, origin, [mag, 0, 0], 20);
      expect(hit!.block).toEqual([5, 5, 5]);
      expect(hit!.distance).toBeCloseTo(4.5, 9); // same physical entry point every time
    }
  });

  // INDEPENDENT ORACLE (slab method): for arbitrary directions — including
  // diagonals the DDA's tMax/tDelta bookkeeping governs — an analytic ray/AABB
  // intersection re-derives the entry distance and face from scratch. The DDA
  // result must match it. This is a different algorithm, so a mutated tDelta,
  // step sign, or boundary test makes the two disagree.
  test("DDA agrees with an analytic ray/AABB intersection for arbitrary dirs", () => {
    const coord = fc.integer({ min: 4, max: 11 });
    const off = fc.double({ min: -3, max: 3, noNaN: true });
    const jitter = fc.double({ min: -0.25, max: 0.25, noNaN: true });
    fc.assert(
      fc.property(
        coord, coord, coord, off, off, off, jitter, jitter, jitter,
        (bx, by, bz, ox, oy, oz, jx, jy, jz) => {
          // origin offset from the block; require it to be outside the block cell
          fc.pre(Math.abs(ox) > 1.2 || Math.abs(oy) > 1.2 || Math.abs(oz) > 1.2);
          const w = single(bx, by, bz);
          const center: Vec3 = [bx + 0.5, by + 0.5, bz + 0.5];
          const origin: Vec3 = [center[0] + ox, center[1] + oy, center[2] + oz];
          // aim roughly at the block centre, with jitter so we strike faces not edges
          const dir: Vec3 = [center[0] + jx - origin[0], center[1] + jy - origin[1], center[2] + jz - origin[2]];

          const analytic = slabIntersect(origin, dir, [bx, by, bz]);
          const hit = raycast(w, origin, dir, 64);

          if (analytic === null) return; // geometric miss ⇒ DDA may also miss; nothing to compare
          if (analytic.ambiguous) return; // ray grazes an edge/corner: normal is ill-defined, skip
          expect(hit).not.toBeNull();
          expect(hit!.block).toEqual([bx, by, bz]);
          expect(hit!.distance).toBeCloseTo(analytic.distance, 6);
          expect(hit!.normal).toEqual(analytic.normal);
        },
      ),
      { numRuns: 600 },
    );
  });

  // METAMORPHIC: starting INSIDE a solid block returns that block at distance 0.
  test("origin inside a block hits at distance 0", () => {
    const w = single(7, 7, 7);
    const hit = raycast(w, [7.5, 7.5, 7.5], [1, 0, 0], 8);
    expect(hit!.block).toEqual([7, 7, 7]);
    expect(hit!.distance).toBe(0);
    expect(hit!.normal).toEqual([0, 0, 0]); // no face entered ⇒ zero normal
    expect(hit!.place).toEqual([7, 7, 7]); // placing onto self (caller treats dist 0 specially)
  });
});
