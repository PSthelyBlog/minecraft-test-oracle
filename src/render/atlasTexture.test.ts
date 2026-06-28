import { describe, test, expect } from "vitest";
import { NearestFilter, RepeatWrapping } from "three";
import { TILE_COUNT, TILE_COLOR, type TileIndex } from "../core/atlas";
import { buildTileArrayTexture } from "./atlasTexture";

/**
 * The tile generator must paint each tile's own array LAYER with that tile's colour,
 * at layer index == the core tile index the mesher's `layer` attribute assumes. If
 * this file and `core/atlas.ts` disagreed on which layer holds which tile — or a tile
 * got the wrong colour — blocks would sample the wrong texture with no error. So we
 * read the generated pixels back and check every layer averages to its `TILE_COLOR`
 * (modulo the deterministic brightness pattern). `DataArrayTexture` holds a plain
 * `Uint8Array`, so no WebGL context is needed.
 */
describe("tile array texture oracle", () => {
  test("each layer is painted its own TILE_COLOR at layer index == tile index", () => {
    const tilePx = 16;
    const tex = buildTileArrayTexture(tilePx);
    const data = tex.image.data as Uint8Array;
    const layerStride = tilePx * tilePx * 4;

    for (let tile = 0; tile < TILE_COUNT; tile++) {
      // Average the layer interior (skip the 1px bevel border).
      let r = 0,
        g = 0,
        b = 0,
        a = 0,
        n = 0;
      for (let ty = 1; ty < tilePx - 1; ty++) {
        for (let tx = 1; tx < tilePx - 1; tx++) {
          const i = tile * layerStride + (ty * tilePx + tx) * 4;
          r += data[i];
          g += data[i + 1];
          b += data[i + 2];
          a += data[i + 3];
          n++;
        }
      }
      r /= n;
      g /= n;
      b /= n;
      a /= n;

      const [cr, cg, cb] = TILE_COLOR[tile as TileIndex];
      // The grain factor averages ~0.93; allow a generous band per channel.
      const tol = 28;
      expect(Math.abs(r - cr * 255 * 0.93)).toBeLessThanOrEqual(tol);
      expect(Math.abs(g - cg * 255 * 0.93)).toBeLessThanOrEqual(tol);
      expect(Math.abs(b - cb * 255 * 0.93)).toBeLessThanOrEqual(tol);
      expect(a).toBe(255); // fully opaque
    }
  });

  test("the texture is one square layer per tile, crisp (nearest), and repeat-wrapped", () => {
    const tilePx = 8;
    const tex = buildTileArrayTexture(tilePx);
    expect(tex.image.width).toBe(tilePx);
    expect(tex.image.height).toBe(tilePx);
    expect(tex.image.depth).toBe(TILE_COUNT); // one layer per tile
    expect((tex.image.data as Uint8Array).length).toBe(tilePx * tilePx * TILE_COUNT * 4);
    expect(tex.magFilter).toBe(NearestFilter);
    expect(tex.minFilter).toBe(NearestFilter);
    // Repeat wrapping is what lets a greedy quad's UV > 1 tile the layer.
    expect(tex.wrapS).toBe(RepeatWrapping);
    expect(tex.wrapT).toBe(RepeatWrapping);
  });
});
