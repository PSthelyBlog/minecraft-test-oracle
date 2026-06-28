import { describe, test, expect } from "vitest";
import { Block, BLOCKS } from "./blocks";
import { Tile, TILE_COUNT, TILE_COLOR, tileIndexFor } from "./atlas";

describe("atlas oracle", () => {
  // TOTALITY: every meshable (non-air) block, on every one of its 6 faces, maps to a
  // tile index (= texture-array layer) that actually exists and has a colour. A gap
  // would sample a non-existent layer (garbage / clamped) with no error.
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
