import { describe, test, expect } from "vitest";
import { Block, BLOCKS } from "./blocks";
import {
  Tile,
  TILE_COUNT,
  TILE_COLOR,
  ATLAS_COLS,
  ATLAS_ROWS,
  tileIndexFor,
  uvRectForTile,
} from "./atlas";

describe("atlas oracle", () => {
  // GOLDEN: pin the UV math for tile 0 and a tile on a later row/col, so a swapped
  // row/col or a wrong divisor is loud. Tile 0 is the top-left cell.
  test("golden: uvRectForTile maps index → cell with the exact divisors", () => {
    expect(uvRectForTile(0)).toEqual({ u0: 0, v0: 0, u1: 1 / 4, v1: 1 / 4 });
    // tile 6 → col 2, row 1 (4 cols): u in [2/4,3/4], v in [1/4,2/4]
    expect(uvRectForTile(6)).toEqual({ u0: 2 / 4, v0: 1 / 4, u1: 3 / 4, v1: 2 / 4 });
  });

  // BIJECTION/RE-DERIVATION: every tile's rect is a 1/COLS × 1/ROWS cell inside
  // [0,1]², and the rect's corner recovers the tile's (col, row) — i.e. no two tiles
  // overlap and none escapes the atlas. An independent recomputation, not a restatement.
  test("every tile occupies its own unit cell within [0,1]²", () => {
    const w = 1 / ATLAS_COLS, h = 1 / ATLAS_ROWS;
    for (let t = 0; t < ATLAS_COLS * ATLAS_ROWS; t++) {
      const r = uvRectForTile(t);
      // size is exactly one cell
      expect(r.u1 - r.u0).toBeCloseTo(w, 12);
      expect(r.v1 - r.v0).toBeCloseTo(h, 12);
      // inside the atlas
      expect(r.u0).toBeGreaterThanOrEqual(0);
      expect(r.v0).toBeGreaterThanOrEqual(0);
      expect(r.u1).toBeLessThanOrEqual(1 + 1e-12);
      expect(r.v1).toBeLessThanOrEqual(1 + 1e-12);
      // the lower-left corner recovers (col,row) → the original index (bijection)
      const col = Math.round(r.u0 / w);
      const row = Math.round(r.v0 / h);
      expect(col + ATLAS_COLS * row).toBe(t);
      expect(col).toBeLessThan(ATLAS_COLS);
      expect(row).toBeLessThan(ATLAS_ROWS);
    }
  });

  // TOTALITY: every meshable (non-air) block, on every one of its 6 faces, maps to a
  // tile index that actually exists and has a colour. A gap would render as a garbage
  // tile (or out-of-atlas UVs) with no error.
  test("tileIndexFor is total: every block × face → an existing, coloured tile", () => {
    for (const idStr of Object.keys(BLOCKS)) {
      const id = Number(idStr);
      if (id === Block.Air) continue;
      for (let face = 0; face < 6; face++) {
        const t = tileIndexFor(id, face);
        expect(Number.isInteger(t)).toBe(true);
        expect(t).toBeGreaterThanOrEqual(0);
        expect(t).toBeLessThan(TILE_COUNT);
        expect(TILE_COLOR[t as keyof typeof TILE_COLOR]).toBeDefined();
      }
    }
  });

  // GOLDEN: the per-face tile selection. Grass is the iconic case — green top, dirt
  // bottom, grass-side ring — and logs show end-grain on the caps. A naive "one tile
  // per block" regression makes all of grass's faces equal, which this catches.
  // Faces: 0=+X,1=−X,2=+Y(top),3=−Y(bottom),4=+Z,5=−Z.
  test("golden: grass/log pick distinct tiles per face; plain blocks are uniform", () => {
    expect(tileIndexFor(Block.Grass, 2)).toBe(Tile.GrassTop);
    expect(tileIndexFor(Block.Grass, 3)).toBe(Tile.Dirt);
    for (const side of [0, 1, 4, 5]) expect(tileIndexFor(Block.Grass, side)).toBe(Tile.GrassSide);

    expect(tileIndexFor(Block.Log, 2)).toBe(Tile.LogTop);
    expect(tileIndexFor(Block.Log, 3)).toBe(Tile.LogTop);
    for (const side of [0, 1, 4, 5]) expect(tileIndexFor(Block.Log, side)).toBe(Tile.LogSide);

    // a plain block uses the same tile on all six faces
    const stone = new Set([0, 1, 2, 3, 4, 5].map((f) => tileIndexFor(Block.Stone, f)));
    expect(stone).toEqual(new Set([Tile.Stone]));
    expect(tileIndexFor(Block.Brick, 2)).not.toBe(tileIndexFor(Block.Stone, 2));
  });

  // INJECTION (static-data falsifiability): the tile colours are distinct enough that
  // grass-top and dirt — the two faces of a grass block that MUST differ — are not the
  // same colour. Proves the static table is actually consulted, not a stub.
  test("grass-top and dirt tile colours differ", () => {
    expect(TILE_COLOR[Tile.GrassTop]).not.toEqual(TILE_COLOR[Tile.Dirt]);
  });
});
