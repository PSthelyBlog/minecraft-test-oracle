import { describe, test, expect } from "vitest";
import { Block, BLOCKS, HOTBAR, blockDef, isSolid, isOpaque, isAir } from "./blocks";

/**
 * The block registry is a hand-authored table — a classic silent surface where a
 * single flipped `solid`/`opaque` flag silently breaks physics or face culling
 * with no error. These oracles pin the BEHAVIOURAL facets exactly (census) and
 * freeze the cosmetic data (colours/names) as a golden so any drift is loud.
 */

// Frozen contract: [solid, opaque] for every block id. Derived by intent, NOT by
// reading BLOCKS, so a mutated flag disagrees with this table.
const FACETS: Record<number, { name: string; solid: boolean; opaque: boolean }> = {
  [Block.Air]: { name: "Air", solid: false, opaque: false },
  [Block.Stone]: { name: "Stone", solid: true, opaque: true },
  [Block.Grass]: { name: "Grass", solid: true, opaque: true },
  [Block.Dirt]: { name: "Dirt", solid: true, opaque: true },
  [Block.Cobblestone]: { name: "Cobblestone", solid: true, opaque: true },
  [Block.Planks]: { name: "Planks", solid: true, opaque: true },
  [Block.Sand]: { name: "Sand", solid: true, opaque: true },
  [Block.Gravel]: { name: "Gravel", solid: true, opaque: true },
  [Block.Log]: { name: "Log", solid: true, opaque: true },
  [Block.Leaves]: { name: "Leaves", solid: true, opaque: false },
  [Block.Glass]: { name: "Glass", solid: true, opaque: false },
  [Block.Brick]: { name: "Brick", solid: true, opaque: true },
  [Block.Bedrock]: { name: "Bedrock", solid: true, opaque: true },
  [Block.Water]: { name: "Water", solid: false, opaque: false },
};

describe("blocks oracle", () => {
  // CENSUS: every defined block matches the frozen facet contract, exactly.
  test("every block's solid/opaque/name matches the frozen contract", () => {
    const ids = Object.values(Block);
    // the registry defines exactly the known ids — no more, no fewer
    expect(new Set(Object.keys(BLOCKS).map(Number))).toEqual(new Set(ids));
    for (const id of ids) {
      const want = FACETS[id];
      expect({ name: BLOCKS[id].name, solid: BLOCKS[id].solid, opaque: BLOCKS[id].opaque }).toEqual(want);
      // the accessor helpers agree with the table
      expect(isSolid(id)).toBe(want.solid);
      expect(isOpaque(id)).toBe(want.opaque);
    }
  });

  // INVARIANT: opaque ⇒ solid for every block (a see-through solid is fine, but an
  // opaque non-solid block would be a meshing/physics contradiction). Air aside.
  test("every opaque block is also solid", () => {
    for (const id of Object.values(Block)) {
      if (isOpaque(id)) expect(isSolid(id)).toBe(true);
    }
  });

  // GOLDEN: colours are deterministic output; freeze them so a wrong channel is loud.
  test("golden: a stable hash over all block colours", () => {
    const ids = Object.values(Block).sort((a, b) => a - b);
    let h = 0x811c9dc5;
    for (const id of ids) {
      for (const ch of BLOCKS[id].color) {
        h ^= Math.round(ch * 255);
        h = Math.imul(h, 0x01000193);
      }
    }
    expect((h >>> 0).toString(16)).toBe("adadacab");
  });

  // TOTALITY: unknown ids fall back to Air rather than throwing or returning undefined.
  test("blockDef is total: unknown ids fall back to Air", () => {
    expect(blockDef(9999)).toBe(BLOCKS[Block.Air]);
    expect(isSolid(9999)).toBe(false);
    expect(isOpaque(9999)).toBe(false);
    expect(isAir(Block.Air)).toBe(true);
    expect(isAir(Block.Stone)).toBe(false);
  });

  // INVARIANT: the hotbar exposes only real, placeable (non-air) blocks, no dupes.
  test("hotbar is non-air, defined, and duplicate-free", () => {
    expect(HOTBAR.length).toBeGreaterThan(0);
    expect(new Set(HOTBAR).size).toBe(HOTBAR.length);
    for (const id of HOTBAR) {
      expect(id).not.toBe(Block.Air);
      expect(BLOCKS[id]).toBeDefined();
    }
  });
});
