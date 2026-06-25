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
}
