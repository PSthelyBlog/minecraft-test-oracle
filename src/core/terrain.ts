/**
 * Deterministic terrain generation.
 *
 * Given the same seed and dimensions, `generateTerrain` must produce byte-for-byte
 * identical worlds (it is a pure function of seed + size). That determinism is the
 * oracle anchor: a golden-master test pins the output, and property tests assert
 * structural invariants (grass on top, dirt below, stone core, bedrock floor).
 *
 * Uses a small hash-based value-noise heightmap — no external noise dependency,
 * fully reproducible across machines.
 */

import { World } from "./world";
import { Block } from "./blocks";

/** Deterministic 32-bit hash → float in [0, 1). Pure; no global state. */
export function hash2(seed: number, x: number, z: number): number {
  let h = (seed | 0) ^ 0x9e3779b9;
  h = Math.imul(h ^ (x | 0), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13) ^ (z | 0), 0xc2b2ae35);
  h ^= h >>> 16;
  // Map the 32-bit signed int into [0, 1).
  return ((h >>> 0) % 100000) / 100000;
}

/** Smooth interpolation weight (smoothstep). */
function smooth(t: number): number {
  return t * t * (3 - 2 * t);
}

/** Bilinearly-interpolated value noise sampled on a grid of the given period. */
function valueNoise(seed: number, x: number, z: number, period: number): number {
  const gx = Math.floor(x / period);
  const gz = Math.floor(z / period);
  const fx = smooth((x - gx * period) / period);
  const fz = smooth((z - gz * period) / period);

  const v00 = hash2(seed, gx, gz);
  const v10 = hash2(seed, gx + 1, gz);
  const v01 = hash2(seed, gx, gz + 1);
  const v11 = hash2(seed, gx + 1, gz + 1);

  const a = v00 + (v10 - v00) * fx;
  const b = v01 + (v11 - v01) * fx;
  return a + (b - a) * fz;
}

/**
 * Surface height (top solid layer index) at column (x, z).
 * Always returns an integer in [1, sizeY - 1] so there is room for a bedrock
 * floor below and open air above.
 */
export function heightAt(seed: number, sizeY: number, x: number, z: number): number {
  // Two octaves of value noise for gentle rolling hills.
  const n = valueNoise(seed, x, z, 16) * 0.7 + valueNoise(seed, x, z, 8) * 0.3;
  const base = sizeY * 0.45;
  const amplitude = sizeY * 0.28;
  const h = Math.round(base + (n - 0.5) * 2 * amplitude);
  return Math.max(1, Math.min(sizeY - 1, h));
}

/**
 * Fill `world` in place with deterministic Classic-style terrain.
 *
 * Column layering, from the top solid block downward:
 *   - y == height           → Grass  (or Sand near/under water level)
 *   - height-3 ≤ y < height  → Dirt
 *   - 1 ≤ y < height-3       → Stone
 *   - y == 0                 → Bedrock (unbreakable floor)
 *   - y > height, y ≤ sea    → Water
 *
 * Then a tree pass (`placeTrees`) grows Log/Leaves trees on dry grass columns.
 */
export function generateTerrain(world: World, seed: number, seaLevel?: number): void {
  const sea = seaLevel ?? Math.floor(world.sizeY * 0.42);

  for (let z = 0; z < world.sizeZ; z++) {
    for (let x = 0; x < world.sizeX; x++) {
      const height = heightAt(seed, world.sizeY, x, z);

      for (let y = 0; y <= Math.max(height, sea); y++) {
        let block: number;
        if (y === 0) {
          block = Block.Bedrock;
        } else if (y < height - 3) {
          block = Block.Stone;
        } else if (y < height) {
          block = Block.Dirt;
        } else if (y === height) {
          // Beaches: sand at/just above the waterline.
          block = height <= sea + 1 ? Block.Sand : Block.Grass;
        } else if (y <= sea) {
          block = Block.Water;
        } else {
          block = Block.Air;
        }
        world.set(x, y, z, block);
      }
    }
  }

  placeTrees(world, seed, sea);
}

// --- Trees --------------------------------------------------------------------
//
// Deterministic placement: the world is tiled into TREE_CELL×TREE_CELL cells and
// each cell grows at most one tree, so trees are naturally spaced. A per-cell hash
// gate decides whether the cell grows one; two more hashes pick the column inside
// the cell; a fourth sets the trunk height. A tree appears only where its whole
// footprint is in bounds and the chosen column is a DRY GRASS surface (height above
// the beach/water line) with room under the ceiling — so a re-derivation of the same
// rule recovers exactly the set of trunks (the census oracle).

const TREE_CELL = 5; // one tree candidate per 5×5 column region
const TREE_DENSITY = 0.5; // fraction of cells that grow a tree
const CANOPY_RADIUS = 2; // leaves reach ±2 horizontally → footprint half-width

// Distinct salts so the four per-cell hashes are independent.
const SALT_GATE = 0x7a1;
const SALT_OX = 0x1b3;
const SALT_OZ = 0x2d9;
const SALT_TRUNK = 0x5e7;

/** Trunk height (4..6) for the tree in cell (cx, cz). */
function trunkHeightAt(seed: number, cx: number, cz: number): number {
  return 4 + Math.floor(hash2(seed ^ SALT_TRUNK, cx, cz) * 3);
}

interface Tree {
  x: number;
  z: number;
  base: number; // first trunk cell (height + 1)
  top: number; // last trunk cell (height + trunkHeight)
}

function placeTrees(world: World, seed: number, sea: number): void {
  const { sizeX, sizeY, sizeZ } = world;
  const cellsX = Math.ceil(sizeX / TREE_CELL);
  const cellsZ = Math.ceil(sizeZ / TREE_CELL);

  // Pass 1: decide which cells grow a tree and where (collect, don't place yet).
  const trees: Tree[] = [];
  for (let cz = 0; cz < cellsZ; cz++) {
    for (let cx = 0; cx < cellsX; cx++) {
      if (hash2(seed ^ SALT_GATE, cx, cz) >= TREE_DENSITY) continue;
      const x = cx * TREE_CELL + Math.floor(hash2(seed ^ SALT_OX, cx, cz) * TREE_CELL);
      const z = cz * TREE_CELL + Math.floor(hash2(seed ^ SALT_OZ, cx, cz) * TREE_CELL);
      // Whole footprint in bounds → no clipped trees, so leaves never spill OOB.
      if (x < CANOPY_RADIUS || x >= sizeX - CANOPY_RADIUS) continue;
      if (z < CANOPY_RADIUS || z >= sizeZ - CANOPY_RADIUS) continue;
      const height = heightAt(seed, sizeY, x, z);
      if (height <= sea + 1) continue; // grass only (not beach/sand/underwater)
      const top = height + trunkHeightAt(seed, cx, cz);
      if (top + 1 > sizeY - 1) continue; // the canopy cap must fit under the ceiling
      trees.push({ x, z, base: height + 1, top });
    }
  }

  // Pass 2: trunks (all before any canopy, so a trunk never overwrites a leaf).
  for (const t of trees) {
    for (let y = t.base; y <= t.top; y++) world.set(t.x, y, t.z, Block.Log);
  }

  // Pass 3: canopies — Leaves on Air only, so overlapping canopies merge and the
  // trunk's own column (already Log) is preserved. 5×5 (corner-trimmed) on the top
  // two trunk layers, a 3×3 cap one above.
  for (const t of trees) {
    for (let dy = -1; dy <= 1; dy++) {
      const y = t.top + dy;
      const r = dy <= 0 ? CANOPY_RADIUS : 1;
      for (let dz = -r; dz <= r; dz++) {
        for (let dx = -r; dx <= r; dx++) {
          if (r === CANOPY_RADIUS && Math.abs(dx) === r && Math.abs(dz) === r) continue; // trim corners
          if (world.get(t.x + dx, y, t.z + dz) === Block.Air) {
            world.set(t.x + dx, y, t.z + dz, Block.Leaves);
          }
        }
      }
    }
  }
}
