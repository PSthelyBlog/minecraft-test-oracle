import { describe, test, expect } from "vitest";
import fc from "fast-check";
import { World } from "./world";
import {
  encodeWorld,
  decodeWorld,
  serializeWorld,
  deserializeWorld,
  FORMAT_VERSION,
} from "./persistence";

const HEADER_BYTES = 13;
const RUN_BYTES = 5;

/** A random *edited* world: arbitrary small dims and arbitrary raw bytes in every
 *  cell (full 0..255, not just valid block ids — the format must reproduce any byte). */
const worldArb = fc
  .record({
    sx: fc.integer({ min: 1, max: 6 }),
    sy: fc.integer({ min: 1, max: 6 }),
    sz: fc.integer({ min: 1, max: 6 }),
  })
  .chain(({ sx, sy, sz }) =>
    fc.uint8Array({ minLength: sx * sy * sz, maxLength: sx * sy * sz }).map((data) => {
      const w = new World(sx, sy, sz);
      w.data.set(data);
      return w;
    }),
  );

describe("persistence oracle", () => {
  // ROUND-TRIP CENSUS (headline): decode∘encode is the identity on dims AND every
  // cell, for arbitrary edited worlds. A swapped stride, an off-by-one run, a lost
  // header field, or a base64 slip all make some cell or dimension disagree.
  test("round-trip: deserialize(serialize(w)) reproduces dims and every cell", () => {
    fc.assert(
      fc.property(worldArb, (w) => {
        const r = deserializeWorld(serializeWorld(w));
        expect([r.sizeX, r.sizeY, r.sizeZ]).toEqual([w.sizeX, w.sizeY, w.sizeZ]);
        expect(Array.from(r.data)).toEqual(Array.from(w.data));
      }),
      { numRuns: 300 },
    );
  });

  // The binary layer alone must also round-trip (isolates the RLE from base64).
  test("round-trip: decode(encode(w)) reproduces the world (binary layer)", () => {
    fc.assert(
      fc.property(worldArb, (w) => {
        const r = decodeWorld(encodeWorld(w));
        expect([r.sizeX, r.sizeY, r.sizeZ]).toEqual([w.sizeX, w.sizeY, w.sizeZ]);
        expect(Array.from(r.data)).toEqual(Array.from(w.data));
      }),
      { numRuns: 200 },
    );
  });

  // STRUCTURAL INVARIANT: parse the encoded bytes INDEPENDENTLY of decodeWorld and
  // assert the format contract — version, dims, every run non-empty, runs cover
  // exactly the volume, and the byte length matches the run count exactly.
  test("invariant: header is well-formed and runs cover exactly the volume", () => {
    fc.assert(
      fc.property(worldArb, (w) => {
        const bytes = encodeWorld(w);
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        expect(bytes[0]).toBe(FORMAT_VERSION);
        expect(view.getUint32(1, true)).toBe(w.sizeX);
        expect(view.getUint32(5, true)).toBe(w.sizeY);
        expect(view.getUint32(9, true)).toBe(w.sizeZ);

        let off = HEADER_BYTES;
        let sum = 0;
        let runs = 0;
        while (off + RUN_BYTES <= bytes.length) {
          const count = view.getUint32(off, true);
          expect(count).toBeGreaterThanOrEqual(1); // no empty runs
          sum += count;
          runs++;
          off += RUN_BYTES;
        }
        expect(sum).toBe(w.volume); // exact coverage
        expect(bytes.length).toBe(HEADER_BYTES + runs * RUN_BYTES); // no trailing slack
      }),
      { numRuns: 200 },
    );
  });

  // ADJACENT RUNS NEVER SHARE A VALUE — i.e. the RLE is maximal (it actually
  // coalesces). A mutant that emitted a new run per cell would round-trip fine but
  // fail this, so the compression itself is pinned, not just correctness.
  test("invariant: consecutive runs always differ in value (maximal RLE)", () => {
    fc.assert(
      fc.property(worldArb, (w) => {
        const bytes = encodeWorld(w);
        let prev = -1;
        for (let off = HEADER_BYTES; off + RUN_BYTES <= bytes.length; off += RUN_BYTES) {
          const value = bytes[off + 4];
          expect(value).not.toBe(prev);
          prev = value;
        }
      }),
      { numRuns: 200 },
    );
  });

  // METAMORPHIC: a uniform world collapses to a SINGLE run regardless of volume…
  test("metamorphic: a uniform world encodes to exactly one run", () => {
    const w = new World(4, 5, 6);
    w.data.fill(7);
    const bytes = encodeWorld(w);
    expect(bytes.length).toBe(HEADER_BYTES + RUN_BYTES); // one run only
    const view = new DataView(bytes.buffer);
    expect(view.getUint32(HEADER_BYTES, true)).toBe(w.volume); // …spanning the whole volume
    expect(bytes[HEADER_BYTES + 4]).toBe(7);
  });

  // …and a fully-alternating world is the worst case: one run per cell.
  test("metamorphic: an alternating world encodes to one run per cell", () => {
    const w = new World(8, 1, 1);
    w.data.set([0, 1, 0, 1, 0, 1, 0, 1]);
    expect(encodeWorld(w).length).toBe(HEADER_BYTES + w.volume * RUN_BYTES);
  });

  // GOLDEN: freeze the exact base64 of a known world so the byte layout cannot drift
  // silently. 2×2×2 with cells 1,1,2,2,3,3,3,3 → runs (2:1),(2:2),(4:3).
  test("golden: a known world serializes to a frozen string", () => {
    const w = new World(2, 2, 2);
    w.data.set([1, 1, 2, 2, 3, 3, 3, 3]);
    expect(serializeWorld(w)).toBe("AQIAAAACAAAAAgAAAAIAAAABAgAAAAIEAAAAAw==");
  });

  // ERROR GUARDS: malformed input must throw, not silently yield a corrupt world.
  // Each guard is exercised separately so a deleted check is a surviving mutant.
  test("decode rejects a truncated header", () => {
    // valid version byte, but the header is cut short → the DataView read throws.
    expect(() => decodeWorld(new Uint8Array([FORMAT_VERSION, 1, 2, 3]))).toThrow(RangeError);
  });

  test("decode rejects an unknown format version", () => {
    const bytes = encodeWorld(makeWorld(2, 2, 2));
    bytes[0] = FORMAT_VERSION + 1;
    expect(() => decodeWorld(bytes)).toThrow(RangeError);
  });

  test("decode rejects runs that overflow the volume", () => {
    const w = makeWorld(2, 1, 1); // volume 2
    const bytes = encodeWorld(w);
    // bump the (single) run's count from 2 to 5 → overflows
    new DataView(bytes.buffer).setUint32(HEADER_BYTES, 5, true);
    expect(() => decodeWorld(bytes)).toThrow(RangeError);
  });

  test("decode rejects runs that under-cover the volume", () => {
    const w = makeWorld(4, 1, 1); // volume 4
    w.data.set([1, 1, 1, 1]);
    const bytes = encodeWorld(w);
    new DataView(bytes.buffer).setUint32(HEADER_BYTES, 3, true); // covers 3 of 4
    expect(() => decodeWorld(bytes)).toThrow(RangeError);
  });

  // Determinism: serialization is a pure function of the world.
  test("serialization is deterministic", () => {
    const w = makeWorld(3, 3, 3);
    w.data.forEach((_, i) => (w.data[i] = (i * 7) % 5));
    expect(serializeWorld(w)).toBe(serializeWorld(w));
  });
});

function makeWorld(sx: number, sy: number, sz: number): World {
  return new World(sx, sy, sz);
}
