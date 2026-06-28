/**
 * World save/load: a compact, deterministic serialization of a {@link World} so a
 * session can survive a page reload.
 *
 * Format (little-endian binary, then base64 for string storage):
 *
 *   header (13 bytes):  version:u8  sizeX:u32  sizeY:u32  sizeZ:u32
 *   body:               run* where run = count:u32  value:u8
 *
 * The body is a run-length encoding of the flat block array in `World.data` order
 * (the x→z→y index convention). Voxel worlds are mostly long runs of Air, Stone and
 * Water, so this compresses hard while staying trivial to verify: the runs must
 * cover exactly `volume` cells. `decodeWorld` is the exact inverse of `encodeWorld`
 * — pinned by the round-trip census oracle.
 *
 * Pure (no DOM, no Three.js): `btoa`/`atob` are the WHATWG base64 primitives, present
 * in both the browser and Node, so this module still runs under the Node test suite.
 */

import { World } from "./world";

/** Bumped only when the byte layout changes incompatibly. */
export const FORMAT_VERSION = 1;

const HEADER_BYTES = 13; // version(1) + sizeX/sizeY/sizeZ (u32 each)
const RUN_BYTES = 5; // count(u32) + value(u8)

/** Encode a world to the binary save format (header + RLE body). */
export function encodeWorld(world: World): Uint8Array {
  const { data } = world;
  // Build the runs first so we know the exact output length.
  const counts: number[] = [];
  const values: number[] = [];
  for (let i = 0; i < data.length;) {
    const value = data[i];
    let j = i + 1;
    while (j < data.length && data[j] === value) j++;
    counts.push(j - i);
    values.push(value);
    i = j;
  }

  const out = new Uint8Array(HEADER_BYTES + counts.length * RUN_BYTES);
  const view = new DataView(out.buffer);
  out[0] = FORMAT_VERSION;
  view.setUint32(1, world.sizeX, true);
  view.setUint32(5, world.sizeY, true);
  view.setUint32(9, world.sizeZ, true);

  let off = HEADER_BYTES;
  for (let r = 0; r < counts.length; r++) {
    view.setUint32(off, counts[r], true);
    out[off + 4] = values[r];
    off += RUN_BYTES;
  }
  return out;
}

/** Decode the binary save format back into a world. Throws `RangeError` on any
 *  malformed input rather than silently producing a corrupt world: an unknown
 *  version, a truncated header (the DataView reads throw), invalid dimensions (the
 *  World constructor throws), or runs that do not cover exactly the world volume.
 *
 *  Only two explicit checks are needed — version and total coverage — because the
 *  rest is backstopped: DataView bounds-checks every multi-byte read, and
 *  `Uint8Array.fill` clamps a run that would overrun the data, so an over-long run
 *  is caught by the same coverage check as a too-short one. */
export function decodeWorld(bytes: Uint8Array): World {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = bytes[0];
  if (version !== FORMAT_VERSION) {
    throw new RangeError(`unsupported save format version ${version} (expected ${FORMAT_VERSION})`);
  }
  const sizeX = view.getUint32(1, true); // throws if the header is truncated
  const sizeY = view.getUint32(5, true);
  const sizeZ = view.getUint32(9, true);
  const world = new World(sizeX, sizeY, sizeZ); // validates the dimensions
  const volume = world.volume;

  let off = HEADER_BYTES;
  let written = 0;
  while (off + RUN_BYTES <= bytes.length) {
    const count = view.getUint32(off, true);
    world.data.fill(bytes[off + 4], written, written + count); // fill clamps past the end
    written += count;
    off += RUN_BYTES;
  }
  if (written !== volume) {
    throw new RangeError(`RLE runs cover ${written} of ${volume} cells (need exactly the volume)`);
  }
  return world;
}

/** Serialize a world to a base64 string suitable for localStorage. */
export function serializeWorld(world: World): string {
  return bytesToBase64(encodeWorld(world));
}

/** Inverse of {@link serializeWorld}. Throws `RangeError` on malformed input. */
export function deserializeWorld(text: string): World {
  return decodeWorld(base64ToBytes(text));
}

// --- base64 (WHATWG btoa/atob via a Latin-1 byte string) ----------------------

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const CHUNK = 0x8000; // keep String.fromCharCode's argument count well under the limit
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

function base64ToBytes(text: string): Uint8Array {
  const binary = atob(text);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}
