# Architecture

This document describes how the Minecraft Classic clone is structured, the data that
flows through it each frame, and the conventions every module agrees on.

## Design principle: pure core, thin shell

The codebase is split into two halves with a hard boundary between them:

| Layer         | Location                    | Depends on                    | Tested by                       |
| ------------- | --------------------------- | ----------------------------- | ------------------------------- |
| **Pure core** | `src/core`, `src/game`      | nothing (no DOM, no Three.js) | unit oracles + mutation testing |
| **Shell**     | `src/render`, `src/main.ts` | Three.js, DOM, WebGL          | headless smoke test             |

Every piece of logic that can fail _silently_ — coordinate math, ray picking, meshing,
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
  `buildGreedyMesh` / `buildGreedyChunkMesh` additionally **merge** coplanar same-tile,
  uniformly-lit faces into bigger quads (what the renderer draws); `buildMesh` is the
  independent oracle reference the greedy area-conservation census checks against. The optional
  `light` field dims each face by `faceShade × AO × lightFactor(light)` at the open cell it looks
  into (omitted ⇒ factor 1, a strict extension); light joins the greedy merge key, so faces at
  different light levels don't merge.
- **`terrain.ts`** — deterministic seeded terrain (`generateTerrain`), value-noise
  heightmap, vertical layering, and hash-placed Log/Leaves trees on grass.
- **`persistence.ts`** — save/load: run-length encodes a `World` to a compact binary blob
  (`encodeWorld`/`decodeWorld`) and base64 string (`serializeWorld`/`deserializeWorld`) for
  localStorage. `decode∘encode` is an exact round-trip, pinned by the census oracle.
- **`physics.ts`** — AABB-vs-voxel collision: `boxIntersectsSolid` (overlap test),
  `moveAndCollide` (per-axis swept resolution), and `submersion` (fraction of the player box in
  water, for buoyancy/drag).
- **`atlas.ts`** — tile selection: `tileIndexFor(block, face)` (per-face tile = texture-array
  layer choice). Pure mapping, no Three.js, no grid math.
- **`light.ts`** — `computeBlockLight(world)` and `computeSkyLight(world)`: one shared BFS
  flood-fill (`floodLight`), attenuating 1 per step through non-opaque cells (opaque blocks cast
  shadow). Block-light seeds from emissive blocks (`emission > 0`); skylight seeds every cell open
  to the sky at full brightness, so a vertical drop through open air never attenuates. Both are a
  max-fixpoint, so order-independent; each checked against an independent relaxation.
  `computeLight` combines them (cell-wise `max`); `computeBlockLightRGB` / `computeLightRGB`
  generalise block/combined light to **3 colour channels** (emitters carry an `emissionColor` tint,
  flooded per channel; skylight is white) — a strict extension (a white emitter reduces to the
  scalar field). The renderer dims faces by the RGB field. Pinned per channel by an independent
  relaxation, the red-channel reduction to scalar, and a closed-form decay golden. (`ChunkedTerrain`
  recomputes the RGB field per edit and diffs it for the changed cells — ~6 ms, see #86 on why
  incremental wasn't kept.)
- **`water.ts`** — `computeWater(world)`: water flow as a deterministic flood fill (the Minecraft
  Classic model; a derived 0/1 field, not stored blocks). `Block.Water` cells are sources; water
  floods into non-solid cells sideways and downward, never up or into solids — so it fills reachable
  gaps and lies flat, the least fixpoint of that rule. Oracle-tested core (independent reachability
  relaxation / fixpoint / inflow-witness invariant / damming / goldens).
- **`waterMesh.ts`** — `buildWaterMesh` / `buildWaterChunkMesh`: the translucent water pass. A
  watered cell emits a cube; a face shows only where it meets open air (water-vs-water and
  buried faces culled), shaded `faceShade × lightFactor`. `ChunkedTerrain` draws it in a separate
  `waterGroup` with an alpha-blended material; the opaque terrain mesher skips `Block.Water`
  (`rendersInTerrain`). Pinned by a where/shade/winding census suite (100% mutation score).
- **`medium.ts`** — `mediumAt(world, water, x,y,z)` / `mediumAtPoint(world, water, point)`: the
  medium an **observer** is immersed in (`Air`/`Water`/`Solid`), as distinct from the block in a
  cell — a total, disjoint 3-way partition (flooded → `Water`, else solid → `Solid`, else `Air`;
  OOB → `Air`). A `MEDIA` registry (like `blocks.ts`) carries each medium's fog colour/near/far and
  a light multiplier; `Air` reproduces today's `Fog(SKY, 40, 110)` exactly, so above water is a
  strict no-op. The shell reads `mediumAtPoint(…, eye)` per frame to swap `scene.fog`/`background`.
  Pinned by a partition census, a disjointness invariant, and a differential against
  `physics.submersion` (100% mutation score).
- **`selfcheck.ts`** — `selfCheck()` re-derives the cheapest invariants at boot and throws
  if any is broken.

### `src/game`

- **`movement.ts`** — `stepMovement`, the pure per-frame player update: input → velocity
  (gravity, jump-gating, fly, run/walk speed tier, diagonal normalization, and swim
  buoyancy/drag/stroke from `submersion`) → delegates collision to `moveAndCollide` → returns the
  next `PlayerState`. Also `resolveCrouch`: the feet-anchored crouch posture (shrink the AABB from
  the top; refuse to stand into a ceiling), resolved before the movement step.

### `src/render` and `src/main.ts`

- **`render/chunkGeometry.ts`** — uploads a `ChunkMesh`'s typed arrays into a Three.js
  `BufferGeometry`. The only file that touches both the core and Three.js geometry.
- **`render/chunkedTerrain.ts`** — a `Group` of per-chunk meshes with `rebuildAround(x,y,z)`;
  thin wiring over the core's `buildChunkMesh` / `chunksAffectedByEdit`.
- **`render/atlasTexture.ts`** — generates the block tiles as a procedural `DataArrayTexture`
  (one layer per tile) from `core/atlas`'s `TILE_COLOR` (deterministic grain + bevel,
  `NearestFilter`, `RepeatWrapping`).
- **`render/terrainMaterial.ts`** — the terrain `MeshLambertMaterial`, with its texture fetch
  redirected (via `onBeforeCompile`) to the tile array, indexed by the per-vertex `layer`.
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
   `stepMovement(world, terrain.waterField, player, input, dt, TUNING)`, and reassigns `player`. Respawns if
   the player falls below `y = −5`.
3. **`updateCamera()`** — positions the camera at the eye (player centre + `EYE = 0.72`) and
   sets its rotation from `yaw`/`pitch`.
4. **`updateAtmosphere()`** — classifies the eye's medium
   (`medium.mediumAtPoint(world, terrain.waterField, eye)`) and applies its `MediumDef` to the
   shared fog/background `Color` and the light intensities. Above water this resolves to `Air`
   (today's `Fog(SKY, 40, 110)`, no dimming — a no-op); underwater to a blue, close, dimmed fog.
5. **`updateHighlight()`** — casts a ray (`directionFromYawPitch` → `raycast`, reach 6) and
   moves the wireframe selection cube onto the hit block (hidden if no hit).
6. **`renderer.render(scene, camera)`**.
7. Updates the HUD (xyz, fps, ground/air/flying state, held block).

Mouse movement updates `yaw`/`pitch` (in the `mousemove` listener, only while pointer is
locked). Clicks call break/place.

## Rendering pipeline

```
World (Uint8Array)
  └─ buildGreedyChunkMesh(cx,cy,cz)  per-chunk culling + greedy merge → ChunkMesh { positions, normals, colors, uvs, layers, indices, faceCount }
       └─ geometryFromMesh()        typed arrays → THREE.BufferGeometry (position/normal/color/uv/layer)
            └─ ChunkedTerrain.group  one Mesh per non-empty chunk
                 └─ terrainMaterial   MeshLambertMaterial sampling a tile ARRAY by per-vertex `layer`
```

- The world is meshed as a grid of fixed **chunks** (`CHUNK_SIZE = 16`). The mesher culls each
  chunk against the **full** world, so seams are correct; the chunks reassemble into the exact
  whole-world surface (`buildMesh` is the whole-world case of the same culling code).
- **Greedy meshing:** the renderer uses `buildGreedyChunkMesh`, which merges coplanar, adjacent
  faces sharing a tile and uniform AO into bigger quads (≈55% fewer quads on the default
  terrain), with the tile **repeating** once per cell. Coverage is identical to the naive
  mesher — the area-conservation census proves every visible unit face is still emitted exactly
  once — so the naive `buildMesh` stays as the independent oracle reference.
- Blocks are **textured** from a procedural tile **array** (`DataArrayTexture`, one layer per
  tile): the mesher emits tile-local `uvs` plus a per-vertex `layer` = the tile chosen by
  `core/atlas.tileIndexFor` (grass top/side/bottom, log end-grain), `render/atlasTexture`
  paints the layers, and `render/terrainMaterial` redirects Lambert's texture fetch to sample
  `texture(array, vec3(uv, layer))` (an array, not a 4×4 atlas grid, so a greedy quad's UV > 1
  repeats its tile cleanly). The per-vertex `colors` carry a greyscale
  `shade` = the per-face directional shade (top `1.0` … bottom `0.5`) **× per-vertex ambient
  occlusion** (corners/crevices darken; `vertexAO`), so the look is `texel × shade ×
lighting` — the flat-shaded Classic style, now textured and contact-shaded.
- Lighting is a `HemisphereLight` + a soft `DirectionalLight`; a `Fog` fades the far edge of
  the world. Fog colour/range and the light intensities are set **per frame from the medium the
  eye is in** (`core/medium`) — the sky fog above water, a blue/close/dimmed fog underwater.

### Mesh rebuilds on edit

Breaking or placing a block mutates the `World` and calls `terrain.rebuildAround(x, y, z)`,
which remeshes only the chunks `chunksAffectedByEdit` reports — the edited cell's chunk plus
any neighbour chunk across a border — instead of the whole world. The old per-chunk geometry
is disposed and replaced. See [EXTENDING.md](./EXTENDING.md#performance-and-chunking) for the
full breakdown and the oracles that pin the seams.

## Key constants (in `main.ts`)

| Constant                 | Value             | Meaning                                            |
| ------------------------ | ----------------- | -------------------------------------------------- |
| `SIZE_X, SIZE_Y, SIZE_Z` | `80, 32, 80`      | world dimensions (cells)                           |
| `SEED`                   | `20090513`        | terrain seed (Classic's first public release date) |
| `HALF`                   | `[0.3, 0.9, 0.3]` | player AABB half-extents (0.6 × 1.8 × 0.6)         |
| `EYE`                    | `0.72`            | eye height above the player box centre             |
| `REACH`                  | `6`               | block interaction distance                         |
| `TUNING.walk / fly`      | `5.2 / 11`        | horizontal speed (blocks/s)                        |
| `TUNING.gravity`         | `−28`             | gravitational acceleration (blocks/s²)             |
| `TUNING.jump`            | `9`               | jump impulse (blocks/s)                            |
| `SENS`                   | `0.0022`          | mouse look sensitivity (radians/pixel)             |

## Why this split pays off

Because the core is pure, every rule of the game is expressible as a property a test can
check independently of the implementation — and `npm run mutation` can prove those checks
actually fail when the code is wrong. The architecture _is_ the testing strategy. See
[TESTING.md](./TESTING.md).
