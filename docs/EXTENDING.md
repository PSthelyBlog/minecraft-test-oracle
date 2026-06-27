# Extending the Game

Practical recipes for changing the base implementation. The golden rule: **put logic in the
pure core and add an oracle for it**; keep `main.ts` as thin wiring. After any core change,
run `npm test` then `npm run mutation`.

## Add a new block type

1. **Register it** in `src/core/blocks.ts`:
   ```ts
   export const Block = { /* ...existing... */ Water: 13, Snow: 14 } as const;

   export const BLOCKS = {
     // ...existing...
     [Block.Snow]: { id: Block.Snow, name: "Snow", solid: true, opaque: true, color: rgb(245, 245, 250) },
   };
   ```
   Keep ids **contiguous from 0** (the world is a `Uint8Array`).
2. **Make it placeable** by adding it to `HOTBAR` (omit if it should be terrain-only).
3. **Update the oracles** in `src/core/blocks.test.ts`:
   - add the block to the `FACETS` census table (`{ name, solid, opaque }`), and
   - the colour golden hash will change — run the test, copy the new `Received` hash into the
     `expect(...).toBe(...)`. (Re-pinning a golden after an intentional change is the normal
     workflow.)
4. `npm test`. The facet census will fail until step 3 is done — that's the oracle doing its
   job.

**Facet meaning:** `solid` → the player collides with it; `opaque` → it hides the touching
face of neighbours (set `false` for anything see-through like glass/leaves/water).

## Use it in terrain

Edit the column layering in `generateTerrain` (`src/core/terrain.ts`) — e.g. snow caps above
a height:

```ts
} else if (y === height) {
  block = height > sizeY * 0.8 ? Block.Snow : (height <= sea + 1 ? Block.Sand : Block.Grass);
}
```

This changes deterministic output, so **re-pin the golden world hash** in
`terrain.test.ts` (run it, copy the new hash). The structural-layering property test may also
need its `expect([...]).toContain(surface)` set updated to include `Snow`.

## Change the world size

In `src/main.ts`:

```ts
const SIZE_X = 128, SIZE_Y = 48, SIZE_Z = 128;
```

No core change is needed — `World`, the mesher, and physics are size-agnostic. But note the
**mesh rebuild cost** (see below) grows with the world; past ~`128³` you'll want chunking.

## Retune movement / physics

All player feel lives in one object in `main.ts`:

```ts
const TUNING = { walk: 5.2, fly: 11, gravity: -28, jump: 9, half: HALF };
```

Because `stepMovement` is pure, you can also write a test that asserts, say, "jump apex
clears 1.2 blocks" by stepping it in a loop — see `src/game/movement.test.ts` for the
pattern. `HALF` (`[0.3, 0.9, 0.3]`) is the player's collision box half-extents; widen `EYE`
if you change the height.

## Add a different terrain shape

`generateTerrain` is a pure function of `(seed, size, seaLevel)`. To change the landscape,
edit `heightAt` (octaves, amplitude, base) or `valueNoise`/`hash2` in `terrain.ts`. Keep it
**deterministic** (no `Math.random`, no `Date.now`) so the golden test stays meaningful — the
whole point is that the same seed always yields the same world. After tuning, re-pin the
golden hash.

## Swap flat colours for textures

Today blocks render with per-vertex colour (`MeshLambertMaterial { vertexColors: true }`).
For textures you'd:

1. add per-face UVs in `mesher.ts` (a `uvs: Float32Array` on `ChunkMesh`),
2. upload them in `chunkGeometry.ts` (`geo.setAttribute("uv", ...)`),
3. switch the material to a texture atlas in `main.ts`.

Add an oracle in `chunkGeometry.test.ts` asserting the UV count matches `faceCount * 4 * 2`,
and a mesher oracle pinning a known face's UVs.

## Performance and chunking

The world is meshed as a grid of fixed **chunks** (`CHUNK_SIZE = 16`, so the default
`80×32×80` world is `5×2×5` chunks), each its own `BufferGeometry`, so a block edit
rebuilds only the chunk(s) it touches instead of the whole world.

The pieces (all in `src/core/mesher.ts` so they stay oracle-tested, with the Three.js
wiring in `src/render/chunkedTerrain.ts`):

- `buildChunkMesh(world, cx, cy, cz, chunkSize?)` meshes one chunk's cells but **reads
  neighbours across chunk borders** (via `world.get`, Air out of bounds), so seams are
  face-culled correctly. `buildMesh` is just the whole-world case of the same code path.
- `chunkDims(world, chunkSize?)` is the chunk count per axis; `chunksAffectedByEdit(world,
  x, y, z, chunkSize?)` returns the chunk of the edited cell plus any neighbour chunk across
  a border — exactly the set the renderer rebuilds.
- `ChunkedTerrain` (render shell) holds a `Mesh` per non-empty chunk in a `Group` and
  exposes `rebuildAround(x, y, z)`.

The oracles that pin it (`src/core/mesher.test.ts`, `src/render/chunkedTerrain.test.ts`):

- **Census** — Σ per-chunk `faceCount` == whole-world `buildMesh().faceCount`, for any world
  and chunk size, plus a golden seam case (a block pair straddling a border still culls →
  10, not 12).
- **Seam multiset** — the *set* of faces across chunks equals the whole-world set exactly
  (catches a border face dropped in one chunk and re-emitted in another).
- **Edit-impact differential** — every chunk whose mesh actually changes after an edit is in
  `chunksAffectedByEdit` (so the renderer never leaves a stale seam).
- **Incremental == full** — `ChunkedTerrain` after a batch of `rebuildAround` edits equals a
  from-scratch whole-world mesh.

To change the chunk size, edit `CHUNK_SIZE`. (`chunksAffectedByEdit`'s symmetric ± offset
list makes its `coord ± delta` sign mutants equivalent — see docs/TESTING.md.)

## Things to keep invariant

- **Coordinate convention** (`index = x + sizeX*(z + sizeZ*y)`) — if you ever change it,
  change it only in `world.ts`; the bijection oracle will catch inconsistencies.
- **Camera/ray agreement** — the crosshair ray uses `directionFromYawPitch`; the camera uses
  `rotation.set(pitch, yaw, 0, "YXZ")`. These must stay in sync or picking won't match the
  view. (They're derived to be identical; don't change one without the other.)
- **Determinism of terrain** — never introduce nondeterminism into the core, or the golden
  oracles become meaningless.
