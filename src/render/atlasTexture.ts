/**
 * Procedurally generates the block texture atlas as a Three.js DataTexture — no
 * image assets, fully deterministic. Each tile is painted with its core-defined
 * `TILE_COLOR`, plus a cheap per-pixel pattern (deterministic value noise + a 1px
 * bevel) so blocks read as *textured* rather than flat, in the Classic pixelated
 * style (NearestFilter, no mipmaps).
 *
 * This is thin Three.js wiring (render shell, covered by the smoke test). The UV
 * *layout* it must agree with — tile index → cell — lives in the oracle-tested
 * `core/atlas.ts`, so this file only fills pixels into those cells.
 */

import { DataTexture, RGBAFormat, UnsignedByteType, NearestFilter, SRGBColorSpace } from "three";
import { ATLAS_COLS, ATLAS_ROWS, TILE_COLOR, TILE_COUNT, type TileIndex } from "../core/atlas";

/** Deterministic value in [0,1) from integer coords — a hashed substitute for noise. */
function hash01(x: number, y: number, t: number): number {
  let h = (x * 374761393 + y * 668265263 + t * 2246822519) >>> 0;
  h = (h ^ (h >>> 13)) >>> 0;
  h = (h * 1274126177) >>> 0;
  return (h & 0xffff) / 0x10000;
}

/** Brightness multiplier for one texel of a tile: subtle grain + darker edge bevel. */
function patternFactor(tx: number, ty: number, tile: number, n: number): number {
  const onEdge = tx === 0 || ty === 0 || tx === n - 1 || ty === n - 1;
  const bevel = onEdge ? 0.8 : 1.0;
  const grain = 0.86 + 0.14 * hash01(tx, ty, tile);
  return bevel * grain;
}

const clamp255 = (v: number): number => (v < 0 ? 0 : v > 255 ? 255 : v) | 0;

export function buildAtlasTexture(tilePx = 16): DataTexture {
  const W = ATLAS_COLS * tilePx;
  const H = ATLAS_ROWS * tilePx;
  const data = new Uint8Array(W * H * 4);

  for (let tile = 0; tile < TILE_COUNT; tile++) {
    const col = tile % ATLAS_COLS;
    const row = Math.floor(tile / ATLAS_COLS);
    const [r, g, b] = TILE_COLOR[tile as TileIndex];
    for (let ty = 0; ty < tilePx; ty++) {
      for (let tx = 0; tx < tilePx; tx++) {
        const f = patternFactor(tx, ty, tile, tilePx);
        const px = col * tilePx + tx;
        const py = row * tilePx + ty;
        const i = (py * W + px) * 4;
        data[i] = clamp255(r * 255 * f);
        data[i + 1] = clamp255(g * 255 * f);
        data[i + 2] = clamp255(b * 255 * f);
        data[i + 3] = 255;
      }
    }
  }

  const tex = new DataTexture(data, W, H, RGBAFormat, UnsignedByteType);
  tex.magFilter = NearestFilter;
  tex.minFilter = NearestFilter;
  tex.colorSpace = SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}
