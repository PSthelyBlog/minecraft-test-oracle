import { describe, test, expect } from "vitest";
import fc from "fast-check";
import { World } from "./world";
import { Block, isOpaque } from "./blocks";
import { computeWater } from "./water";
import { computeLight, MAX_LIGHT } from "./light";
import { chunkDims, type ChunkMesh } from "./mesher";
import { buildWaterMesh, buildWaterChunkMesh } from "./waterMesh";

/**
 * The water mesh draws the visible surface of the water field as a translucent pass.
 * These oracles re-derive — INDEPENDENTLY of waterMesh.ts — exactly where a water face
 * should appear (a watered cell facing open air), the shade it should carry
 * (faceShade × light), and that every quad winds outward. So a wrong cull (water faces
 * inside a body, or buried against rock), a wrong shade, or an inverted quad disagrees.
 */

// Face dir 0=+X,1=−X,2=+Y,3=−Y,4=+Z,5=−Z (mirrors FACES in mesher.ts).
const DIRS = [
  [1, 0, 0],
  [-1, 0, 0],
  [0, 1, 0],
  [0, -1, 0],
  [0, 0, 1],
  [0, 0, -1],
] as const;
const FACE_SHADE = [0.8, 0.8, 1.0, 0.5, 0.9, 0.9] as const;
const LIGHT_MIN = 0.12; // mirrors mesher.ts
const lightBrightness = (L: number): number => LIGHT_MIN + ((1 - LIGHT_MIN) * L) / MAX_LIGHT;
const faceIndexFromNormal = (nx: number, ny: number, nz: number): number =>
  nx === 1 ? 0 : nx === -1 ? 1 : ny === 1 ? 2 : ny === -1 ? 3 : nz === 1 ? 4 : 5;

const randomCells = fc.array(fc.constantFrom(Block.Air, Block.Air, Block.Stone, Block.Water), {
  minLength: 125,
  maxLength: 125,
});
const fill = (cells: number[]): World => {
  const w = new World(5, 5, 5);
  cells.forEach((b, i) => (w.data[i] = b));
  return w;
};

/** The owning cell of quad `f` (the watered cell on the inner side of its face). */
const owningCell = (m: ChunkMesh, f: number): [number, number, number] => {
  const p0 = f * 4 * 3;
  const nx = m.normals[p0],
    ny = m.normals[p0 + 1],
    nz = m.normals[p0 + 2];
  return [
    Math.floor((m.positions[p0] + m.positions[p0 + 6]) / 2 - nx * 0.5),
    Math.floor((m.positions[p0 + 1] + m.positions[p0 + 7]) / 2 - ny * 0.5),
    Math.floor((m.positions[p0 + 2] + m.positions[p0 + 8]) / 2 - nz * 0.5),
  ];
};

/** Visible water faces straight from the field, INDEPENDENT of the builder. */
function expectedWaterFaces(w: World, water: Uint8Array): string[] {
  const keys: string[] = [];
  for (let y = 0; y < w.sizeY; y++)
    for (let z = 0; z < w.sizeZ; z++)
      for (let x = 0; x < w.sizeX; x++) {
        if (water[w.index(x, y, z)] === 0) continue;
        for (let d = 0; d < 6; d++) {
          const [dx, dy, dz] = DIRS[d];
          const nWater = w.inBounds(x + dx, y + dy, z + dz)
            ? water[w.index(x + dx, y + dy, z + dz)]
            : 0;
          if (nWater === 0 && !isOpaque(w.get(x + dx, y + dy, z + dz)))
            keys.push(`${x},${y},${z},${d}`);
        }
      }
  return keys;
}

/** The (cell, dir) keys a water mesh actually emitted. */
function emittedFaces(m: ChunkMesh): string[] {
  const keys: string[] = [];
  for (let f = 0; f < m.faceCount; f++) {
    const no = f * 12;
    const d = faceIndexFromNormal(m.normals[no], m.normals[no + 1], m.normals[no + 2]);
    const [cx, cy, cz] = owningCell(m, f);
    keys.push(`${cx},${cy},${cz},${d}`);
  }
  return keys;
}

describe("water mesh oracle", () => {
  // WHERE-CENSUS (headline): the faces the water mesh emits are EXACTLY the visible
  // water faces (a watered cell facing open air), re-derived from the field — no face
  // inside a body, buried against rock, dropped, or invented.
  test("census: water faces appear exactly where a watered cell faces open air", () => {
    fc.assert(
      fc.property(randomCells, (cells) => {
        const w = fill(cells);
        const water = computeWater(w);
        const m = buildWaterMesh(w, water, computeLight(w));
        expect(emittedFaces(m).sort()).toEqual(expectedWaterFaces(w, water).sort());
      }),
      { numRuns: 250 },
    );
  });

  // CENSUS over chunks: the per-chunk water union covers exactly the same visible faces
  // (culling reads the full world, so chunk seams neither lose nor double a face).
  test("census: the per-chunk water union covers exactly the visible water faces", () => {
    fc.assert(
      fc.property(randomCells, fc.constantFrom(2, 3, 4), (cells, chunkSize) => {
        const w = fill(cells);
        const water = computeWater(w);
        const light = computeLight(w);
        const { nx, ny, nz } = chunkDims(w, chunkSize);
        const keys: string[] = [];
        for (let cy = 0; cy < ny; cy++)
          for (let cz = 0; cz < nz; cz++)
            for (let cx = 0; cx < nx; cx++)
              keys.push(
                ...emittedFaces(buildWaterChunkMesh(w, water, light, cx, cy, cz, chunkSize)),
              );
        expect(keys.sort()).toEqual(expectedWaterFaces(w, water).sort());
      }),
      { numRuns: 150 },
    );
  });

  // SHADE CENSUS: every water vertex colour is faceShade × light at the open cell the
  // face looks into (greyscale), re-derived independently. Pins the lighting fold.
  test("census: every water face is shaded faceShade × open-cell light", () => {
    fc.assert(
      fc.property(randomCells, (cells) => {
        const w = fill(cells);
        const water = computeWater(w);
        const light = computeLight(w);
        const m = buildWaterMesh(w, water, light);
        for (let f = 0; f < m.faceCount; f++) {
          const no = f * 12;
          const nx = m.normals[no],
            ny = m.normals[no + 1],
            nz = m.normals[no + 2];
          const d = faceIndexFromNormal(nx, ny, nz);
          const [cx, cy, cz] = owningCell(m, f);
          const L = w.inBounds(cx + nx, cy + ny, cz + nz)
            ? light[w.index(cx + nx, cy + ny, cz + nz)]
            : MAX_LIGHT;
          const expected = FACE_SHADE[d] * lightBrightness(L);
          for (let k = 0; k < 4; k++) {
            const p = (f * 4 + k) * 3;
            expect(m.colors[p]).toBeCloseTo(expected, 6);
            expect(m.colors[p]).toBe(m.colors[p + 1]); // greyscale
            expect(m.colors[p + 1]).toBe(m.colors[p + 2]);
          }
        }
      }),
      { numRuns: 120 },
    );
  });

  // WINDING: both triangles of every water quad wind outward (the translucent pass must
  // not invert a face).
  test("both triangles of every water quad wind outward", () => {
    fc.assert(
      fc.property(randomCells, (cells) => {
        const w = fill(cells);
        const m = buildWaterMesh(w, computeWater(w), computeLight(w));
        for (let f = 0; f < m.faceCount; f++) {
          const no = f * 12;
          const normal = [m.normals[no], m.normals[no + 1], m.normals[no + 2]];
          const vert = (idx: number): number[] => [
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
      { numRuns: 60 },
    );
  });

  // GOLDEN: confined water (flowing water can't stay "lone" — it spreads). Fully
  // enclosed in rock → every face buried → 0. In a stone cup with an open top → the
  // water can't flow out and only its top meets air → exactly 1 face. Hand-reasoned
  // anchors for the cull rule.
  test("golden: enclosed water shows no faces; a cupped source shows only its top", () => {
    const buried = new World(3, 3, 3);
    buried.data.fill(Block.Stone);
    buried.set(1, 1, 1, Block.Water); // surrounded by rock on all six sides
    expect(buildWaterMesh(buried, computeWater(buried), computeLight(buried)).faceCount).toBe(0);

    const cup = new World(3, 3, 3);
    cup.data.fill(Block.Stone);
    cup.set(1, 1, 1, Block.Water); // water in the cup
    cup.set(1, 2, 1, Block.Air); // open top above it
    expect(buildWaterMesh(cup, computeWater(cup), computeLight(cup)).faceCount).toBe(1);
  });

  // STRUCTURAL: 4 verts / 2 uv / 1 layer / 6 indices per quad, unit-axis normals.
  test("water buffers stay consistent and normals are unit axes", () => {
    const w = new World(4, 4, 4);
    w.set(1, 1, 1, Block.Water);
    w.set(2, 1, 1, Block.Water);
    const m = buildWaterMesh(w, computeWater(w), computeLight(w));
    expect(m.positions.length).toBe(m.faceCount * 12);
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
});
