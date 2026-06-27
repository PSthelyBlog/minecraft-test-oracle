import { describe, test, expect } from "vitest";
import { ATLAS_COLS, TILE_COUNT, TILE_COLOR, type TileIndex } from "../core/atlas";
import { buildAtlasTexture } from "./atlasTexture";

/**
 * The atlas generator must paint each tile's CELL with that tile's colour, using the
 * same index→cell layout the mesher's UVs assume (`uvRectForTile`). If this file and
 * `core/atlas.ts` disagreed on the row/column math — or a tile got the wrong colour —
 * blocks would sample the wrong texture with no error. So we read the generated
 * pixels back and check every tile cell averages to its `TILE_COLOR` (modulo the
 * deterministic brightness pattern). `DataTexture` holds a plain `Uint8Array`, so no
 * WebGL context is needed.
 */
describe("atlasTexture oracle", () => {
  test("each tile cell is painted its own TILE_COLOR at the right atlas position", () => {
    const tilePx = 16;
    const tex = buildAtlasTexture(tilePx);
    const W = tex.image.width;
    const data = tex.image.data as Uint8Array;

    for (let tile = 0; tile < TILE_COUNT; tile++) {
      const col = tile % ATLAS_COLS;
      const row = Math.floor(tile / ATLAS_COLS);
      // Average the cell interior (skip the 1px bevel border).
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let ty = 1; ty < tilePx - 1; ty++) {
        for (let tx = 1; tx < tilePx - 1; tx++) {
          const px = col * tilePx + tx, py = row * tilePx + ty;
          const i = (py * W + px) * 4;
          r += data[i]; g += data[i + 1]; b += data[i + 2]; a += data[i + 3]; n++;
        }
      }
      r /= n; g /= n; b /= n; a /= n;

      const [cr, cg, cb] = TILE_COLOR[tile as TileIndex];
      // The grain factor averages ~0.93; allow a generous band per channel.
      const tol = 28;
      expect(Math.abs(r - cr * 255 * 0.93)).toBeLessThanOrEqual(tol);
      expect(Math.abs(g - cg * 255 * 0.93)).toBeLessThanOrEqual(tol);
      expect(Math.abs(b - cb * 255 * 0.93)).toBeLessThanOrEqual(tol);
      expect(a).toBe(255); // fully opaque
    }
  });

  test("the texture is the full atlas size and uses crisp (nearest) filtering", () => {
    const tex = buildAtlasTexture(8);
    expect(tex.image.width).toBe(ATLAS_COLS * 8);
    expect(tex.image.data.length).toBe(tex.image.width * tex.image.height * 4);
    expect(tex.magFilter).toBeDefined();
  });
});
