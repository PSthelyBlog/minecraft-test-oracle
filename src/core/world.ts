/**
 * Fixed-size voxel world, stored as a flat Uint8Array (one block id per cell),
 * matching Minecraft Classic's bounded worlds.
 *
 * Coordinate / index convention (the single source of truth for the whole core):
 *
 *   index(x, y, z) = x + sizeX * (z + sizeZ * y)
 *
 * i.e. x is fastest-varying, then z, then y (y-major). Every consumer
 * (mesher, terrain, raycast, physics) must agree with this, which is exactly
 * the kind of silent off-by-one surface the oracle suite pins down.
 */

import { Block, type BlockId } from "./blocks";

export class World {
  readonly sizeX: number;
  readonly sizeY: number;
  readonly sizeZ: number;
  readonly data: Uint8Array;

  constructor(sizeX: number, sizeY: number, sizeZ: number) {
    if (sizeX <= 0 || sizeY <= 0 || sizeZ <= 0) {
      throw new RangeError(`World dimensions must be positive, got ${sizeX}x${sizeY}x${sizeZ}`);
    }
    if (!Number.isInteger(sizeX) || !Number.isInteger(sizeY) || !Number.isInteger(sizeZ)) {
      throw new RangeError(`World dimensions must be integers, got ${sizeX}x${sizeY}x${sizeZ}`);
    }
    this.sizeX = sizeX;
    this.sizeY = sizeY;
    this.sizeZ = sizeZ;
    this.data = new Uint8Array(sizeX * sizeY * sizeZ);
  }

  /** True iff (x, y, z) is a valid cell inside the world bounds. */
  inBounds(x: number, y: number, z: number): boolean {
    return (
      x >= 0 && x < this.sizeX &&
      y >= 0 && y < this.sizeY &&
      z >= 0 && z < this.sizeZ
    );
  }

  /**
   * Flat array index for an in-bounds cell. Behaviour for out-of-bounds input is
   * unspecified — callers must guard with `inBounds` first (get/set already do).
   */
  index(x: number, y: number, z: number): number {
    return x + this.sizeX * (z + this.sizeZ * y);
  }

  /** Block id at (x, y, z). Out-of-bounds reads return Air (open sky / open sides). */
  get(x: number, y: number, z: number): BlockId {
    if (!this.inBounds(x, y, z)) return Block.Air;
    return this.data[this.index(x, y, z)];
  }

  /**
   * Write a block id. Out-of-bounds writes are ignored and return false.
   * Returns true iff the cell was inside the world.
   */
  set(x: number, y: number, z: number, id: BlockId): boolean {
    if (!this.inBounds(x, y, z)) return false;
    this.data[this.index(x, y, z)] = id;
    return true;
  }

  /** Total number of cells. */
  get volume(): number {
    return this.sizeX * this.sizeY * this.sizeZ;
  }
}
