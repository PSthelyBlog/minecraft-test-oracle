import { describe, test, expect } from "vitest";
import fc from "fast-check";
import { World } from "./world";
import { Block } from "./blocks";
import { boxIntersectsSolid, moveAndCollide } from "./physics";
import type { Vec3 } from "./math";

/** A flat solid floor filling y in [0, floorTop], air above. */
function flatWorld(floorTop: number): World {
  const w = new World(16, 24, 16);
  for (let y = 0; y <= floorTop; y++)
    for (let z = 0; z < w.sizeZ; z++)
      for (let x = 0; x < w.sizeX; x++) w.set(x, y, z, Block.Stone);
  return w;
}

/**
 * INDEPENDENT overlap oracle. Deliberately NOT `boxIntersectsSolid` (using the
 * function under test as its own oracle would let a mutated version agree with
 * itself). This formulation tests open-interval overlap per axis against each
 * candidate cell — a different code structure from the source's floor/ceil index
 * range — so a mutated bound makes the two disagree.
 */
function naiveOverlap(world: World, center: Vec3, half: Vec3): boolean {
  const minX = center[0] - half[0], maxX = center[0] + half[0];
  const minY = center[1] - half[1], maxY = center[1] + half[1];
  const minZ = center[2] - half[2], maxZ = center[2] + half[2];
  for (let cx = Math.floor(minX) - 1; cx <= Math.ceil(maxX) + 1; cx++) {
    if (!(minX < cx + 1 && maxX > cx)) continue;
    for (let cy = Math.floor(minY) - 1; cy <= Math.ceil(maxY) + 1; cy++) {
      if (!(minY < cy + 1 && maxY > cy)) continue;
      for (let cz = Math.floor(minZ) - 1; cz <= Math.ceil(maxZ) + 1; cz++) {
        if (!(minZ < cz + 1 && maxZ > cz)) continue;
        if (Block.Air !== world.get(cx, cy, cz) && isSolidCell(world, cx, cy, cz)) return true;
      }
    }
  }
  return false;
}
function isSolidCell(world: World, x: number, y: number, z: number): boolean {
  // Stone/Bedrock floors are the only solids placed in these tests.
  const id = world.get(x, y, z);
  return id === Block.Stone || id === Block.Bedrock;
}

describe("physics oracle", () => {
  // GOLDEN: a box sitting clearly in air overlaps nothing; a box overlapping a
  // known solid cell is detected.
  test("golden: overlap detection on a flat floor", () => {
    const w = flatWorld(3); // solid y=0..3
    const half: Vec3 = [0.3, 0.9, 0.3];
    expect(boxIntersectsSolid(w, [8, 8, 8], half)).toBe(false); // up in the air
    expect(boxIntersectsSolid(w, [8, 3.5, 8], half)).toBe(true); // straddling the floor top
  });

  // DIFFERENTIAL: boxIntersectsSolid must agree with the independent overlap
  // oracle. Crucially the world is SPARSE (scattered solid blocks), not a flat
  // floor — over a flat floor every column is identical so X/Z box-extent bugs are
  // invisible. Scattered solids make all three axes' cell-range bounds (±half and
  // the ceil-1 edge) observable.
  test("boxIntersectsSolid matches the independent overlap oracle (sparse world)", () => {
    const cell = fc.integer({ min: 1, max: 6 });
    const c = fc.double({ min: 1, max: 7, noNaN: true });
    const h = fc.double({ min: 0.1, max: 1.4, noNaN: true });
    fc.assert(
      fc.property(
        fc.array(fc.tuple(cell, cell, cell), { minLength: 1, maxLength: 12 }),
        c, c, c, h, h, h,
        (solids, cx, cy, cz, hx, hy, hz) => {
          const w = new World(8, 8, 8);
          for (const [x, y, z] of solids) w.set(x, y, z, Block.Stone);
          const center: Vec3 = [cx, cy, cz];
          const half: Vec3 = [hx, hy, hz];
          expect(boxIntersectsSolid(w, center, half)).toBe(naiveOverlap(w, center, half));
        },
      ),
      { numRuns: 600 },
    );
  });

  // KEY INVARIANT (independent endpoint check): starting from a non-intersecting
  // box and stepping by a sub-block delta, the box NEVER ends inside solid rock.
  // A wrong sweep axis or sign would let the player clip into / through blocks,
  // which this catches without re-using the resolver's logic.
  test("resolved position is never inside solid geometry", () => {
    const small = fc.double({ min: -0.9, max: 0.9, noNaN: true });
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 4 }), // floor height
        fc.double({ min: 5, max: 10, noNaN: true }), // start x
        fc.double({ min: 6, max: 12, noNaN: true }), // start y (in air)
        fc.double({ min: 5, max: 10, noNaN: true }), // start z
        small, small, small,
        (floorTop, sx, sy, sz, dx, dy, dz) => {
          const w = flatWorld(floorTop);
          const half: Vec3 = [0.3, 0.9, 0.3];
          const start: Vec3 = [sx, sy, sz];
          fc.pre(!naiveOverlap(w, start, half)); // precondition of the resolver
          const res = moveAndCollide(w, start, half, [dx, dy, dz]);
          // checked with the INDEPENDENT oracle, not the resolver's own function
          expect(naiveOverlap(w, res.pos, half)).toBe(false);
        },
      ),
      { numRuns: 400 },
    );
  });

  // METAMORPHIC: a move with no obstruction applies the full delta exactly.
  test("unobstructed move applies the full delta", () => {
    const w = flatWorld(2);
    const half: Vec3 = [0.3, 0.9, 0.3];
    const res = moveAndCollide(w, [8, 10, 8], half, [0.2, 0.1, -0.2]);
    expect(res.pos[0]).toBeCloseTo(8.2, 9);
    expect(res.pos[1]).toBeCloseTo(10.1, 9);
    expect(res.pos[2]).toBeCloseTo(7.8, 9);
    expect(res.onGround).toBe(false);
    expect(res.collided).toEqual([false, false, false]);
  });

  // GOLDEN: falling onto the floor stops the descent and flags onGround.
  test("landing on the floor sets onGround and stops downward motion", () => {
    const w = flatWorld(3); // floor top at y=3, surface plane y=4
    const half: Vec3 = [0.3, 0.9, 0.3];
    // standing just above the floor; the box bottom is at y=4.9.
    const res = moveAndCollide(w, [8, 4.95, 8], half, [0, -0.5, 0]);
    expect(res.onGround).toBe(true);
    expect(res.collided[1]).toBe(true);
    expect(res.pos[1]).toBeCloseTo(4.95, 9); // Y motion cancelled, not applied
  });

  // INVARIANT: hitting a CEILING (upward motion blocked) is a Y collision but is
  // NOT onGround. Pins the `delta[1] < 0` direction guard — a mutant that flags
  // onGround on any Y collision would wrongly report grounded against a ceiling.
  test("hitting a ceiling collides on Y but does not set onGround", () => {
    const w = new World(16, 16, 16);
    for (let z = 0; z < w.sizeZ; z++)
      for (let x = 0; x < w.sizeX; x++) w.set(x, 10, z, Block.Stone); // ceiling plane
    const half: Vec3 = [0.3, 0.9, 0.3];
    const res = moveAndCollide(w, [8, 8.95, 8], half, [0, 0.5, 0]); // jump into ceiling
    expect(res.collided[1]).toBe(true);
    expect(res.onGround).toBe(false);
    expect(res.pos[1]).toBeCloseTo(8.95, 9);
  });

  // INVARIANT: hitting a wall on one axis cancels ONLY that axis; the others
  // still move. (A single shared collision flag would wrongly freeze all axes.)
  test("wall collision cancels only the blocked axis", () => {
    const w = new World(16, 16, 16);
    // a vertical wall at x=9, spanning the player's height
    for (let y = 0; y < w.sizeY; y++)
      for (let z = 0; z < w.sizeZ; z++) w.set(9, y, z, Block.Stone);
    const half: Vec3 = [0.3, 0.9, 0.3];
    const start: Vec3 = [8.2, 8, 8]; // box max x = 8.5, wall face at x=9
    // delta x = 0.6 → box max x = 9.1, genuinely penetrating cell x=9 (the wall)
    const res = moveAndCollide(w, start, half, [0.6, 0, 0.4]); // push into wall (+x) and along it (+z)
    expect(res.collided[0]).toBe(true);
    expect(res.pos[0]).toBeCloseTo(8.2, 9); // x blocked
    expect(res.pos[2]).toBeCloseTo(8.4, 9); // z slides freely
  });

  // Symmetric coverage for the Z axis (the Z branch is otherwise never exercised):
  // pushing into a +Z wall cancels Z while X still slides.
  test("Z-wall collision cancels Z only", () => {
    const w = new World(16, 16, 16);
    for (let y = 0; y < w.sizeY; y++)
      for (let x = 0; x < w.sizeX; x++) w.set(x, y, 9, Block.Stone); // wall plane at z=9
    const half: Vec3 = [0.3, 0.9, 0.3];
    const res = moveAndCollide(w, [8, 8, 8.2], half, [0.4, 0, 0.6]); // into wall (+z) and along it (+x)
    expect(res.collided[2]).toBe(true);
    expect(res.collided[0]).toBe(false);
    expect(res.pos[2]).toBeCloseTo(8.2, 9); // z blocked
    expect(res.pos[0]).toBeCloseTo(8.4, 9); // x slides freely
  });
});
