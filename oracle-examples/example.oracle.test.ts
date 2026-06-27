import { describe, test, expect } from "vitest";
import fc from "fast-check";

// EXAMPLE — replace with imports from your own modules. A tiny RLE codec stands in
// so this file passes out of the box and shows the three core oracle shapes.
function encode(bytes) {
  const out = [];
  for (let i = 0; i < bytes.length;) {
    let j = i + 1;
    while (j < bytes.length && bytes[j] === bytes[i]) j++;
    out.push(j - i, bytes[i]);
    i = j;
  }
  return out;
}
function decode(runs) {
  const out = [];
  for (let i = 0; i < runs.length; i += 2) {
    for (let k = 0; k < runs[i]; k++) out.push(runs[i + 1]);
  }
  return out;
}

const arbBytes = fc.array(fc.integer({ min: 0, max: 255 }), { maxLength: 256 });

describe("oracle shapes (example — replace with your modules)", () => {
  // 1) ROUND-TRIP (inverse): the strongest single property for any codec.
  test("round-trip: decode(encode(x)) === x for all inputs", () => {
    fc.assert(
      fc.property(arbBytes, (x) => {
        expect(decode(encode(x))).toEqual(x); // exact: discrete domain
      }),
      { numRuns: 500 },
    );
  });

  // 2) METAMORPHIC: a constant block of length n must decode to length n.
  test("metamorphic: a constant block decodes to its length", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 100 }), fc.integer({ min: 0, max: 255 }), (n, v) => {
        expect(decode(encode(Array(n).fill(v)))).toHaveLength(n);
      }),
    );
  });

  // 3) GOLDEN: deterministic output frozen once. Drift becomes loud.
  test("golden: a fixed input encodes to a stable form", () => {
    expect(encode([7, 7, 7, 1, 1])).toEqual([3, 7, 2, 1]);
  });
});
