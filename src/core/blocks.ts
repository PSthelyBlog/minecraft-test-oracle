/**
 * Block registry for the Minecraft Classic clone.
 *
 * Classic (2009) used flat-coloured / textured cubes. We model each block with a
 * solid RGB colour (good enough for a faithful Classic look without textures) and
 * two boolean facets that the mesher and physics depend on:
 *
 *   - solid:  does the player collide with it? (air, water are non-solid)
 *   - opaque: does it fully hide the neighbouring face? (glass, water, leaves don't)
 *
 * IDs are stable and contiguous from 0 so a world can be stored as a Uint8Array.
 */

export type BlockId = number;

export const Block = {
  Air: 0,
  Stone: 1,
  Grass: 2,
  Dirt: 3,
  Cobblestone: 4,
  Planks: 5,
  Sand: 6,
  Gravel: 7,
  Log: 8,
  Leaves: 9,
  Glass: 10,
  Brick: 11,
  Bedrock: 12,
  Water: 13,
} as const;

export type BlockKey = keyof typeof Block;

export interface BlockDef {
  readonly id: BlockId;
  readonly name: string;
  /** Player collides with this block. */
  readonly solid: boolean;
  /** Fully hides the touching face of an adjacent block (used for face culling). */
  readonly opaque: boolean;
  /** Base colour as [r, g, b] in 0..1. */
  readonly color: readonly [number, number, number];
}

function rgb(r: number, g: number, b: number): readonly [number, number, number] {
  return [r / 255, g / 255, b / 255];
}

/** Definitions indexed by block id. `BLOCKS[id]` is total over all defined ids. */
export const BLOCKS: Readonly<Record<BlockId, BlockDef>> = {
  [Block.Air]: { id: Block.Air, name: "Air", solid: false, opaque: false, color: rgb(0, 0, 0) },
  [Block.Stone]: { id: Block.Stone, name: "Stone", solid: true, opaque: true, color: rgb(127, 127, 127) },
  [Block.Grass]: { id: Block.Grass, name: "Grass", solid: true, opaque: true, color: rgb(95, 159, 53) },
  [Block.Dirt]: { id: Block.Dirt, name: "Dirt", solid: true, opaque: true, color: rgb(134, 96, 67) },
  [Block.Cobblestone]: { id: Block.Cobblestone, name: "Cobblestone", solid: true, opaque: true, color: rgb(105, 105, 105) },
  [Block.Planks]: { id: Block.Planks, name: "Planks", solid: true, opaque: true, color: rgb(157, 128, 79) },
  [Block.Sand]: { id: Block.Sand, name: "Sand", solid: true, opaque: true, color: rgb(219, 207, 142) },
  [Block.Gravel]: { id: Block.Gravel, name: "Gravel", solid: true, opaque: true, color: rgb(136, 126, 125) },
  [Block.Log]: { id: Block.Log, name: "Log", solid: true, opaque: true, color: rgb(102, 81, 49) },
  [Block.Leaves]: { id: Block.Leaves, name: "Leaves", solid: true, opaque: false, color: rgb(60, 120, 40) },
  [Block.Glass]: { id: Block.Glass, name: "Glass", solid: true, opaque: false, color: rgb(200, 230, 240) },
  [Block.Brick]: { id: Block.Brick, name: "Brick", solid: true, opaque: true, color: rgb(150, 80, 65) },
  [Block.Bedrock]: { id: Block.Bedrock, name: "Bedrock", solid: true, opaque: true, color: rgb(40, 40, 40) },
  [Block.Water]: { id: Block.Water, name: "Water", solid: false, opaque: false, color: rgb(40, 90, 200) },
};

/** Ordered list of placeable blocks for the hotbar (excludes Air). */
export const HOTBAR: readonly BlockId[] = [
  Block.Grass, Block.Dirt, Block.Stone, Block.Cobblestone,
  Block.Planks, Block.Log, Block.Leaves, Block.Sand,
  Block.Glass, Block.Brick,
];

export function blockDef(id: BlockId): BlockDef {
  return BLOCKS[id] ?? BLOCKS[Block.Air];
}

export function isSolid(id: BlockId): boolean {
  return blockDef(id).solid;
}

export function isOpaque(id: BlockId): boolean {
  return blockDef(id).opaque;
}

export function isAir(id: BlockId): boolean {
  return id === Block.Air;
}
