import { describe, test, expect } from "vitest";
import fc from "fast-check";
import { World } from "./world";
import { Block, isOpaque } from "./blocks";
import {
  buildMesh,
  isFaceVisible,
  vertexAO,
  buildChunkMesh,
  buildGreedyMesh,
  buildGreedyChunkMesh,
  chunkDims,
  chunksAffectedByEdit,
  lightFactor,
  LIGHT_MIN,
  type ChunkMesh,
} from "./mesher";
import { tileIndexFor } from "./atlas";
import { computeLight, MAX_LIGHT } from "./light";

/**
 * INDEPENDENT oracle for the visible-face count.
 *
 * A face of a non-air block is visible iff the neighbour across it is not opaque.
 * This brute-force counter enumerates that definition directly (different code
 * path from the mesher's nested loop) so it can disagree with a buggy mesher.
 */
function expectedFaceCount(w: World): number {
  const dirs = [
    [1, 0, 0],
    [-1, 0, 0],
    [0, 1, 0],
    [0, -1, 0],
    [0, 0, 1],
    [0, 0, -1],
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
      { face: 0, nb: [1, 0, 0] },
      { face: 1, nb: [-1, 0, 0] },
      { face: 2, nb: [0, 1, 0] },
      { face: 3, nb: [0, -1, 0] },
      { face: 4, nb: [0, 0, 1] },
      { face: 5, nb: [0, 0, -1] },
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

  // EXCLUSION: water is drawn by the separate translucent water mesh, so the terrain
  // mesher emits NO geometry for a Water cell — yet water stays non-opaque, so it still
  // reveals the faces of solid blocks behind it (you see the lakebed through it).
  test("water blocks are excluded from the terrain mesh but still reveal neighbours", () => {
    const lone = new World(3, 3, 3);
    lone.set(1, 1, 1, Block.Water);
    expect(buildMesh(lone).faceCount).toBe(0); // water itself contributes nothing

    const submerged = new World(3, 3, 3);
    submerged.set(1, 1, 1, Block.Stone);
    submerged.set(2, 1, 1, Block.Water); // a water neighbour does not cull the stone's +X face
    expect(buildMesh(submerged).faceCount).toBe(6); // all six stone faces still show
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
    expect(m.uvs.length).toBe(m.faceCount * 4 * 2); // 2 UV components per vertex
    expect(m.layers.length).toBe(m.faceCount * 4); // 1 tile index per vertex
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

  // GOLDEN UVs + LAYER: pin the exact tile-local UVs of one known face. A lone Stone
  // block's +X face must carry the unit tile [0,1]² walked in FACE_UV winding order
  // (0,1),(1,1),(1,0),(0,0), and every one of its vertices must select the Stone
  // tile's layer. This nails the corner→UV convention and the per-vertex tile so a
  // transposed/flipped UV or a wrong-tile face is loud.
  test("golden: a known face carries tile-local UVs in winding order and its tile layer", () => {
    const w = new World(3, 3, 3);
    w.set(1, 1, 1, Block.Stone);
    const m = buildMesh(w);
    // find the +X face (normal [1,0,0])
    let fx = -1;
    for (let f = 0; f < m.faceCount; f++) if (m.normals[f * 4 * 3] === 1) fx = f;
    expect(fx).toBeGreaterThanOrEqual(0);
    const base = fx * 4 * 2;
    expect(Array.from(m.uvs.slice(base, base + 8))).toEqual([0, 1, 1, 1, 1, 0, 0, 0]);
    const layer = tileIndexFor(Block.Stone, 0); // face 0 = +X
    for (let k = 0; k < 4; k++) expect(m.layers[fx * 4 + k]).toBe(layer);
  });

  // CENSUS over UVs + LAYER: for EVERY emitted face, its 4 UV pairs must be the four
  // corners of the unit tile [0,1]², AND every vertex's layer must equal the tile the
  // face's block selects — re-derived independently from (block, face) via the atlas.
  // Catches a face sampling the wrong tile (layer), or UVs that don't span the tile,
  // across a mixed world (grass/log have per-face tiles; this exercises them).
  test("census: every face spans its unit tile and carries its (block,face) tile layer", () => {
    const id = fc.constantFrom(
      Block.Air,
      Block.Stone,
      Block.Grass,
      Block.Log,
      Block.Glass,
      Block.Leaves,
      Block.Sand,
    );
    fc.assert(
      fc.property(fc.array(id, { minLength: 27, maxLength: 27 }), (cells) => {
        const w = new World(3, 3, 3);
        cells.forEach((b, i) => (w.data[i] = b));
        const m = buildMesh(w);
        // Independently recover, per face, which block+face emitted it: the face's
        // single non-air cell is the block at floor(position) on the inner side.
        for (let f = 0; f < m.faceCount; f++) {
          const p = f * 4 * 3,
            n = f * 4 * 3;
          const nx = m.normals[n],
            ny = m.normals[n + 1],
            nz = m.normals[n + 2];
          // map normal → faceIndex (0=+X,1=−X,2=+Y,3=−Y,4=+Z,5=−Z)
          const fi = nx === 1 ? 0 : nx === -1 ? 1 : ny === 1 ? 2 : ny === -1 ? 3 : nz === 1 ? 4 : 5;
          // the owning cell = a corner minus the half-step toward the outward normal,
          // i.e. the integer cell on the inner side of this face.
          const cx = Math.floor((m.positions[p] + m.positions[p + 6]) / 2 - nx * 0.5);
          const cy = Math.floor((m.positions[p + 1] + m.positions[p + 7]) / 2 - ny * 0.5);
          const cz = Math.floor((m.positions[p + 2] + m.positions[p + 8]) / 2 - nz * 0.5);
          const block = w.get(cx, cy, cz);
          const expectedLayer = tileIndexFor(block, fi);
          const us: number[] = [],
            vs: number[] = [];
          for (let k = 0; k < 4; k++) {
            us.push(m.uvs[f * 8 + k * 2]);
            vs.push(m.uvs[f * 8 + k * 2 + 1]);
            // every vertex of this face selects the face's tile (= texture-array layer)
            expect(m.layers[f * 4 + k]).toBe(expectedLayer);
          }
          // a unit quad covers exactly one tile: UVs are the unit square's corners
          for (const u of us) expect(u === 0 || u === 1).toBe(true);
          for (const v of vs) expect(v === 0 || v === 1).toBe(true);
          // all four distinct corners of the tile are present (a real quad, not collapsed)
          expect(new Set(us.map((u, i) => `${u},${vs[i]}`)).size).toBe(4);
        }
      }),
      { numRuns: 200 },
    );
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
    let top = -1,
      bottom = -1;
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
      for (let z = 1; z <= n; z++) for (let x = 1; x <= n; x++) w.set(x, y, z, Block.Stone);
    expect(buildMesh(w).faceCount).toBe(6 * n * n);
  });
});

// ---------------------------------------------------------------------------
// Ambient occlusion: each vertex is darkened by how many of the three neighbour
// voxels touching it (in the face's open layer) are opaque. The colours are
// per-vertex now (faceShade × AO), and the quad is split along the diagonal
// joining its brighter corners. All re-derivations below are INDEPENDENT of the
// mesher's own AO code.
// ---------------------------------------------------------------------------

// Face order 0=+X,1=−X,2=+Y,3=−Y,4=+Z,5=−Z (mirrors FACES in mesher.ts).
const FACE_SHADE = [0.8, 0.8, 1.0, 0.5, 0.9, 0.9] as const;
const faceIndexFromNormal = (nx: number, ny: number, nz: number): number =>
  nx === 1 ? 0 : nx === -1 ? 1 : ny === 1 ? 2 : ny === -1 ? 3 : nz === 1 ? 4 : 5;
// Independent brightness ramp: AO_MIN (0.5) at level 0, 1.0 at level 3.
const aoBrightness = (level: number): number => 0.5 + (0.5 * level) / 3;

describe("mesher ambient-occlusion oracle", () => {
  // TRUTH TABLE: vertexAO against a HAND-ENUMERATED table (not the same formula),
  // so any mutated arithmetic/branch in the source is loud.
  test("vertexAO matches the hand-enumerated 8-case table", () => {
    // [side1, side2, corner] -> level
    const table: [number, number, number, number][] = [
      [0, 0, 0, 3], // open on all three → brightest
      [1, 0, 0, 2], // one side occludes
      [0, 1, 0, 2],
      [0, 0, 1, 2], // only the corner occludes
      [1, 0, 1, 1], // one side + corner (sides not both)
      [0, 1, 1, 1],
      [1, 1, 0, 0], // both sides → fully dark, corner irrelevant
      [1, 1, 1, 0],
    ];
    for (const [s1, s2, c, lvl] of table) expect(vertexAO(s1, s2, c)).toBe(lvl);
  });

  // PROPERTIES: symmetry in the two sides, monotonicity (an extra occluder never
  // brightens), and the both-sides ⇒ 0 (corner-independent) rule.
  test("vertexAO is side-symmetric, monotone, and zero when both sides occlude", () => {
    for (const s1 of [0, 1])
      for (const s2 of [0, 1])
        for (const c of [0, 1]) {
          expect(vertexAO(s1, s2, c)).toBe(vertexAO(s2, s1, c)); // symmetric in sides
          if (!s1) expect(vertexAO(1, s2, c)).toBeLessThanOrEqual(vertexAO(0, s2, c));
          if (!s2) expect(vertexAO(s1, 1, c)).toBeLessThanOrEqual(vertexAO(s1, 0, c));
          if (!c) expect(vertexAO(s1, s2, 1)).toBeLessThanOrEqual(vertexAO(s1, s2, 0));
        }
    expect(vertexAO(1, 1, 0)).toBe(0); // both sides ⇒ 0 …
    expect(vertexAO(1, 1, 1)).toBe(0); // … regardless of the corner
  });

  // INVARIANT: with no neighbours, AO is level 3 everywhere, so every vertex keeps
  // exactly its face's flat directional shade (AO is a strict extension of the old
  // per-face shading). Greyscale too: r==g==b.
  test("invariant: a lone block keeps each face's flat shade (no occlusion)", () => {
    const w = new World(3, 3, 3);
    w.set(1, 1, 1, Block.Stone);
    const m = buildMesh(w);
    expect(m.faceCount).toBe(6);
    for (let f = 0; f < m.faceCount; f++) {
      const no = f * 4 * 3;
      const fi = faceIndexFromNormal(m.normals[no], m.normals[no + 1], m.normals[no + 2]);
      for (let k = 0; k < 4; k++) {
        const o = (f * 4 + k) * 3;
        expect(m.colors[o]).toBeCloseTo(FACE_SHADE[fi], 6);
        expect(m.colors[o]).toBe(m.colors[o + 1]);
        expect(m.colors[o + 1]).toBe(m.colors[o + 2]);
      }
    }
  });

  // HAND-COMPUTED GOLDEN: one opaque block diagonally above the +Z edge of a block's
  // TOP face occludes exactly that face's two +Z corners. Reasoned out by hand to
  // catch a systematic geometry bug the census below could share with the source.
  //
  //   target (1,1,1) Stone; occluder (1,2,2) Stone sits in the top face's open layer
  //   (y=2), one step in +Z. The +Y face's corners at z=2 (offset c[2]=1) sample
  //   (1,2,2) as their `side` neighbour → AO level 2; the z=1 corners stay level 3.
  test("golden: a +Z occluder darkens exactly the top face's two +Z corners", () => {
    const w = new World(4, 4, 4);
    w.set(1, 1, 1, Block.Stone);
    w.set(1, 2, 2, Block.Stone); // diagonal — does not cull the top face (neighbour 1,2,1 is air)
    const m = buildMesh(w);

    // find the +Y face whose owning cell is (1,1,1)
    let top = -1;
    for (let f = 0; f < m.faceCount; f++) {
      const no = f * 4 * 3;
      if (m.normals[no + 1] !== 1) continue; // +Y only
      const p = f * 4 * 3;
      const cy = Math.floor((m.positions[p + 1] + m.positions[p + 7]) / 2 - 0.5);
      if (cy === 1) top = f; // plane y=2 ⇒ cell y=1 (our block, not the occluder's top at y=3)
    }
    expect(top).toBeGreaterThanOrEqual(0);

    const occluded = 1.0 * aoBrightness(2); // top shade × AO level 2
    const open = 1.0 * aoBrightness(3); // = 1.0
    for (let k = 0; k < 4; k++) {
      const p = (top * 4 + k) * 3;
      const zOffset = m.positions[p + 2] - 1; // cell z is 1; corner z is 1 or 2
      const shade = m.colors[(top * 4 + k) * 3];
      if (zOffset === 1) {
        expect(shade).toBeCloseTo(occluded, 6); // a +Z corner → darkened
      } else {
        expect(shade).toBeCloseTo(open, 6); // a −Z corner → untouched
      }
    }
  });

  // CENSUS (headline, independent re-derivation): for every face in random worlds,
  // recover each vertex's corner from its position, re-sample the three occluders
  // straight from the world with the test's OWN geometry, and check the emitted
  // colour equals faceShade × AO — and that the triangle split matches the
  // brighter-diagonal rule. Shares no code with the mesher's AO path.
  test("census: every vertex colour and the quad split match an independent AO re-derivation", () => {
    const id = fc.constantFrom(Block.Air, Block.Stone, Block.Grass, Block.Glass, Block.Leaves);
    fc.assert(
      fc.property(fc.array(id, { minLength: 27, maxLength: 27 }), (cells) => {
        const w = new World(3, 3, 3);
        cells.forEach((b, i) => (w.data[i] = b));
        const m = buildMesh(w);

        for (let f = 0; f < m.faceCount; f++) {
          const no = f * 4 * 3;
          const nx = m.normals[no],
            ny = m.normals[no + 1],
            nz = m.normals[no + 2];
          const fi = faceIndexFromNormal(nx, ny, nz);
          const faceAxis = nx !== 0 ? 0 : ny !== 0 ? 1 : 2;
          const [u, v] = faceAxis === 0 ? [1, 2] : faceAxis === 1 ? [0, 2] : [0, 1];
          // owning cell (inner side of the face)
          const p0 = f * 4 * 3;
          const cell = [
            Math.floor((m.positions[p0] + m.positions[p0 + 6]) / 2 - nx * 0.5),
            Math.floor((m.positions[p0 + 1] + m.positions[p0 + 7]) / 2 - ny * 0.5),
            Math.floor((m.positions[p0 + 2] + m.positions[p0 + 8]) / 2 - nz * 0.5),
          ];
          const base = [cell[0] + nx, cell[1] + ny, cell[2] + nz]; // open neighbour cell

          const occ = (o: number[]) =>
            isOpaque(w.get(base[0] + o[0], base[1] + o[1], base[2] + o[2])) ? 1 : 0;
          const levels: number[] = [];
          for (let k = 0; k < 4; k++) {
            const p = (f * 4 + k) * 3;
            const corner = [
              m.positions[p] - cell[0],
              m.positions[p + 1] - cell[1],
              m.positions[p + 2] - cell[2],
            ];
            const su = [0, 0, 0];
            const sv = [0, 0, 0];
            su[u] = corner[u] === 1 ? 1 : -1;
            sv[v] = corner[v] === 1 ? 1 : -1;
            const s1 = occ(su);
            const s2 = occ(sv);
            const cc = occ([su[0] + sv[0], su[1] + sv[1], su[2] + sv[2]]);
            const level = s1 && s2 ? 0 : 3 - (s1 + s2 + cc); // independent table
            levels.push(level);
            const expected = FACE_SHADE[fi] * aoBrightness(level);
            expect(m.colors[p]).toBeCloseTo(expected, 6);
            expect(m.colors[p]).toBe(m.colors[p + 1]); // greyscale
            expect(m.colors[p + 1]).toBe(m.colors[p + 2]);
          }

          // brighter-diagonal split: default 0–2, flip to 1–3 when that pair is brighter.
          const bv = f * 4;
          const flip = levels[0] + levels[2] < levels[1] + levels[3];
          const expectedIdx = flip
            ? [bv + 1, bv + 2, bv + 3, bv + 1, bv + 3, bv]
            : [bv, bv + 1, bv + 2, bv, bv + 2, bv + 3];
          expect(Array.from(m.indices.slice(f * 6, f * 6 + 6))).toEqual(expectedIdx);
        }
      }),
      { numRuns: 80 },
    );
  });

  // WINDING under the flip: both triangulations must stay CCW-outward. Over a random
  // world, for every face cross(v1−v0, v2−v0)·normal > 0 for BOTH triangles, whichever
  // diagonal was chosen — so a flipped quad never inverts a face.
  test("both triangles of every (possibly flipped) quad wind outward", () => {
    const id = fc.constantFrom(Block.Air, Block.Stone, Block.Grass, Block.Glass, Block.Leaves);
    fc.assert(
      fc.property(fc.array(id, { minLength: 27, maxLength: 27 }), (cells) => {
        const w = new World(3, 3, 3);
        cells.forEach((b, i) => (w.data[i] = b));
        const m = buildMesh(w);
        for (let f = 0; f < m.faceCount; f++) {
          const no = f * 4 * 3;
          const normal = [m.normals[no], m.normals[no + 1], m.normals[no + 2]];
          const vert = (idx: number) => [
            m.positions[idx * 3],
            m.positions[idx * 3 + 1],
            m.positions[idx * 3 + 2],
          ];
          for (let tri = 0; tri < 2; tri++) {
            const a = vert(m.indices[f * 6 + tri * 3]);
            const b = vert(m.indices[f * 6 + tri * 3 + 1]);
            const c = vert(m.indices[f * 6 + tri * 3 + 2]);
            const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
            const e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
            const cross = [
              e1[1] * e2[2] - e1[2] * e2[1],
              e1[2] * e2[0] - e1[0] * e2[2],
              e1[0] * e2[1] - e1[1] * e2[0],
            ];
            const dot = cross[0] * normal[0] + cross[1] * normal[1] + cross[2] * normal[2];
            expect(dot).toBeGreaterThan(0);
          }
        }
      }),
      { numRuns: 50 },
    );
  });
});

// ---------------------------------------------------------------------------
// Chunked meshing: per-chunk meshes must reassemble the whole-world mesh with no
// seams — the same faces, no more (border faces double-emitted) and no fewer
// (border faces dropped because a cross-chunk neighbour was read as Air).
// ---------------------------------------------------------------------------

/** A canonical key per emitted face: its 4 world-space corners, in winding order. */
function faceKeys(m: ChunkMesh): string[] {
  const keys: string[] = [];
  for (let f = 0; f < m.faceCount; f++) {
    const base = f * 4 * 3;
    const parts: number[] = [];
    for (let k = 0; k < 12; k++) parts.push(m.positions[base + k]);
    keys.push(parts.join(","));
  }
  return keys;
}

/** Every chunk's mesh, unioned. */
function allChunkMeshes(w: World, chunkSize: number): ChunkMesh[] {
  const { nx, ny, nz } = chunkDims(w, chunkSize);
  const meshes: ChunkMesh[] = [];
  for (let cy = 0; cy < ny; cy++)
    for (let cz = 0; cz < nz; cz++)
      for (let cx = 0; cx < nx; cx++) meshes.push(buildChunkMesh(w, cx, cy, cz, chunkSize));
  return meshes;
}

describe("chunked meshing oracle", () => {
  // GOLDEN SEAM: two opaque blocks straddling a chunk border (chunkSize 2 puts
  // x=1 in chunk 0 and x=2 in chunk 1). Their touching faces must STILL be culled
  // across the seam → 10 faces total, exactly as the whole-world mesh. An impl
  // that read the cross-chunk neighbour as Air would emit both → 12.
  test("golden: a block pair straddling a chunk border still culls the seam (10, not 12)", () => {
    const w = new World(4, 4, 4);
    w.set(1, 2, 2, Block.Stone); // chunk x=0
    w.set(2, 2, 2, Block.Stone); // chunk x=1, across the size-2 seam
    expect(buildMesh(w).faceCount).toBe(10);
    const sum = allChunkMeshes(w, 2).reduce((a, m) => a + m.faceCount, 0);
    expect(sum).toBe(10);
  });

  // TILING: chunkDims must be the MINIMAL cover — enough chunks that every cell
  // falls in one, with no wholly-empty trailing chunk. Both inequalities together
  // hold only for n = ceil(size/chunkSize), so a `/`→`*` or ceil→floor mutant
  // (which the face-count census can't see, since extra chunks are just empty)
  // is caught here. Stated as independent bounds, not by restating `ceil`.
  test("chunkDims tiles each axis minimally (covers all cells, no empty tail chunk)", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 40 }),
        fc.integer({ min: 1, max: 40 }),
        fc.integer({ min: 1, max: 40 }),
        fc.integer({ min: 1, max: 16 }),
        (sx, sy, sz, cs) => {
          const { nx, ny, nz } = chunkDims(new World(sx, sy, sz), cs);
          for (const [n, size] of [
            [nx, sx],
            [ny, sy],
            [nz, sz],
          ] as const) {
            expect(n * cs).toBeGreaterThanOrEqual(size); // every cell is covered
            expect((n - 1) * cs).toBeLessThan(size); // the last chunk holds ≥1 cell
          }
        },
      ),
    );
  });

  // CENSUS (the headline invariant): the per-chunk face counts sum to the
  // whole-world face count, for any world and any chunk size. A seam bug, a
  // missed cell at a partial last chunk, or overlapping chunk bounds all break it.
  test("census: Σ per-chunk faceCount == whole-world faceCount", () => {
    const id = fc.constantFrom(Block.Air, Block.Stone, Block.Glass, Block.Leaves, Block.Grass);
    fc.assert(
      fc.property(
        fc.array(id, { minLength: 125, maxLength: 125 }), // 5×5×5
        fc.constantFrom(1, 2, 3, 4, 5, 8), // chunk sizes incl. non-divisors of 5
        (cells, chunkSize) => {
          const w = new World(5, 5, 5);
          cells.forEach((b, i) => (w.data[i] = b));
          const whole = buildMesh(w).faceCount;
          const sum = allChunkMeshes(w, chunkSize).reduce((a, m) => a + m.faceCount, 0);
          expect(sum).toBe(whole);
        },
      ),
      { numRuns: 200 },
    );
  });

  // SEAM MULTISET (stronger than the count): the SET of faces produced by the
  // chunks equals the set the whole-world mesh produces — exactly. This catches a
  // border face that is dropped in one chunk and spuriously emitted in another,
  // which a count census alone would not notice.
  test("seam: the union of chunk faces equals the whole-world faces exactly", () => {
    const id = fc.constantFrom(Block.Air, Block.Stone, Block.Glass, Block.Leaves);
    fc.assert(
      fc.property(
        fc.array(id, { minLength: 125, maxLength: 125 }),
        fc.constantFrom(2, 3, 4),
        (cells, chunkSize) => {
          const w = new World(5, 5, 5);
          cells.forEach((b, i) => (w.data[i] = b));
          const whole = faceKeys(buildMesh(w)).sort();
          const chunked = allChunkMeshes(w, chunkSize).flatMap(faceKeys).sort();
          expect(chunked).toEqual(whole);
        },
      ),
      { numRuns: 150 },
    );
  });

  // GOLDEN: which chunks an edit touches. Interior edits hit exactly one chunk;
  // an edit on a chunk's max-X face also hits the chunk across that border.
  test("golden: edit impact is 1 chunk in the interior, 2 across a border", () => {
    const w = new World(8, 8, 8); // chunkSize 4 → 2×2×2 chunks
    // (1,1,1) is interior to chunk (0,0,0): all 6 neighbours stay in it.
    expect(chunksAffectedByEdit(w, 1, 1, 1, 4)).toEqual([[0, 0, 0]]);
    // (3,1,1) is the max-X cell of chunk (0,0,0); its +X neighbour (4,1,1) is in (1,0,0).
    const at = chunksAffectedByEdit(w, 3, 1, 1, 4)
      .map((c) => c.join(","))
      .sort();
    expect(at).toEqual(["0,0,0", "1,0,0"]);
  });

  // DIFFERENTIAL: chunksAffectedByEdit must not under-report. After an arbitrary
  // edit, EVERY chunk whose mesh actually changed has to be in the returned set —
  // otherwise the renderer would skip rebuilding it and leave a stale seam. We
  // verify this by re-meshing every chunk before and after the edit and checking
  // the changed set is covered.
  test("differential: every chunk whose mesh changes is reported by chunksAffectedByEdit", () => {
    const id = fc.constantFrom(Block.Air, Block.Stone, Block.Glass, Block.Leaves);
    fc.assert(
      fc.property(
        fc.array(id, { minLength: 125, maxLength: 125 }),
        fc.nat(124), // cell to edit (flat index into 5×5×5)
        fc.constantFrom(Block.Air, Block.Stone, Block.Glass, Block.Leaves),
        fc.constantFrom(2, 3, 4),
        (cells, flat, newId, chunkSize) => {
          const w = new World(5, 5, 5);
          cells.forEach((b, i) => (w.data[i] = b));
          const x = flat % 5,
            z = Math.floor(flat / 5) % 5,
            y = Math.floor(flat / 25);

          const sig = () => allChunkMeshes(w, chunkSize).map((m) => faceKeys(m).sort().join("|"));
          const before = sig();
          w.set(x, y, z, newId);
          const after = sig();

          const { nx, nz } = chunkDims(w, chunkSize);
          const changed = new Set<string>();
          for (let i = 0; i < before.length; i++) {
            if (before[i] !== after[i]) {
              const cx = i % nx,
                cz = Math.floor(i / nx) % nz,
                cy = Math.floor(i / (nx * nz));
              changed.add(`${cx},${cy},${cz}`);
            }
          }
          const reported = new Set(
            chunksAffectedByEdit(w, x, y, z, chunkSize).map((c) => c.join(",")),
          );
          for (const c of changed) expect(reported.has(c)).toBe(true);
        },
      ),
      { numRuns: 200 },
    );
  });
});

// ---------------------------------------------------------------------------
// Greedy meshing: merge coplanar, same-tile, uniformly-lit faces into bigger quads.
// The contract is COVERAGE-EXACT — the set of unit faces a greedy mesh decomposes
// into must equal the visible-face definition, EXACTLY (no overlaps, gaps, or
// strays) — while emitting strictly fewer quads where it can merge. All oracles
// below re-derive the expected geometry/tile/AO INDEPENDENTLY of the greedy code.
// ---------------------------------------------------------------------------

// face direction (0=+X,1=−X,2=+Y,3=−Y,4=+Z,5=−Z) → face axis + the two tangent axes.
function faceAxes(d: number): { a: number; u: number; v: number } {
  const a = d < 2 ? 0 : d < 4 ? 1 : 2;
  const [u, v] = a === 0 ? [1, 2] : a === 1 ? [0, 2] : [0, 1];
  return { a, u, v };
}

const quadNormal = (m: ChunkMesh, f: number): number[] => [
  m.normals[f * 12],
  m.normals[f * 12 + 1],
  m.normals[f * 12 + 2],
];
const quadCorner = (m: ChunkMesh, f: number, k: number): number[] => [
  m.positions[(f * 4 + k) * 3],
  m.positions[(f * 4 + k) * 3 + 1],
  m.positions[(f * 4 + k) * 3 + 2],
];

/**
 * Decompose a mesh's quads into the multiset of UNIT faces they cover, each keyed by
 * `cellX,cellY,cellZ,faceDir`. A merged w×h quad expands to its w·h unit faces; a 1×1
 * quad to one. Independent of how the mesh chose to group them.
 */
function unitFacesOf(m: ChunkMesh): string[] {
  const keys: string[] = [];
  for (let f = 0; f < m.faceCount; f++) {
    const n = quadNormal(m, f);
    const d = faceIndexFromNormal(n[0], n[1], n[2]);
    const { a, u, v } = faceAxes(d);
    const cs = [0, 1, 2, 3].map((k) => quadCorner(m, f, k));
    const planeA = cs[0][a];
    const us = cs.map((c) => c[u]);
    const vs = cs.map((c) => c[v]);
    const umin = Math.min(...us),
      vmin = Math.min(...vs);
    const w = Math.max(...us) - umin,
      h = Math.max(...vs) - vmin;
    for (let i = 0; i < w; i++)
      for (let j = 0; j < h; j++) {
        const cell = [0, 0, 0];
        cell[a] = planeA - (n[a] > 0 ? 1 : 0); // the cell on the inner side of the face
        cell[u] = umin + i;
        cell[v] = vmin + j;
        keys.push(`${cell[0]},${cell[1]},${cell[2]},${d}`);
      }
  }
  return keys;
}

/** The expected visible unit faces, straight from the culling definition (no mesher). */
function expectedUnitFaces(w: World): string[] {
  const dirs = [
    [1, 0, 0],
    [-1, 0, 0],
    [0, 1, 0],
    [0, -1, 0],
    [0, 0, 1],
    [0, 0, -1],
  ];
  const keys: string[] = [];
  for (let y = 0; y < w.sizeY; y++)
    for (let z = 0; z < w.sizeZ; z++)
      for (let x = 0; x < w.sizeX; x++) {
        if (w.get(x, y, z) === Block.Air) continue;
        for (let d = 0; d < 6; d++) {
          const [dx, dy, dz] = dirs[d];
          if (!isOpaque(w.get(x + dx, y + dy, z + dz))) keys.push(`${x},${y},${z},${d}`);
        }
      }
  return keys;
}

describe("greedy meshing oracle", () => {
  // AREA-CONSERVATION CENSUS (headline): the unit faces a greedy mesh covers equal the
  // visible-face definition EXACTLY — same multiset, so no face is dropped, doubled, or
  // invented by merging. Re-derived from the culling rule, independent of either mesher.
  test("census: greedy quads cover exactly the visible unit faces (no overlap/gap/stray)", () => {
    const id = fc.constantFrom(Block.Air, Block.Stone, Block.Glass, Block.Leaves, Block.Grass);
    fc.assert(
      fc.property(fc.array(id, { minLength: 64, maxLength: 64 }), (cells) => {
        const w = new World(4, 4, 4);
        cells.forEach((b, i) => (w.data[i] = b));
        expect(unitFacesOf(buildGreedyMesh(w)).sort()).toEqual(expectedUnitFaces(w).sort());
      }),
      { numRuns: 250 },
    );
  });

  // CENSUS over chunks: the per-chunk greedy meshes also cover exactly the visible
  // unit faces (merging is bounded to a chunk, but no seam face is lost or doubled).
  test("census: the per-chunk greedy union covers exactly the visible unit faces", () => {
    const id = fc.constantFrom(Block.Air, Block.Stone, Block.Glass, Block.Leaves);
    fc.assert(
      fc.property(
        fc.array(id, { minLength: 125, maxLength: 125 }),
        fc.constantFrom(2, 3, 4),
        (cells, chunkSize) => {
          const w = new World(5, 5, 5);
          cells.forEach((b, i) => (w.data[i] = b));
          const { nx, ny, nz } = chunkDims(w, chunkSize);
          const keys: string[] = [];
          for (let cy = 0; cy < ny; cy++)
            for (let cz = 0; cz < nz; cz++)
              for (let cx = 0; cx < nx; cx++)
                keys.push(...unitFacesOf(buildGreedyChunkMesh(w, cx, cy, cz, chunkSize)));
          expect(keys.sort()).toEqual(expectedUnitFaces(w).sort());
        },
      ),
      { numRuns: 150 },
    );
  });

  // MERGING ACTUALLY HAPPENED (the area census alone passes a non-merging mesher): a
  // solid n³ cube in air has every shell face uniformly lit (AO 3), so each of its 6
  // sides merges to ONE quad — 6 quads total, vs 6·n² for the naive mesher.
  test("golden: a solid cube merges each face to one quad (6 quads, not 6n²)", () => {
    const n = 4;
    const w = new World(n + 2, n + 2, n + 2);
    for (let y = 1; y <= n; y++)
      for (let z = 1; z <= n; z++) for (let x = 1; x <= n; x++) w.set(x, y, z, Block.Stone);
    expect(buildMesh(w).faceCount).toBe(6 * n * n); // naive: one quad per unit face
    expect(buildGreedyMesh(w).faceCount).toBe(6); // greedy: one quad per cube face
  });

  // GOLDEN (non-square merge + UV orientation): a 1×3 strip's exposed top merges to a
  // single 1-wide (X) × 3-deep (Z) quad whose tile-local UVs span 1 along the X-mapped
  // axis and 3 along the Z-mapped axis — so each of the 3 cells shows one full tile,
  // oriented correctly. A swapped s/t→axis assignment would tile 3×1 here and is loud.
  test("golden: a 1×3 strip merges to one quad whose UVs tile 1×3 in the right orientation", () => {
    const w = new World(5, 3, 5);
    for (let z = 1; z <= 3; z++) w.set(2, 1, z, Block.Stone); // 1 (X) × 3 (Z) strip
    const m = buildGreedyMesh(w);
    const tops: number[] = [];
    for (let f = 0; f < m.faceCount; f++) if (m.normals[f * 12 + 1] === 1) tops.push(f);
    expect(tops.length).toBe(1); // the three tops (uniform AO) merge to one quad
    const f = tops[0];
    const cs = [0, 1, 2, 3].map((k) => quadCorner(m, f, k));
    expect(Math.max(...cs.map((c) => c[0])) - Math.min(...cs.map((c) => c[0]))).toBe(1); // 1 wide in X
    expect(Math.max(...cs.map((c) => c[2])) - Math.min(...cs.map((c) => c[2]))).toBe(3); // 3 deep in Z
    const uvSet = new Set(
      [0, 1, 2, 3].map((k) => `${m.uvs[(f * 4 + k) * 2]},${m.uvs[(f * 4 + k) * 2 + 1]}`),
    );
    // +Y: s tracks X (extent 1), t tracks Z (extent 3)
    expect(uvSet).toEqual(new Set(["0,0", "1,0", "0,3", "1,3"]));
  });

  // STRUCTURAL: 4 verts / 2 uv / 1 layer / 6 indices per quad, unit-axis normals — over
  // a mixed world so merged and 1×1 quads both occur.
  test("buffers stay consistent and normals are unit axes", () => {
    const w = new World(5, 5, 5);
    for (let z = 1; z <= 3; z++) for (let x = 1; x <= 3; x++) w.set(x, 1, z, Block.Grass); // a slab → merges
    w.set(2, 3, 2, Block.Glass); // a lone block → 1×1 quads
    const m = buildGreedyMesh(w);
    expect(m.positions.length).toBe(m.faceCount * 12);
    expect(m.normals.length).toBe(m.faceCount * 12);
    expect(m.colors.length).toBe(m.faceCount * 12);
    expect(m.uvs.length).toBe(m.faceCount * 8);
    expect(m.layers.length).toBe(m.faceCount * 4);
    expect(m.indices.length).toBe(m.faceCount * 6);
    for (let i = 0; i < m.normals.length; i += 3) {
      const mag = Math.abs(m.normals[i]) + Math.abs(m.normals[i + 1]) + Math.abs(m.normals[i + 2]);
      expect(mag).toBe(1);
    }
    for (const idx of m.indices) expect(idx).toBeLessThan(m.positions.length / 3);
  });

  // TILE/UV CENSUS: every greedy quad samples ONE tile (= layer) and tiles it once per
  // cell. The UV corners are {0,M}×{0,N} with M·N == w·h (a unit tile per covered cell,
  // not one stretched tile), and the layer equals `tileIndexFor` for every owning cell.
  test("census: every greedy quad tiles its layer once per cell and uses the right tile", () => {
    const id = fc.constantFrom(Block.Air, Block.Stone, Block.Grass, Block.Log, Block.Sand);
    fc.assert(
      fc.property(fc.array(id, { minLength: 64, maxLength: 64 }), (cells) => {
        const w = new World(4, 4, 4);
        cells.forEach((b, i) => (w.data[i] = b));
        const m = buildGreedyMesh(w);
        for (let f = 0; f < m.faceCount; f++) {
          const n = quadNormal(m, f);
          const d = faceIndexFromNormal(n[0], n[1], n[2]);
          const { a, u, v } = faceAxes(d);
          const cs = [0, 1, 2, 3].map((k) => quadCorner(m, f, k));
          const umin = Math.min(...cs.map((c) => c[u]));
          const vmin = Math.min(...cs.map((c) => c[v]));
          const wq = Math.max(...cs.map((c) => c[u])) - umin;
          const hq = Math.max(...cs.map((c) => c[v])) - vmin;
          const planeA = cs[0][a];

          const uvc = [0, 1, 2, 3].map((k) => [m.uvs[(f * 4 + k) * 2], m.uvs[(f * 4 + k) * 2 + 1]]);
          const M = Math.max(...uvc.map((p) => p[0]));
          const N = Math.max(...uvc.map((p) => p[1]));
          expect(Number.isInteger(M) && M >= 1).toBe(true);
          expect(Number.isInteger(N) && N >= 1).toBe(true);
          expect(M * N).toBe(wq * hq); // one unit tile per covered cell
          expect(new Set(uvc.map((p) => `${p[0]},${p[1]}`))).toEqual(
            new Set([`0,0`, `${M},0`, `0,${N}`, `${M},${N}`]),
          );

          // Per-cell UV step: each covered cell must map to a FULL unit tile, oriented
          // right — moving one cell along a tangent advances the UV by exactly one unit
          // along ONE uv axis (not a stretched/rotated step). This pins the s/t→axis
          // assignment that `M·N == w·h` alone can't see (a swap mis-tiles a non-square
          // merge while keeping the area product).
          const uvAt = (cu: number, cv: number): number[] =>
            uvc[cs.findIndex((c) => c[u] === cu && c[v] === cv)];
          const uv00 = uvAt(umin, vmin);
          const stepU = [
            (uvAt(umin + wq, vmin)[0] - uv00[0]) / wq,
            (uvAt(umin + wq, vmin)[1] - uv00[1]) / wq,
          ];
          const stepV = [
            (uvAt(umin, vmin + hq)[0] - uv00[0]) / hq,
            (uvAt(umin, vmin + hq)[1] - uv00[1]) / hq,
          ];
          const isUnitAxis = (s: number[]): boolean =>
            (Math.abs(s[0]) === 1 && s[1] === 0) || (s[0] === 0 && Math.abs(s[1]) === 1);
          expect(isUnitAxis(stepU)).toBe(true);
          expect(isUnitAxis(stepV)).toBe(true);
          expect(Math.abs(stepU[0])).not.toBe(Math.abs(stepV[0])); // the two steps use different uv axes

          const layer = m.layers[f * 4];
          for (let k = 0; k < 4; k++) expect(m.layers[f * 4 + k]).toBe(layer);
          for (let i = 0; i < wq; i++)
            for (let j = 0; j < hq; j++) {
              const cell = [0, 0, 0];
              cell[a] = planeA - (n[a] > 0 ? 1 : 0);
              cell[u] = umin + i;
              cell[v] = vmin + j;
              expect(tileIndexFor(w.get(cell[0], cell[1], cell[2]), d)).toBe(layer);
            }
        }
      }),
      { numRuns: 150 },
    );
  });

  // AO CENSUS: every greedy quad reproduces the independently re-derived ambient
  // occlusion of each cell it covers. A quad's four vertex shades (a multiset) must
  // equal each owning cell's four corner shades — so a MERGED quad can only span cells
  // that are uniformly lit at the SAME level (never merged across an AO seam), while a
  // 1×1 quad keeps its exact per-corner AO. Shares no code with the mesher's AO path.
  test("census: every greedy quad reproduces each covered cell's ambient occlusion", () => {
    const id = fc.constantFrom(Block.Air, Block.Stone, Block.Grass, Block.Glass, Block.Leaves);
    fc.assert(
      fc.property(fc.array(id, { minLength: 64, maxLength: 64 }), (cells) => {
        const w = new World(4, 4, 4);
        cells.forEach((b, i) => (w.data[i] = b));
        const m = buildGreedyMesh(w);
        for (let f = 0; f < m.faceCount; f++) {
          const n = quadNormal(m, f);
          const d = faceIndexFromNormal(n[0], n[1], n[2]);
          const { a, u, v } = faceAxes(d);
          const cs = [0, 1, 2, 3].map((k) => quadCorner(m, f, k));
          const umin = Math.min(...cs.map((c) => c[u]));
          const vmin = Math.min(...cs.map((c) => c[v]));
          const wq = Math.max(...cs.map((c) => c[u])) - umin;
          const hq = Math.max(...cs.map((c) => c[v])) - vmin;
          const planeA = cs[0][a];

          // the quad's four vertex shades (greyscale), as a sorted multiset
          const quadShades = [0, 1, 2, 3].map((k) => m.colors[(f * 4 + k) * 3]).sort();
          for (let k = 0; k < 4; k++) {
            expect(m.colors[(f * 4 + k) * 3]).toBe(m.colors[(f * 4 + k) * 3 + 1]); // greyscale
            expect(m.colors[(f * 4 + k) * 3 + 1]).toBe(m.colors[(f * 4 + k) * 3 + 2]);
          }

          // The triangle split must follow the brighter-diagonal rule: default 0–2, flip
          // to 1–3 when that pair is brighter. We recover each corner's INTEGER AO level
          // from its shade (`shade = FACE_SHADE · aoBrightness(level)`) and compare the
          // integer diagonal sums — comparing the Float32 shades directly would mis-rank
          // an exact tie (e.g. 0+3 vs 1+2). Winding alone can't see the split; this pins
          // it for the non-uniform 1×1 quads (a uniform merge always takes the default).
          const lvl = (k: number): number =>
            Math.round((m.colors[(f * 4 + k) * 3] / FACE_SHADE[d] - 0.5) * 6);
          const bv = f * 4;
          const expectedIdx =
            lvl(0) + lvl(2) < lvl(1) + lvl(3)
              ? [bv + 1, bv + 2, bv + 3, bv + 1, bv + 3, bv]
              : [bv, bv + 1, bv + 2, bv, bv + 2, bv + 3];
          expect(Array.from(m.indices.slice(f * 6, f * 6 + 6))).toEqual(expectedIdx);

          for (let i = 0; i < wq; i++)
            for (let j = 0; j < hq; j++) {
              const cell = [0, 0, 0];
              cell[a] = planeA - (n[a] > 0 ? 1 : 0);
              cell[u] = umin + i;
              cell[v] = vmin + j;
              const base = [cell[0] + n[0], cell[1] + n[1], cell[2] + n[2]]; // open neighbour layer
              const occ = (ou: number, ov: number): number => {
                const o = [0, 0, 0];
                o[u] = ou;
                o[v] = ov;
                return isOpaque(w.get(base[0] + o[0], base[1] + o[1], base[2] + o[2])) ? 1 : 0;
              };
              // the cell's four corner AO levels: every (±u, ±v) combination
              const cellShades: number[] = [];
              for (const su of [1, -1])
                for (const sv of [1, -1]) {
                  const s1 = occ(su, 0),
                    s2 = occ(0, sv),
                    cc = occ(su, sv);
                  const level = s1 && s2 ? 0 : 3 - (s1 + s2 + cc);
                  cellShades.push(FACE_SHADE[d] * aoBrightness(level));
                }
              // the quad must reproduce this cell's shading exactly (so a merge only
              // spans equally-lit cells; a 1×1 quad matches its single cell's corners)
              cellShades.sort();
              for (let q = 0; q < 4; q++) expect(quadShades[q]).toBeCloseTo(cellShades[q], 6);
            }
        }
      }),
      { numRuns: 120 },
    );
  });

  // WINDING: both triangles of every greedy quad (merged or 1×1) wind outward — the
  // merged rectangle must not invert a face.
  test("both triangles of every greedy quad wind outward", () => {
    const id = fc.constantFrom(Block.Air, Block.Stone, Block.Grass, Block.Leaves);
    fc.assert(
      fc.property(fc.array(id, { minLength: 64, maxLength: 64 }), (cells) => {
        const w = new World(4, 4, 4);
        cells.forEach((b, i) => (w.data[i] = b));
        const m = buildGreedyMesh(w);
        for (let f = 0; f < m.faceCount; f++) {
          const normal = quadNormal(m, f);
          const vert = (idx: number): number[] => [
            m.positions[idx * 3],
            m.positions[idx * 3 + 1],
            m.positions[idx * 3 + 2],
          ];
          for (let tri = 0; tri < 2; tri++) {
            const aa = vert(m.indices[f * 6 + tri * 3]);
            const bb = vert(m.indices[f * 6 + tri * 3 + 1]);
            const cc = vert(m.indices[f * 6 + tri * 3 + 2]);
            const e1 = [bb[0] - aa[0], bb[1] - aa[1], bb[2] - aa[2]];
            const e2 = [cc[0] - aa[0], cc[1] - aa[1], cc[2] - aa[2]];
            const cross = [
              e1[1] * e2[2] - e1[2] * e2[1],
              e1[2] * e2[0] - e1[0] * e2[2],
              e1[0] * e2[1] - e1[1] * e2[0],
            ];
            const dot = cross[0] * normal[0] + cross[1] * normal[1] + cross[2] * normal[2];
            expect(dot).toBeGreaterThan(0);
          }
        }
      }),
      { numRuns: 60 },
    );
  });
});

// ---------------------------------------------------------------------------
// Light-aware shading. Each face is dimmed by the propagated light (max of block-
// and sky-light) at the OPEN cell it looks into, folded into the per-vertex colour
// as colour = faceShade × AO × light. The oracles below re-derive that fold
// INDEPENDENTLY (their own light-brightness ramp, their own open-cell sampling) and
// pin the strict-extension (full light ⇒ unchanged) and monotonicity properties.
// ---------------------------------------------------------------------------

// Independent light-brightness ramp: LIGHT_MIN at level 0, 1.0 at MAX_LIGHT.
const lightBrightness = (level: number): number =>
  LIGHT_MIN + ((1 - LIGHT_MIN) * level) / MAX_LIGHT;

// Sample a light field with the mesher's edge convention: out of bounds (the world
// border, which the face looks out through) reads as full light.
const sampleLight = (L: Uint8Array, w: World, x: number, y: number, z: number): number =>
  w.inBounds(x, y, z) ? L[w.index(x, y, z)] : MAX_LIGHT;

describe("mesher light-aware shading oracle", () => {
  // TRUTH TABLE: lightFactor against hand-computed values (0.12 floor, 1.0 at full
  // light), endpoints + strict monotonicity — a mutated formula is loud.
  test("lightFactor matches hand-computed values and is strictly monotone", () => {
    expect(lightFactor(0)).toBeCloseTo(0.12, 6);
    expect(lightFactor(MAX_LIGHT)).toBeCloseTo(1.0, 6);
    expect(lightFactor(5)).toBeCloseTo(0.12 + (0.88 * 5) / 15, 6);
    for (let L = 1; L <= MAX_LIGHT; L++) expect(lightFactor(L)).toBeGreaterThan(lightFactor(L - 1));
  });

  // STRICT EXTENSION: a fully-lit field (all 15) reproduces the unlit mesh byte-for-
  // byte — so light is a strict extension of shade × AO (factor 1 at full light) and
  // the omitted-light default equals explicit full light. Holds for naive AND greedy
  // (full light can't block a merge that AO already allows).
  test("golden: full light reproduces the unlit mesh exactly", () => {
    const w = new World(4, 4, 4);
    const palette = [Block.Air, Block.Stone, Block.Grass, Block.Glass];
    for (let i = 0; i < w.volume; i++) w.data[i] = palette[i % palette.length];
    const full = new Uint8Array(w.volume).fill(MAX_LIGHT);
    expect(Array.from(buildMesh(w, full).colors)).toEqual(Array.from(buildMesh(w).colors));
    expect(Array.from(buildGreedyMesh(w, full).colors)).toEqual(
      Array.from(buildGreedyMesh(w).colors),
    );
  });

  // CENSUS (headline): for every face in random worlds, re-derive each vertex colour
  // as faceShade × AO × light, sampling the light field at the OPEN cell with the
  // test's own geometry. Shares no code with the mesher's light/AO path.
  test("census: every vertex colour folds in the open-cell light (naive mesher)", () => {
    const id = fc.constantFrom(Block.Air, Block.Stone, Block.Grass, Block.Glass, Block.Glowstone);
    fc.assert(
      fc.property(fc.array(id, { minLength: 64, maxLength: 64 }), (cells) => {
        const w = new World(4, 4, 4);
        cells.forEach((b, i) => (w.data[i] = b));
        const L = computeLight(w);
        const m = buildMesh(w, L);
        for (let f = 0; f < m.faceCount; f++) {
          const no = f * 4 * 3;
          const nx = m.normals[no],
            ny = m.normals[no + 1],
            nz = m.normals[no + 2];
          const fi = faceIndexFromNormal(nx, ny, nz);
          const faceAxis = nx !== 0 ? 0 : ny !== 0 ? 1 : 2;
          const [u, v] = faceAxis === 0 ? [1, 2] : faceAxis === 1 ? [0, 2] : [0, 1];
          const p0 = f * 4 * 3;
          const cell = [
            Math.floor((m.positions[p0] + m.positions[p0 + 6]) / 2 - nx * 0.5),
            Math.floor((m.positions[p0 + 1] + m.positions[p0 + 7]) / 2 - ny * 0.5),
            Math.floor((m.positions[p0 + 2] + m.positions[p0 + 8]) / 2 - nz * 0.5),
          ];
          const base = [cell[0] + nx, cell[1] + ny, cell[2] + nz]; // open neighbour cell
          const lf = lightBrightness(sampleLight(L, w, base[0], base[1], base[2]));
          const occ = (o: number[]) =>
            isOpaque(w.get(base[0] + o[0], base[1] + o[1], base[2] + o[2])) ? 1 : 0;
          for (let k = 0; k < 4; k++) {
            const p = (f * 4 + k) * 3;
            const corner = [
              m.positions[p] - cell[0],
              m.positions[p + 1] - cell[1],
              m.positions[p + 2] - cell[2],
            ];
            const su = [0, 0, 0];
            const sv = [0, 0, 0];
            su[u] = corner[u] === 1 ? 1 : -1;
            sv[v] = corner[v] === 1 ? 1 : -1;
            const s1 = occ(su);
            const s2 = occ(sv);
            const cc = occ([su[0] + sv[0], su[1] + sv[1], su[2] + sv[2]]);
            const level = s1 && s2 ? 0 : 3 - (s1 + s2 + cc);
            const expected = FACE_SHADE[fi] * aoBrightness(level) * lf;
            expect(m.colors[p]).toBeCloseTo(expected, 6);
            expect(m.colors[p]).toBe(m.colors[p + 1]); // greyscale
            expect(m.colors[p + 1]).toBe(m.colors[p + 2]);
          }
        }
      }),
      { numRuns: 80 },
    );
  });

  // METAMORPHIC (monotonicity): the naive mesher's face set/order is independent of
  // light, so colours correspond 1:1 across light fields. A brighter field never
  // darkens any vertex and a darker field never brightens it: dark ≤ real ≤ bright.
  test("metamorphic: more light never darkens, less light never brightens", () => {
    const id = fc.constantFrom(Block.Air, Block.Stone, Block.Grass, Block.Glass, Block.Glowstone);
    fc.assert(
      fc.property(fc.array(id, { minLength: 64, maxLength: 64 }), (cells) => {
        const w = new World(4, 4, 4);
        cells.forEach((b, i) => (w.data[i] = b));
        const dark = new Uint8Array(w.volume); // all 0
        const real = computeLight(w);
        const bright = new Uint8Array(w.volume).fill(MAX_LIGHT);
        const md = buildMesh(w, dark).colors;
        const mr = buildMesh(w, real).colors;
        const mb = buildMesh(w, bright).colors;
        expect(md.length).toBe(mr.length);
        expect(mr.length).toBe(mb.length);
        for (let i = 0; i < mr.length; i++) {
          expect(md[i]).toBeLessThanOrEqual(mr[i] + 1e-6);
          expect(mr[i]).toBeLessThanOrEqual(mb[i] + 1e-6);
        }
      }),
      { numRuns: 100 },
    );
  });

  // METAMORPHIC (the headline "lighting is visible"): a Stone floor sealed under a
  // Stone roof has a fully-dark gap (no skylight, no emitter). Placing a Glowstone in
  // that gap strictly brightens the top face of a nearby floor cell — light reaches it.
  test("metamorphic: a Glowstone brightens a nearby shadowed floor face", () => {
    const w = new World(9, 4, 5);
    for (let z = 0; z < 5; z++)
      for (let x = 0; x < 9; x++) {
        w.set(x, 0, z, Block.Stone); // floor
        w.set(x, 3, z, Block.Stone); // sealed roof → the y=1..2 gap gets no skylight
      }
    // the +Y face of floor cell (3,0,2): its open cell (3,1,2) is dark (light 0)
    const topFaceShade = (m: ChunkMesh): number => {
      for (let f = 0; f < m.faceCount; f++) {
        const p0 = f * 12;
        if (m.normals[p0 + 1] !== 1) continue; // +Y
        const cx = Math.floor((m.positions[p0] + m.positions[p0 + 6]) / 2);
        const cy = Math.floor((m.positions[p0 + 1] + m.positions[p0 + 7]) / 2 - 0.5);
        const cz = Math.floor((m.positions[p0 + 2] + m.positions[p0 + 8]) / 2);
        if (cx === 3 && cy === 0 && cz === 2) return m.colors[f * 12];
      }
      return -1;
    };
    const before = topFaceShade(buildMesh(w, computeLight(w)));
    expect(before).toBeGreaterThan(0);
    w.set(6, 1, 2, Block.Glowstone); // in the gap, 3 cells away, doesn't cull the face
    const after = topFaceShade(buildMesh(w, computeLight(w)));
    expect(after).toBeGreaterThan(before); // the face is now lit
  });

  // CENSUS: light-aware greedy meshing still covers exactly the visible unit faces —
  // adding a light dimension to the merge key drops/doubles/invents nothing.
  test("census: light-aware greedy quads cover exactly the visible unit faces", () => {
    const id = fc.constantFrom(Block.Air, Block.Stone, Block.Glass, Block.Leaves, Block.Glowstone);
    fc.assert(
      fc.property(fc.array(id, { minLength: 64, maxLength: 64 }), (cells) => {
        const w = new World(4, 4, 4);
        cells.forEach((b, i) => (w.data[i] = b));
        expect(unitFacesOf(buildGreedyMesh(w, computeLight(w))).sort()).toEqual(
          expectedUnitFaces(w).sort(),
        );
      }),
      { numRuns: 200 },
    );
  });

  // CENSUS: every light-aware greedy quad reproduces shade × AO × light for each cell
  // it covers — so a merged quad can only span cells uniformly lit at the SAME light
  // level (never merged across a light seam), while a 1×1 keeps its exact corners.
  test("census: every light-aware greedy quad reproduces each covered cell's shade × AO × light", () => {
    const id = fc.constantFrom(Block.Air, Block.Stone, Block.Grass, Block.Glass, Block.Glowstone);
    fc.assert(
      fc.property(fc.array(id, { minLength: 64, maxLength: 64 }), (cells) => {
        const w = new World(4, 4, 4);
        cells.forEach((b, i) => (w.data[i] = b));
        const L = computeLight(w);
        const m = buildGreedyMesh(w, L);
        for (let f = 0; f < m.faceCount; f++) {
          const n = quadNormal(m, f);
          const d = faceIndexFromNormal(n[0], n[1], n[2]);
          const { a, u, v } = faceAxes(d);
          const cs = [0, 1, 2, 3].map((k) => quadCorner(m, f, k));
          const umin = Math.min(...cs.map((c) => c[u]));
          const vmin = Math.min(...cs.map((c) => c[v]));
          const wq = Math.max(...cs.map((c) => c[u])) - umin;
          const hq = Math.max(...cs.map((c) => c[v])) - vmin;
          const planeA = cs[0][a];
          const quadShades = [0, 1, 2, 3]
            .map((k) => m.colors[(f * 4 + k) * 3])
            .sort((p, q) => p - q);
          for (let i = 0; i < wq; i++)
            for (let j = 0; j < hq; j++) {
              const cell = [0, 0, 0];
              cell[a] = planeA - (n[a] > 0 ? 1 : 0);
              cell[u] = umin + i;
              cell[v] = vmin + j;
              const base = [cell[0] + n[0], cell[1] + n[1], cell[2] + n[2]];
              const lf = lightBrightness(sampleLight(L, w, base[0], base[1], base[2]));
              const occ = (ou: number, ov: number): number => {
                const o = [0, 0, 0];
                o[u] = ou;
                o[v] = ov;
                return isOpaque(w.get(base[0] + o[0], base[1] + o[1], base[2] + o[2])) ? 1 : 0;
              };
              const cellShades: number[] = [];
              for (const su of [1, -1])
                for (const sv of [1, -1]) {
                  const s1 = occ(su, 0),
                    s2 = occ(0, sv),
                    cc = occ(su, sv);
                  const level = s1 && s2 ? 0 : 3 - (s1 + s2 + cc);
                  cellShades.push(FACE_SHADE[d] * aoBrightness(level) * lf);
                }
              cellShades.sort((p, q) => p - q);
              for (let q = 0; q < 4; q++) expect(quadShades[q]).toBeCloseTo(cellShades[q], 6);
            }
        }
      }),
      { numRuns: 120 },
    );
  });
});
