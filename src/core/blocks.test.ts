import { describe, test, expect } from "vitest";
import { Block, BLOCKS, HOTBAR, blockDef, isSolid, isOpaque, isAir, emissionOf } from "./blocks";

/**
 * The block registry is a hand-authored table — a classic silent surface where a
 * single flipped `solid`/`opaque`/`emission` value silently breaks physics, face
 * culling, or lighting with no error. These oracles pin the BEHAVIOURAL facets
 * exactly (census) and freeze the cosmetic data (colours/names) as a golden so any
 * drift is loud.
 */

// Frozen contract: {name, solid, opaque, emission} for every block id. Derived by
// intent, NOT by reading BLOCKS, so a mutated value disagrees with this table.
// emission is 0 for every block except light sources (Glowstone = 15).
const FACETS: Record<number, { name: string; solid: boolean; opaque: boolean; emission: number }> =
  {
    [Block.Air]: { name: "Air", solid: false, opaque: false, emission: 0 },
    [Block.Stone]: { name: "Stone", solid: true, opaque: true, emission: 0 },
    [Block.Grass]: { name: "Grass", solid: true, opaque: true, emission: 0 },
    [Block.Dirt]: { name: "Dirt", solid: true, opaque: true, emission: 0 },
    [Block.Cobblestone]: { name: "Cobblestone", solid: true, opaque: true, emission: 0 },
    [Block.Planks]: { name: "Planks", solid: true, opaque: true, emission: 0 },
    [Block.Sand]: { name: "Sand", solid: true, opaque: true, emission: 0 },
    [Block.Gravel]: { name: "Gravel", solid: true, opaque: true, emission: 0 },
    [Block.Log]: { name: "Log", solid: true, opaque: true, emission: 0 },
    [Block.Leaves]: { name: "Leaves", solid: true, opaque: false, emission: 0 },
    [Block.Glass]: { name: "Glass", solid: true, opaque: false, emission: 0 },
    [Block.Brick]: { name: "Brick", solid: true, opaque: true, emission: 0 },
    [Block.Bedrock]: { name: "Bedrock", solid: true, opaque: true, emission: 0 },
    [Block.Water]: { name: "Water", solid: false, opaque: false, emission: 0 },
    [Block.Glowstone]: { name: "Glowstone", solid: true, opaque: true, emission: 15 },
  };

describe("blocks oracle", () => {
  // CENSUS: every defined block matches the frozen facet contract, exactly.
  test("every block's solid/opaque/name matches the frozen contract", () => {
    const ids = Object.values(Block);
    // the registry defines exactly the known ids — no more, no fewer
    expect(new Set(Object.keys(BLOCKS).map(Number))).toEqual(new Set(ids));
    for (const id of ids) {
      const want = FACETS[id];
      expect({
        name: BLOCKS[id].name,
        solid: BLOCKS[id].solid,
        opaque: BLOCKS[id].opaque,
        emission: BLOCKS[id].emission,
      }).toEqual(want);
      // the accessor helpers agree with the table
      expect(isSolid(id)).toBe(want.solid);
      expect(isOpaque(id)).toBe(want.opaque);
      expect(emissionOf(id)).toBe(want.emission);
    }
  });

  // INVARIANT: emission is a level in [0, 15]; exactly the light sources emit (> 0).
  test("emission is bounded 0..15 and only light sources emit", () => {
    let emitters = 0;
    for (const id of Object.values(Block)) {
      const e = emissionOf(id);
      expect(Number.isInteger(e)).toBe(true);
      expect(e).toBeGreaterThanOrEqual(0);
      expect(e).toBeLessThanOrEqual(15);
      if (e > 0) emitters++;
    }
    expect(emissionOf(Block.Glowstone)).toBe(15); // the one light source so far
    expect(emitters).toBe(1);
    expect(emissionOf(9999)).toBe(0); // unknown ids fall back to Air → no light
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
    expect((h >>> 0).toString(16)).toBe("a1091d4b");
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
