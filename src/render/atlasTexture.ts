/**
 * Procedurally generates the block tile set as a Three.js DataArrayTexture — no
 * image assets, fully deterministic. Each tile is its OWN array layer (index =
 * the core `Tile`/tileIndex), painted with its `TILE_COLOR` plus a cheap per-pixel
 * pattern (deterministic value noise + a 1px bevel) so blocks read as *textured*
 * rather than flat, in the Classic pixelated style (NearestFilter, no mipmaps).
 *
 * Why an array (not a 4×4 atlas grid): a greedy-meshed quad spanning N×M cells
 * must TILE its texture N×M times. RepeatWrapping on a single 2D atlas would wrap
 * into neighbouring tiles; with one tile per array layer, tile-local UVs in [0,N]
 * repeat that layer cleanly. The mesher emits a per-vertex `layer` (tile index)
 * and tile-local UVs; the terrain material samples `texture(array, vec3(uv, layer))`.
 *
 * This is thin Three.js wiring (render shell, covered by the smoke test). The tile
 * SELECTION — (block, face) → tile index — lives in the oracle-tested `core/atlas.ts`.
 */

import {
  DataArrayTexture,
  RGBAFormat,
  UnsignedByteType,
  NearestFilter,
  RepeatWrapping,
  SRGBColorSpace,
} from "three";
import { TILE_COLOR, TILE_COUNT, type TileIndex } from "../core/atlas";

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

/**
 * Build the tile texture as a DataArrayTexture of TILE_COUNT layers, each
 * `tilePx × tilePx`. Layer `t` is tile index `t` (so `layer` from the mesher
 * indexes straight into it). RepeatWrapping lets a tile-local UV > 1 (a greedy
 * quad) repeat the layer; NearestFilter + no mipmaps keeps the pixelated look.
 */
export function buildTileArrayTexture(tilePx = 16): DataArrayTexture {
  const layerStride = tilePx * tilePx * 4;
  const data = new Uint8Array(layerStride * TILE_COUNT);

  for (let tile = 0; tile < TILE_COUNT; tile++) {
    const [r, g, b] = TILE_COLOR[tile as TileIndex];
    const layerBase = tile * layerStride;
    for (let ty = 0; ty < tilePx; ty++) {
      for (let tx = 0; tx < tilePx; tx++) {
        const f = patternFactor(tx, ty, tile, tilePx);
        const i = layerBase + (ty * tilePx + tx) * 4;
        data[i] = clamp255(r * 255 * f);
        data[i + 1] = clamp255(g * 255 * f);
        data[i + 2] = clamp255(b * 255 * f);
        data[i + 3] = 255;
      }
    }
  }

  const tex = new DataArrayTexture(data, tilePx, tilePx, TILE_COUNT);
  tex.format = RGBAFormat;
  tex.type = UnsignedByteType;
  tex.magFilter = NearestFilter;
  tex.minFilter = NearestFilter;
  tex.wrapS = RepeatWrapping;
  tex.wrapT = RepeatWrapping;
  tex.generateMipmaps = false;
  tex.colorSpace = SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}
