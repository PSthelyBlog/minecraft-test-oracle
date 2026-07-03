import { describe, test, expect } from "vitest";
import fc from "fast-check";
import { World } from "./world";
import { Block } from "./blocks";
import { computeWater } from "./water";
import { computeLava } from "./lava";
import { react, reactFully } from "./reaction";

/**
 * The water↔lava reaction: a lava cell that is water-touched turns to rock —
 * `Block.Lava` sources to Obsidian, the flowing tongue to Stone — and nothing else
 * changes (water is never consumed). These oracles re-derive the converted set
 * INDEPENDENTLY of reaction.ts: a water-DILATION census (mark every flooded cell and
 * its neighbours, then apply the rule table — a different mechanism from the per-cell
 * neighbour probe in the source), a quiescence check on `reactFully`, a
 * fluids-only-shrink monotonicity metamorphic, water-conservation, and goldens — so
 * rock from nowhere, a consumed water source, a swapped product, a missed contact, or
 * a reaction through a sealing wall all disagree with at least one oracle.
 */

const SIZE = 5;
const randomCells = fc.array(
  fc.constantFrom(
    Block.Air,
    Block.Air, // bias toward open space so both fluids flow and meet
    Block.Stone, // walls that seal the fluids apart
    Block.Water,
    Block.Lava,
  ),
  { minLength: SIZE ** 3, maxLength: SIZE ** 3 },
);
const fill = (cells: number[]): World => {
  const w = new World(SIZE, SIZE, SIZE);
  cells.forEach((b, i) => (w.data[i] = b));
  return w;
};

/**
 * INDEPENDENT re-derivation of one reaction pass, by water DILATION: first expand the
 * water field one step outward into a touched-mask (each flooded cell marks itself and
 * its six neighbours), then apply the rule table per cell. Shares no traversal
 * structure with reaction.ts's per-cell neighbour probe.
 */
function expectedReact(w: World, water: Uint8Array, lava: Uint8Array): Uint8Array {
  const touched = new Uint8Array(w.volume);
  for (let y = 0; y < w.sizeY; y++)
    for (let z = 0; z < w.sizeZ; z++)
      for (let x = 0; x < w.sizeX; x++) {
        if (water[w.index(x, y, z)] !== 1) continue;
        touched[w.index(x, y, z)] = 1;
        for (const [dx, dy, dz] of [
          [1, 0, 0],
          [-1, 0, 0],
          [0, 1, 0],
          [0, -1, 0],
          [0, 0, 1],
          [0, 0, -1],
        ]) {
          if (w.inBounds(x + dx, y + dy, z + dz)) touched[w.index(x + dx, y + dy, z + dz)] = 1;
        }
      }
  const out = new Uint8Array(w.data);
  for (let i = 0; i < w.volume; i++) {
    if (lava[i] !== 1 || touched[i] !== 1) continue; // reacts only where lava meets water
    if (out[i] === Block.Water) continue; // water dominates, never consumed
    out[i] = out[i] === Block.Lava ? Block.Obsidian : Block.Stone;
  }
  return out;
}

describe("reaction oracle", () => {
  // REACTION CENSUS (headline): one pass equals the independent dilation-derived
  // expectation, byte for byte — the converted set, both products, AND that every
  // untouched cell is unchanged (no rock from nowhere), over random worlds.
  test("census: one pass equals the independent water-dilation re-derivation", () => {
    fc.assert(
      fc.property(randomCells, (cells) => {
        const w = fill(cells);
        const water = computeWater(w);
        const lava = computeLava(w);
        const out = react(w, water, lava);
        expect(Array.from(out.data)).toEqual(Array.from(expectedReact(w, water, lava)));
        expect(Array.from(w.data)).toEqual(cells); // pure: the input world is not mutated
      }),
      { numRuns: 300 },
    );
  });

  // CONSERVATION: water sources survive every reaction, exactly where they were —
  // water quenches, it is not consumed. (The census implies this; pinned explicitly
  // because a consumed source is the costliest silent failure here.)
  test("conservation: every Block.Water cell survives reactFully in place", () => {
    fc.assert(
      fc.property(randomCells, (cells) => {
        const w = fill(cells);
        const out = reactFully(w);
        for (let i = 0; i < w.volume; i++)
          if (w.data[i] === Block.Water) expect(out.data[i]).toBe(Block.Water);
      }),
      { numRuns: 300 },
    );
  });

  // QUIESCENCE: reactFully's output is a true fixpoint — on recomputed fields, no
  // lava cell is water-touched any more (except protected Water sources), and one
  // more pass changes nothing. Rock formed mid-way can reroute the floods, so this
  // pins the iteration, not just one pass.
  test("quiescence: after reactFully no lava cell is water-touched", () => {
    fc.assert(
      fc.property(randomCells, (cells) => {
        const w = reactFully(fill(cells));
        const water = computeWater(w);
        const lava = computeLava(w);
        const again = react(w, water, lava);
        expect(Array.from(again.data)).toEqual(Array.from(w.data)); // one more pass: no-op
        // and re-derived from the rule: every remaining contact is a protected Water cell
        const expected = expectedReact(w, water, lava);
        expect(Array.from(expected)).toEqual(Array.from(w.data));
      }),
      { numRuns: 200 },
    );
  });

  // MONOTONICITY metamorphic: the reaction only ever REMOVES fluid reach — every
  // converted cell is solid rock that dams both floods, so the recomputed fields on
  // the output are cell-wise subsets of the inputs. Rock that ADDED water or lava
  // anywhere would mean the reaction created a fluid path.
  test("metamorphic: reacting never extends either fluid's reach", () => {
    fc.assert(
      fc.property(randomCells, (cells) => {
        const w = fill(cells);
        const water = computeWater(w);
        const lava = computeLava(w);
        const out = react(w, water, lava);
        const waterAfter = computeWater(out);
        const lavaAfter = computeLava(out);
        for (let i = 0; i < w.volume; i++) {
          expect(waterAfter[i]).toBeLessThanOrEqual(water[i]);
          expect(lavaAfter[i]).toBeLessThanOrEqual(lava[i]);
        }
      }),
      { numRuns: 200 },
    );
  });

  // CONTRACT (synthetic fields): `react` takes the fields as given — and the rule says a
  // cell is water-touched if it is ITSELF flooded, with no neighbour required. Pinned
  // with hand-built fields where a single isolated cell holds both fluids: only the
  // inflow-witness property of computeWater makes the self-check redundant in practice,
  // and react must not silently rely on it.
  test("contract: a cell that is itself both flooded and molten reacts (no neighbour needed)", () => {
    const w = new World(3, 3, 3); // all Air; both fields hand-built
    const water = new Uint8Array(w.volume);
    const lava = new Uint8Array(w.volume);
    water[w.index(1, 1, 1)] = 1; // the SAME lone cell holds water…
    lava[w.index(1, 1, 1)] = 1; // …and lava — no flooded neighbours anywhere
    const out = react(w, water, lava);
    expect(out.get(1, 1, 1)).toBe(Block.Stone); // flooded non-source → Stone
    for (let i = 0; i < w.volume; i++)
      if (i !== w.index(1, 1, 1)) expect(out.data[i]).toBe(Block.Air); // nothing else formed
  });

  // GOLDEN (the headline scene): a waterfall pours onto a lava pool. The pool's
  // SOURCE blocks quench to Obsidian, its flowing tongue crusts to Stone, the water
  // source keeps pouring, and the world reaches quiescence.
  test("golden: a waterfall onto a lava pool — obsidian sources, stone crust", () => {
    const N = 9;
    const w = new World(N, 5, N);
    for (let z = 0; z < N; z++) for (let x = 0; x < N; x++) w.set(x, 0, z, Block.Stone); // floor
    w.set(3, 1, 4, Block.Lava); // a two-source lava pool on the floor…
    w.set(4, 1, 4, Block.Lava);
    w.set(4, 3, 4, Block.Water); // …and a water source pouring from above
    const out = reactFully(w);

    expect(out.get(3, 1, 4)).toBe(Block.Obsidian); // the sources quench to obsidian
    expect(out.get(4, 1, 4)).toBe(Block.Obsidian);
    expect(out.get(4, 3, 4)).toBe(Block.Water); // the water source is not consumed
    // The tongue that had flooded the open floor around the pool crusts to stone.
    expect(out.get(6, 1, 4)).toBe(Block.Stone); // was Air, lava-flooded, water-touched
    expect(out.get(4, 1, 6)).toBe(Block.Stone);
    // Beyond the tongue's reach the floor level stays open air.
    expect(out.get(8, 1, 8)).toBe(Block.Air);
    // Quiescent: nothing molten is left in contact with water anywhere.
    const water = computeWater(out);
    const lava = computeLava(out);
    expect(Array.from(react(out, water, lava).data)).toEqual(Array.from(out.data));
  });

  // GOLDEN (sealing): a stone wall between a water chamber and a lava chamber —
  // no contact, no reaction, the world is byte-identical. Rock must not form
  // through a wall.
  test("golden: a sealing wall between the fluids reacts nothing", () => {
    const w = new World(5, 3, 3);
    for (let z = 0; z < 3; z++)
      for (let y = 0; y < 3; y++) {
        w.set(0, y, z, Block.Stone); // water chamber wall
        w.set(2, y, z, Block.Stone); // the seal
        w.set(4, y, z, Block.Stone); // lava chamber wall
      }
    for (let z = 0; z < 3; z++) for (let x = 0; x < 5; x++) w.set(x, 0, z, Block.Stone); // floor
    w.set(1, 1, 1, Block.Water); // water on one side of the seal
    w.set(3, 1, 1, Block.Lava); // lava on the other
    const out = reactFully(w);
    expect(Array.from(out.data)).toEqual(Array.from(w.data));
  });

  // DETERMINISM + idempotence: reactFully twice is byte-identical, and re-running
  // reactFully on its own output changes nothing.
  test("determinism: reactFully is stable and idempotent", () => {
    fc.assert(
      fc.property(randomCells, (cells) => {
        const a = reactFully(fill(cells));
        const b = reactFully(fill(cells));
        expect(Array.from(a.data)).toEqual(Array.from(b.data));
        expect(Array.from(reactFully(a).data)).toEqual(Array.from(a.data));
      }),
      { numRuns: 150 },
    );
  });
});
