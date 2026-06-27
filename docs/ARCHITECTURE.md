# Architecture

This document describes how the Minecraft Classic clone is structured, the data that
flows through it each frame, and the conventions every module agrees on.

## Design principle: pure core, thin shell

The codebase is split into two halves with a hard boundary between them:

| Layer | Location | Depends on | Tested by |
|-------|----------|------------|-----------|
| **Pure core** | `src/core`, `src/game` | nothing (no DOM, no Three.js) | unit oracles + mutation testing |
| **Shell** | `src/render`, `src/main.ts` | Three.js, DOM, WebGL | headless smoke test |

Every piece of logic that can fail *silently* — coordinate math, ray picking, meshing,
terrain, physics, movement — lives in the pure core. It imports nothing from the browser,
so it runs in Node under Vitest and can be mutation-tested. The shell is deliberately
dumb: it wires inputs to the core and uploads the core's output to the GPU.

```
┌───────────────────────────────────────────────────────────────┐
│ src/main.ts  (shell: DOM, input, frame loop, Three.js scene)   │
│   │                                                            │
│   ├── input  ──► game/movement.stepMovement ──► core/physics   │
│   ├── mouse  ──► core/math.directionFromYawPitch ─► core/raycast│
│   ├── edits  ──► core/world.set ──► render/chunkedTerrain       │
│   └── chunkedTerrain ──► core/mesher.buildChunkMesh ──► GPU     │
└───────────────────────────────────────────────────────────────┘
            ▲                                   ▲
            │ pure, dependency-free             │
   ┌────────┴─────────┐               ┌─────────┴──────────┐
   │ core/world       │               │ core/terrain        │
   │ core/blocks      │               │ core/mesher         │
   │ core/raycast     │               │ core/physics        │
   │ core/math        │               │ game/movement       │
   └──────────────────┘               └─────────────────────┘
```

## Module responsibilities

### `src/core`
- **`math.ts`** — `Vec3` (a `readonly [number,number,number]` tuple) and the vector ops.
  The key function is `directionFromYawPitch`, the single definition of where the camera
  looks.
- **`blocks.ts`** — the block registry. Maps each block id to `{ solid, opaque, color }`.
  `solid` drives physics; `opaque` drives face culling; `color` drives rendering.
- **`world.ts`** — the `World` class: a fixed-size `Uint8Array` of block ids plus the
  coordinate↔index mapping. **The single source of truth for the coordinate convention.**
- **`raycast.ts`** — DDA voxel traversal (`raycast`) for "what block is the player looking
  at?". Returns the hit block, the entry face normal, and the adjacent empty cell.
- **`mesher.ts`** — turns a `World` into geometry, emitting only the faces a neighbour
  doesn't hide (face culling). `buildMesh` does the whole world; `buildChunkMesh` does one
  fixed chunk (culling across borders) so edits remesh just the affected chunks.
- **`terrain.ts`** — deterministic seeded terrain (`generateTerrain`), value-noise
  heightmap, vertical layering.
- **`physics.ts`** — AABB-vs-voxel collision: `boxIntersectsSolid` (overlap test) and
  `moveAndCollide` (per-axis swept resolution).
- **`atlas.ts`** — texture-atlas layout: `tileIndexFor(block, face)` (per-face tile choice)
  and `uvRectForTile(t)` (tile → UV rect). Pure layout math, no Three.js.
- **`selfcheck.ts`** — `selfCheck()` re-derives the cheapest invariants at boot and throws
  if any is broken.

### `src/game`
- **`movement.ts`** — `stepMovement`, the pure per-frame player update: input → velocity
  (gravity, jump-gating, fly, diagonal normalization) → delegates collision to
  `moveAndCollide` → returns the next `PlayerState`.

### `src/render` and `src/main.ts`
- **`render/chunkGeometry.ts`** — uploads a `ChunkMesh`'s typed arrays into a Three.js
  `BufferGeometry`. The only file that touches both the core and Three.js geometry.
- **`render/chunkedTerrain.ts`** — a `Group` of per-chunk meshes with `rebuildAround(x,y,z)`;
  thin wiring over the core's `buildChunkMesh` / `chunksAffectedByEdit`.
- **`render/atlasTexture.ts`** — generates the block atlas as a procedural `DataTexture` from
  `core/atlas`'s `TILE_COLOR` (deterministic grain + bevel, `NearestFilter`).
- **`main.ts`** — scene/camera/lights, the start overlay + pointer lock, keyboard/mouse
  input, the hotbar + HUD, block break/place, and the `requestAnimationFrame` loop.

## Coordinate and angle conventions

These are agreed on by **every** module; getting them consistent is exactly what the
oracle suite guards.

- **Voxel storage** (`world.ts`):
  ```
  index(x, y, z) = x + sizeX * (z + sizeZ * y)
  ```
  `x` is fastest-varying, then `z`, then `y` (y-major). A world is `sizeX × sizeY × sizeZ`
  cells; `y` is up.
- **Out of bounds** reads as `Block.Air`; out-of-bounds writes are ignored (return `false`).
  This makes the edges of the world behave like open sky / open space without special-casing.
- **Camera** (`math.directionFromYawPitch`):
  - `yaw = 0` looks toward **−Z**; increasing yaw rotates toward **−X** (left).
  - `pitch > 0` looks up (**+Y**), `pitch < 0` looks down. Pitch is clamped to ±(π/2 − ε).
  - The returned direction is always unit length.
  The Three.js camera uses `rotation.order = "YXZ"` with `rotation.set(pitch, yaw, 0)`,
  which produces exactly this forward vector — so the crosshair ray and the rendered view
  always agree.
- **Face directions** (`mesher.ts`) are indexed `0=+X, 1=−X, 2=+Y, 3=−Y, 4=+Z, 5=−Z`.
  Quad corners are wound counter-clockwise as seen from **outside** the block, so faces are
  front-facing under default winding.

## Per-frame data flow

`main.ts`'s `frame(now)` runs each animation frame:

1. **`dt`** = `min((now − last)/1000, 0.05)` — clamped so a stutter can't tunnel the player
   through a wall.
2. **`updatePlayer(dt)`** — reads the held keys into a `MovementInput`, calls
   `stepMovement(world, player, input, dt, TUNING)`, and reassigns `player`. Respawns if
   the player falls below `y = −5`.
3. **`updateCamera()`** — positions the camera at the eye (player centre + `EYE = 0.72`) and
   sets its rotation from `yaw`/`pitch`.
4. **`updateHighlight()`** — casts a ray (`directionFromYawPitch` → `raycast`, reach 6) and
   moves the wireframe selection cube onto the hit block (hidden if no hit).
5. **`renderer.render(scene, camera)`**.
6. Updates the HUD (xyz, fps, ground/air/flying state, held block).

Mouse movement updates `yaw`/`pitch` (in the `mousemove` listener, only while pointer is
locked). Clicks call break/place.

## Rendering pipeline

```
World (Uint8Array)
  └─ buildChunkMesh(cx,cy,cz)   per-chunk face culling → ChunkMesh { positions, normals, colors, uvs, indices, faceCount }
       └─ geometryFromMesh()        typed arrays → THREE.BufferGeometry (position/normal/color/uv)
            └─ ChunkedTerrain.group  one Mesh per non-empty chunk
                 └─ MeshLambertMaterial { map: atlas, vertexColors: true }
```

- The world is meshed as a grid of fixed **chunks** (`CHUNK_SIZE = 16`). `buildChunkMesh`
  culls each chunk against the **full** world, so seams are correct; the chunks reassemble
  into the exact whole-world mesh (`buildMesh` is the whole-world case of the same code).
- Blocks are **textured** from a procedural atlas: the mesher emits per-face `uvs` into a
  tile chosen by `core/atlas.tileIndexFor` (grass top/side/bottom, log end-grain), and
  `render/atlasTexture` paints the `DataTexture`. The per-vertex `colors` now carry only the
  per-face ambient `shade` (top `1.0` … bottom `0.5`), so the look is `texel × shade ×
  lighting` — the flat-shaded Classic style, now textured.
- Lighting is a `HemisphereLight` + a soft `DirectionalLight`; a `Fog` matching the sky
  colour fades the far edge of the world.

### Mesh rebuilds on edit

Breaking or placing a block mutates the `World` and calls `terrain.rebuildAround(x, y, z)`,
which remeshes only the chunks `chunksAffectedByEdit` reports — the edited cell's chunk plus
any neighbour chunk across a border — instead of the whole world. The old per-chunk geometry
is disposed and replaced. See [EXTENDING.md](./EXTENDING.md#performance-and-chunking) for the
full breakdown and the oracles that pin the seams.

## Key constants (in `main.ts`)

| Constant | Value | Meaning |
|----------|-------|---------|
| `SIZE_X, SIZE_Y, SIZE_Z` | `80, 32, 80` | world dimensions (cells) |
| `SEED` | `20090513` | terrain seed (Classic's first public release date) |
| `HALF` | `[0.3, 0.9, 0.3]` | player AABB half-extents (0.6 × 1.8 × 0.6) |
| `EYE` | `0.72` | eye height above the player box centre |
| `REACH` | `6` | block interaction distance |
| `TUNING.walk / fly` | `5.2 / 11` | horizontal speed (blocks/s) |
| `TUNING.gravity` | `−28` | gravitational acceleration (blocks/s²) |
| `TUNING.jump` | `9` | jump impulse (blocks/s) |
| `SENS` | `0.0022` | mouse look sensitivity (radians/pixel) |

## Why this split pays off

Because the core is pure, every rule of the game is expressible as a property a test can
check independently of the implementation — and `npm run mutation` can prove those checks
actually fail when the code is wrong. The architecture *is* the testing strategy. See
[TESTING.md](./TESTING.md).
