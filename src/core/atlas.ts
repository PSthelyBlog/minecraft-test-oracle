/**
 * Texture-atlas layout: the pure mapping from (block, face) to a tile, and from a
 * tile to its UV rectangle in the atlas. This is the silent-failure surface behind
 * textured blocks — an off-by-one in the row/column math, a flipped axis, or the
 * wrong tile for a face all render as "subtly wrong textures" with no error — so it
 * lives in the oracle-tested core, separate from the Three.js texture generation.
 *
 * The atlas is a fixed ATLAS_COLS × ATLAS_ROWS grid of square tiles; tile index t
 * occupies column `t % ATLAS_COLS`, row `Math.floor(t / ATLAS_COLS)`.
 */

import { Block, type BlockId } from "./blocks";

export const ATLAS_COLS = 4;
export const ATLAS_ROWS = 4;

/** Tile slots in the atlas (grass and log get distinct top/side tiles). */
export const Tile = {
  Stone: 0,
  GrassTop: 1,
  GrassSide: 2,
  Dirt: 3,
  Cobblestone: 4,
  Planks: 5,
  Sand: 6,
  Gravel: 7,
  LogTop: 8,
  LogSide: 9,
  Leaves: 10,
  Glass: 11,
  Brick: 12,
  Bedrock: 13,
  Water: 14,
} as const;

export type TileIndex = (typeof Tile)[keyof typeof Tile];

/** Number of tiles actually used (≤ ATLAS_COLS*ATLAS_ROWS). */
export const TILE_COUNT = 15;

function rgb(r: number, g: number, b: number): readonly [number, number, number] {
  return [r / 255, g / 255, b / 255];
}

/**
 * Base colour each tile is painted with when the atlas image is generated. Static
 * data (like `BLOCKS`) — its falsifiability is proven by injection, and Stryker's
 * `ignoreStatic` excludes import-time-constant mutants from the score.
 */
export const TILE_COLOR: Readonly<Record<TileIndex, readonly [number, number, number]>> = {
  [Tile.Stone]: rgb(127, 127, 127),
  [Tile.GrassTop]: rgb(95, 159, 53),
  [Tile.GrassSide]: rgb(110, 140, 70),
  [Tile.Dirt]: rgb(134, 96, 67),
  [Tile.Cobblestone]: rgb(105, 105, 105),
  [Tile.Planks]: rgb(157, 128, 79),
  [Tile.Sand]: rgb(219, 207, 142),
  [Tile.Gravel]: rgb(136, 126, 125),
  [Tile.LogTop]: rgb(160, 130, 80),
  [Tile.LogSide]: rgb(102, 81, 49),
  [Tile.Leaves]: rgb(60, 120, 40),
  [Tile.Glass]: rgb(200, 230, 240),
  [Tile.Brick]: rgb(150, 80, 65),
  [Tile.Bedrock]: rgb(40, 40, 40),
  [Tile.Water]: rgb(40, 90, 200),
};

/** One tile per simple block; grass and log are overridden per-face below. */
const BLOCK_TILE: Readonly<Record<BlockId, TileIndex>> = {
  [Block.Stone]: Tile.Stone,
  [Block.Grass]: Tile.GrassSide, // default; +Y/−Y overridden in tileIndexFor
  [Block.Dirt]: Tile.Dirt,
  [Block.Cobblestone]: Tile.Cobblestone,
  [Block.Planks]: Tile.Planks,
  [Block.Sand]: Tile.Sand,
  [Block.Gravel]: Tile.Gravel,
  [Block.Log]: Tile.LogSide, // default; ±Y overridden in tileIndexFor
  [Block.Leaves]: Tile.Leaves,
  [Block.Glass]: Tile.Glass,
  [Block.Brick]: Tile.Brick,
  [Block.Bedrock]: Tile.Bedrock,
  [Block.Water]: Tile.Water,
};

// Face indices match mesher's FACES order: 0=+X, 1=−X, 2=+Y, 3=−Y, 4=+Z, 5=−Z.
const FACE_TOP = 2;
const FACE_BOTTOM = 3;

/**
 * The atlas tile a given face of a given block should sample. Grass shows its green
 * top, dirt bottom, and grass-side ring; logs show end-grain on the caps and bark on
 * the sides; every other block uses a single tile on all faces.
 */
export function tileIndexFor(id: BlockId, faceIndex: number): TileIndex {
  if (id === Block.Grass) {
    if (faceIndex === FACE_TOP) return Tile.GrassTop;
    if (faceIndex === FACE_BOTTOM) return Tile.Dirt;
    return Tile.GrassSide;
  }
  if (id === Block.Log) {
    if (faceIndex === FACE_TOP || faceIndex === FACE_BOTTOM) return Tile.LogTop;
    return Tile.LogSide;
  }
  return BLOCK_TILE[id] ?? Tile.Stone;
}

export interface UVRect {
  readonly u0: number;
  readonly v0: number;
  readonly u1: number;
  readonly v1: number;
}

/**
 * The UV rectangle (in [0,1] atlas space) covering tile `t`. Column advances u,
 * row advances v; each tile is exactly 1/ATLAS_COLS wide and 1/ATLAS_ROWS tall.
 */
export function uvRectForTile(t: number): UVRect {
  const col = t % ATLAS_COLS;
  const row = Math.floor(t / ATLAS_COLS);
  return {
    u0: col / ATLAS_COLS,
    v0: row / ATLAS_ROWS,
    u1: (col + 1) / ATLAS_COLS,
    v1: (row + 1) / ATLAS_ROWS,
  };
}
