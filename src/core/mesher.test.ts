import { describe, test, expect } from "vitest";
import fc from "fast-check";
import { World } from "./world";
import { Block, isOpaque } from "./blocks";
import { buildMesh, isFaceVisible } from "./mesher";

/**
 * INDEPENDENT oracle for the visible-face count.
 *
 * A face of a non-air block is visible iff the neighbour across it is not opaque.
 * This brute-force counter enumerates that definition directly (different code
 * path from the mesher's nested loop) so it can disagree with a buggy mesher.
 */
function expectedFaceCount(w: World): number {
  const dirs = [
    [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1],
  ];
  let faces = 0;
  for (let y = 0; y < w.sizeY; y++)
    for (let z = 0; z < w.sizeZ; z++)
      for (let x = 0; x < w.sizeX; x++) {
        if (w.get(x, y, z) === Block.Air) continue;
        for (const [dx, dy, dz] of dirs) {
          if (!isOpaque(w.get(x + dx, y + dy, z + dz))) faces++;
        }
      }
  return faces;
}

describe("mesher oracle", () => {
  // GOLDEN: one solid block in the void shows all six of its faces.
  test("golden: a lone block emits exactly 6 faces", () => {
    const w = new World(8, 8, 8);
    w.set(4, 4, 4, Block.Stone);
    expect(buildMesh(w).faceCount).toBe(6);
  });

  // GOLDEN: two opaque blocks side by side hide the 2 touching faces → 10, not 12.
  // This is the whole point of face culling; a broken neighbour check yields 12.
  test("golden: two adjacent opaque blocks emit 10 faces (interior culled)", () => {
    const w = new World(8, 8, 8);
    w.set(4, 4, 4, Block.Stone);
    w.set(5, 4, 4, Block.Stone);
    expect(buildMesh(w).faceCount).toBe(10);
  });

  // GOLDEN: culling is per-face and asymmetric. Stone beside Glass:
  //   - the Stone face toward Glass IS shown (glass is non-opaque) → 6 stone faces
  //   - the Glass face toward Stone is HIDDEN (stone is opaque)     → 5 glass faces
  // Total 11 — NOT 12. This pins the asymmetry a naive "transparent ⇒ never cull"
  // implementation would get wrong.
  test("golden: stone+glass pair emits 11 faces (asymmetric culling)", () => {
    const w = new World(8, 8, 8);
    w.set(4, 4, 4, Block.Stone);
    w.set(5, 4, 4, Block.Glass);
    expect(buildMesh(w).faceCount).toBe(11);
  });

  // DIRECTIONAL: a face must be culled by the neighbour in ITS OWN direction, not
  // the opposite one. The face-count census is blind to this (swapping the pairing
  // keeps the total identical), so we pin direction explicitly via isFaceVisible.
  // FACES order is 0=+X,1=-X,2=+Y,3=-Y,4=+Z,5=-Z.
  test("a face is culled by the neighbour across it, not the opposite neighbour", () => {
    const cases: { face: number; nb: [number, number, number] }[] = [
      { face: 0, nb: [1, 0, 0] }, { face: 1, nb: [-1, 0, 0] },
      { face: 2, nb: [0, 1, 0] }, { face: 3, nb: [0, -1, 0] },
      { face: 4, nb: [0, 0, 1] }, { face: 5, nb: [0, 0, -1] },
    ];
    for (const { face, nb } of cases) {
      const w = new World(5, 5, 5);
      w.set(2, 2, 2, Block.Stone);
      // opaque block ACROSS this face → face hidden
      w.set(2 + nb[0], 2 + nb[1], 2 + nb[2], Block.Stone);
      expect(isFaceVisible(w, 2, 2, 2, face)).toBe(false);
      // remove it → face visible again
      w.set(2 + nb[0], 2 + nb[1], 2 + nb[2], Block.Air);
      expect(isFaceVisible(w, 2, 2, 2, face)).toBe(true);
      // opaque block on the OPPOSITE side must NOT cull this face
      w.set(2 - nb[0], 2 - nb[1], 2 - nb[2], Block.Stone);
      expect(isFaceVisible(w, 2, 2, 2, face)).toBe(true);
    }
  });

  // CENSUS: the mesher's face count equals the independent definition for any world.
  test("face count matches the independent neighbour census", () => {
    const id = fc.constantFrom(Block.Air, Block.Stone, Block.Glass, Block.Leaves, Block.Grass);
    fc.assert(
      fc.property(fc.array(id, { minLength: 27, maxLength: 27 }), (cells) => {
        const w = new World(3, 3, 3);
        cells.forEach((b, i) => (w.data[i] = b));
        expect(buildMesh(w).faceCount).toBe(expectedFaceCount(w));
      }),
      { numRuns: 300 },
    );
  });

  // STRUCTURAL INVARIANT: the typed arrays stay internally consistent —
  // 4 vertices and 6 indices per quad, and every emitted normal is a unit axis.
  test("buffers are consistent: 4 verts / 6 indices per face, unit normals", () => {
    const w = new World(5, 5, 5);
    w.set(2, 2, 2, Block.Stone);
    w.set(2, 3, 2, Block.Leaves);
    w.set(3, 2, 2, Block.Glass);
    const m = buildMesh(w);
    expect(m.positions.length).toBe(m.faceCount * 4 * 3);
    expect(m.normals.length).toBe(m.faceCount * 4 * 3);
    expect(m.colors.length).toBe(m.faceCount * 4 * 3);
    expect(m.indices.length).toBe(m.faceCount * 6);
    for (let i = 0; i < m.normals.length; i += 3) {
      const mag = Math.abs(m.normals[i]) + Math.abs(m.normals[i + 1]) + Math.abs(m.normals[i + 2]);
      expect(mag).toBe(1);
    }
    // every index references a real vertex
    const vertexCount = m.positions.length / 3;
    for (const idx of m.indices) expect(idx).toBeLessThan(vertexCount);
  });

  // GOLDEN GEOMETRY + WINDING: count and buffer-size oracles don't pin where the
  // vertices actually are. For a lone block we verify, per emitted face, that
  //   - its 4 corners are exactly the 4 corners of the unit cube on that side, and
  //   - the triangle winding produces an OUTWARD normal equal to the stored normal.
  // This kills mutated corner offsets, swapped axes, and flipped winding that the
  // face-count census cannot see.
  test("lone block: every face has correct corner geometry and outward winding", () => {
    const w = new World(3, 3, 3);
    w.set(1, 1, 1, Block.Stone); // unit cube spanning [1,2]^3
    const m = buildMesh(w);
    expect(m.faceCount).toBe(6);

    const seenNormals = new Set<string>();
    for (let f = 0; f < m.faceCount; f++) {
      const v: number[][] = [];
      for (let k = 0; k < 4; k++) {
        const o = (f * 4 + k) * 3;
        v.push([m.positions[o], m.positions[o + 1], m.positions[o + 2]]);
      }
      const no = f * 4 * 3;
      const normal = [m.normals[no], m.normals[no + 1], m.normals[no + 2]];
      seenNormals.add(normal.join(","));

      // (a) every corner is a corner of the [1,2]^3 cube
      for (const corner of v) {
        for (const c of corner) expect(c === 1 || c === 2).toBe(true);
      }
      // (b) all 4 corners lie on the face plane: the coord along the normal axis
      //     is constant and on the correct side (2 for +dir, 1 for -dir).
      const axis = normal.findIndex((c) => c !== 0);
      const planeValue = normal[axis] > 0 ? 2 : 1;
      for (const corner of v) expect(corner[axis]).toBe(planeValue);

      // (c) winding is outward: cross(v1-v0, v2-v0) points along +normal.
      const e1 = [v[1][0] - v[0][0], v[1][1] - v[0][1], v[1][2] - v[0][2]];
      const e2 = [v[2][0] - v[0][0], v[2][1] - v[0][1], v[2][2] - v[0][2]];
      const cross = [
        e1[1] * e2[2] - e1[2] * e2[1],
        e1[2] * e2[0] - e1[0] * e2[2],
        e1[0] * e2[1] - e1[1] * e2[0],
      ];
      const dot = cross[0] * normal[0] + cross[1] * normal[1] + cross[2] * normal[2];
      expect(dot).toBeGreaterThan(0); // same direction as the stored normal ⇒ CCW outside
    }
    // all six distinct face directions are present
    expect(seenNormals.size).toBe(6);
  });

  // GOLDEN: top face is brighter than the bottom face (the ambient shade ramp).
  // Pins the per-face shade so a mutated `* shade` is loud.
  test("golden: top face is shaded brighter than the bottom face", () => {
    const w = new World(3, 3, 3);
    w.set(1, 1, 1, Block.Stone);
    const m = buildMesh(w);
    const lum = (f: number) => {
      const o = f * 4 * 3;
      return m.colors[o] + m.colors[o + 1] + m.colors[o + 2];
    };
    // find the +Y (top) face and -Y (bottom) face by their normals
    let top = -1, bottom = -1;
    for (let f = 0; f < m.faceCount; f++) {
      const ny = m.normals[f * 4 * 3 + 1];
      if (ny === 1) top = f;
      if (ny === -1) bottom = f;
    }
    expect(top).toBeGreaterThanOrEqual(0);
    expect(bottom).toBeGreaterThanOrEqual(0);
    expect(lum(top)).toBeGreaterThan(lum(bottom));
  });

  // METAMORPHIC: a fully solid opaque region shows ONLY its outer shell;
  // all interior faces are culled. For an n³ cube that is 6·n² faces.
  test("metamorphic: a solid cube shows only its surface shell", () => {
    const n = 4;
    const w = new World(n + 2, n + 2, n + 2);
    for (let y = 1; y <= n; y++)
      for (let z = 1; z <= n; z++)
        for (let x = 1; x <= n; x++) w.set(x, y, z, Block.Stone);
    expect(buildMesh(w).faceCount).toBe(6 * n * n);
  });
});
