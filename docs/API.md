# Core API Reference

Every symbol exported by the pure core (`src/core`) and game logic (`src/game`). All of it
is framework-free and runs in Node. Each section notes the **invariants** the paired oracle
pins (see [TESTING.md](./TESTING.md)).

---

## `core/math.ts`

```ts
type Vec3 = readonly [number, number, number];

add(a: Vec3, b: Vec3): Vec3
sub(a: Vec3, b: Vec3): Vec3
scale(a: Vec3, s: number): Vec3
dot(a: Vec3, b: Vec3): number
length(a: Vec3): number
normalize(a: Vec3): Vec3                       // zero vector → [0,0,0]
directionFromYawPitch(yaw: number, pitch: number): Vec3
```

`Vec3` is an immutable tuple — operations return new tuples, never mutate.

**`directionFromYawPitch(yaw, pitch)`** — the unit forward direction for a camera at the
given angles (radians). `yaw=0,pitch=0` → `[0,0,-1]`. Always unit length.

> Invariants: result is always unit length; `add`/`sub` are exact inverses; `normalize`
> yields length 1 (or the zero vector); yaw is 2π-periodic.

---

## `core/blocks.ts`

```ts
type BlockId = number;

const Block: {
  Air:0, Stone:1, Grass:2, Dirt:3, Cobblestone:4, Planks:5, Sand:6,
  Gravel:7, Log:8, Leaves:9, Glass:10, Brick:11, Bedrock:12, Water:13
}

interface BlockDef {
  id: BlockId;
  name: string;
  solid: boolean;    // player collides with it (air, water are not solid)
  opaque: boolean;   // fully hides the touching neighbour face (glass/leaves/water do not)
  color: readonly [number, number, number];   // r,g,b in 0..1
}

const BLOCKS: Readonly<Record<BlockId, BlockDef>>   // total over all defined ids
const HOTBAR: readonly BlockId[]                    // placeable blocks, excludes Air

blockDef(id: BlockId): BlockDef    // unknown id → the Air definition (total, never throws)
isSolid(id: BlockId): boolean
isOpaque(id: BlockId): boolean
isAir(id: BlockId): boolean
```

`solid` and `opaque` are the two behavioural facets. **`opaque ⇒ solid`** for every block
(a see-through solid like glass is fine; an opaque non-solid would be a contradiction).

> Invariants: a frozen census pins every block's `{solid, opaque, name}`; a golden hash
> freezes all colours; `blockDef` is total.

---

## `core/world.ts`

```ts
class World {
  constructor(sizeX: number, sizeY: number, sizeZ: number); // throws on non-positive / non-integer

  readonly sizeX: number;
  readonly sizeY: number;
  readonly sizeZ: number;
  readonly data: Uint8Array; // length = sizeX*sizeY*sizeZ

  inBounds(x, y, z): boolean;
  index(x, y, z): number; // x + sizeX*(z + sizeZ*y); valid only in-bounds
  get(x, y, z): BlockId; // out of bounds → Block.Air
  set(x, y, z, id: BlockId): boolean; // out of bounds → ignored, returns false
  get volume(): number; // sizeX*sizeY*sizeZ
}
```

The world is a flat `Uint8Array`. The coordinate→index mapping is the convention the rest of
the core depends on (see [ARCHITECTURE.md](./ARCHITECTURE.md#coordinate-and-angle-conventions)).

> Invariants: `index` is a bijection onto `[0, volume)` (no collisions, full coverage);
> `get`/`set` round-trip; out-of-bounds is Air/ignored and never corrupts the array.

---

## `core/raycast.ts`

```ts
interface RayHit {
  block: Vec3;      // the solid voxel that was hit
  normal: Vec3;     // unit face normal of the side entered (one axis ±1; [0,0,0] if origin was inside a block)
  place: Vec3;      // empty cell adjacent to the hit face = block + normal (where a new block goes)
  distance: number; // world-unit distance from origin to the entry point
}

raycast(
  world: World,
  origin: Vec3,
  dir: Vec3,                          // need not be normalized; zero vector → null
  maxDist: number,
  isHit?: (id: number) => boolean,    // default: isSolid
): RayHit | null
```

Amanatides–Woo DDA voxel traversal. `distance` is reported in true world units regardless of
`dir`'s magnitude. Starting **inside** a solid block returns that block at `distance = 0` with
a zero normal.

> Invariants: an independent analytic ray/AABB (slab) intersection re-derives the entry
> distance and face for arbitrary directions and must agree with the DDA; the hit block is
> solid, `place` is empty, and `place = block + normal`.

---

## `core/mesher.ts`

```ts
interface ChunkMesh {
  positions: Float32Array;   // xyz per vertex
  normals: Float32Array;     // xyz per vertex
  colors: Float32Array;      // rgb per vertex — per-face shade × per-vertex AO (greyscale)
  uvs: Float32Array;         // st per vertex — into the texture atlas
  indices: Uint32Array;      // 6 per quad (two triangles)
  faceCount: number;         // number of visible quads emitted
}

isFaceVisible(world: World, x, y, z, faceIndex: number): boolean   // faceIndex 0=+X,1=-X,2=+Y,3=-Y,4=+Z,5=-Z
vertexAO(side1: number, side2: number, corner: number): number     // ambient-occlusion level 0..3 (0=darkest); both sides ⇒ 0
buildMesh(world: World): ChunkMesh                                 // mesh the whole world

// Chunked meshing (rebuild only what an edit touches)
const CHUNK_SIZE = 16
chunkDims(world: World, chunkSize?): { nx, ny, nz }                       // chunk count per axis (ceil)
buildChunkMesh(world: World, cx, cy, cz, chunkSize?): ChunkMesh           // mesh one chunk, culling across borders
chunksAffectedByEdit(world: World, x, y, z, chunkSize?): [cx,cy,cz][]     // chunks to rebuild for an edit at (x,y,z)
```

A face is emitted iff the neighbour **across it** is not opaque (air, glass, leaves, water,
or out-of-bounds reveal it). Buffer layout per quad: 4 vertices, 6 indices. Each face is
shaded by a fixed ambient factor (top `1.0` … bottom `0.5`) multiplied into its vertex
colours.

`buildChunkMesh` iterates only one chunk's cells (clamped to the world edge for the last,
partial chunk) but culls against the full world, so the chunks tile the world and reassemble
into the exact whole-world mesh — no seams. Vertices are emitted in **world** coordinates, so
each chunk's geometry sits at the origin.

> Invariants: face count equals an independent neighbour census; a face is culled by the
> neighbour in _its own_ direction (not the opposite); quad winding faces outward (cross of
> the first triangle aligns with the stored normal); buffer sizes stay consistent
> (`positions.length === faceCount*12`, `uvs.length === faceCount*8`, `indices.length ===
faceCount*6`).
> **Chunking:** Σ per-chunk `faceCount` == whole-world `faceCount` and the per-chunk face
> _sets_ union to the whole-world set; `chunkDims` is the minimal cover (`(n−1)·size < dim ≤
n·size`); `chunksAffectedByEdit` reports every chunk an edit can change.
> **Textures:** each face's 4 UVs equal `uvRectForTile(tileIndexFor(block, face))`.

---

## `core/atlas.ts`

```ts
const ATLAS_COLS = 4, ATLAS_ROWS = 4, TILE_COUNT = 15
const Tile = { Stone, GrassTop, GrassSide, Dirt, ... }   // tile slots
TILE_COLOR: Record<TileIndex, [r,g,b]>                    // base colour per tile (static)
tileIndexFor(id: BlockId, faceIndex: number): TileIndex   // per-face tile choice
uvRectForTile(t: number): { u0, v0, u1, v1 }              // tile → UV rect in [0,1]²
```

Pure texture-atlas layout. `tileIndexFor` gives grass a green top / dirt bottom / grass-side
ring and logs end-grain on the caps; every other block uses one tile on all faces.
`uvRectForTile` places tile `t` at column `t % ATLAS_COLS`, row `⌊t / ATLAS_COLS⌋`.

> Invariants: every tile's rect is a `1/COLS × 1/ROWS` cell within `[0,1]²` whose corner
> recovers its index (a bijection); `tileIndexFor` is total over every block × face into
> `[0, TILE_COUNT)`; grass/log faces are distinct, plain blocks uniform.

---

## `core/terrain.ts`

```ts
hash2(seed: number, x: number, z: number): number          // deterministic, in [0, 1)
heightAt(seed: number, sizeY: number, x: number, z: number): number   // integer in [1, sizeY-1]
generateTerrain(world: World, seed: number, seaLevel?: number): void  // fills world in place
```

`generateTerrain` is a pure function of `(seed, size, seaLevel)` — identical inputs produce
byte-identical worlds. Default `seaLevel = floor(sizeY * 0.42)`. Column layering, top-down:

| `y`                                 | block                     |
| ----------------------------------- | ------------------------- |
| `y === height` and `height ≤ sea+1` | Sand (beaches)            |
| `y === height` otherwise            | Grass                     |
| `height-3 ≤ y < height`             | Dirt                      |
| `1 ≤ y < height-3`                  | Stone                     |
| `y === 0`                           | Bedrock (permanent floor) |
| `height < y ≤ sea`                  | Water                     |
| else                                | Air                       |

> Invariants: a golden hash freezes the output for a fixed seed; same seed → identical
> bytes, different seed → different bytes; `heightAt ∈ [1, sizeY-1]`; the layering contract
> holds for every column; water never appears above sea level.

---

## `core/physics.ts`

```ts
interface AABB { pos: Vec3; readonly half: Vec3 }   // centre + half-extents

interface MoveResult {
  pos: Vec3;
  onGround: boolean;                       // downward motion stopped this step
  collided: readonly [boolean, boolean, boolean];   // per-axis [x, y, z]
}

boxIntersectsSolid(world: World, center: Vec3, half: Vec3): boolean
moveAndCollide(world: World, center: Vec3, half: Vec3, delta: Vec3): MoveResult
```

**`moveAndCollide`** resolves movement one axis at a time (Y, then X, then Z) so the player
slides along walls. On collision along an axis, that axis' motion is cancelled (velocity
bleed is the caller's job). Assumes the starting box is not already embedded in solid
geometry, and that `|delta|` per axis is below one block (true for clamped frame steps) —
it is an endpoint test, not a continuous sweep.

> Invariants: `boxIntersectsSolid` matches an _independent_ overlap oracle over a sparse
> world (so all three axes' bounds matter); after a sub-block step from a free start the box
> is never inside solid; landing flags `onGround`; a wall collision cancels only the blocked
> axis; a ceiling collides on Y but is not `onGround`.

---

## `game/movement.ts`

```ts
interface PlayerState {
  pos: Vec3;
  vel: readonly [number, number, number];
  yaw: number; pitch: number;
  onGround: boolean;
  flying: boolean;
}

interface MovementInput {
  forward: number;   // -1..1  (W - S)
  strafe: number;    // -1..1  (D - A)
  up: number;        // -1..1  (Space - Shift), only while flying
  jump: boolean;     // Space, while walking
}

interface MovementTuning { walk: number; fly: number; gravity: number; jump: number; half: Vec3 }

stepMovement(world: World, state: PlayerState, input: MovementInput, dt: number, t: MovementTuning): PlayerState
```

Pure per-frame player update — returns the next state, never mutates `state`. Horizontal
input is normalized so diagonal movement isn't faster than cardinal. Walking applies gravity
and only jumps when `onGround`; flying ignores gravity and drives vertical velocity directly
from `up`. Collision is delegated to `moveAndCollide`.

> Invariants: gravity strictly decreases vertical velocity while airborne; jump fires only
> when grounded; diagonal speed equals cardinal speed; at `yaw=0` W→−Z and D→+X, at
> `yaw=π/2` W→−X and D→−Z, with position advancing by `vel*dt`; landing zeroes vertical
> velocity; the input state is never mutated.

---

## `render/chunkGeometry.ts`

```ts
geometryFromMesh(mesh: ChunkMesh): THREE.BufferGeometry   // upload any mesher result
buildChunkGeometry(world: World): THREE.BufferGeometry     // = geometryFromMesh(buildMesh(world))
```

Uploads a mesher result into a `BufferGeometry` (`position`/`normal`/`color` at itemSize 3,
`uv` at itemSize 2, indexed). The only bridge between the pure core and Three.js geometry.
Three's `BufferGeometry` is pure JS (no WebGL context needed), so this is unit-tested too.

> Invariant: the geometry's attributes are byte-for-byte what the mesher produced.

---

## `render/atlasTexture.ts`

```ts
buildAtlasTexture(tilePx?: number): THREE.DataTexture
```

Generates the block texture atlas procedurally (no image assets) from `core/atlas`'s
`TILE_COLOR`, with a deterministic per-pixel grain + 1px bevel and `NearestFilter` for crisp
Classic pixels. Used as the terrain material's `map` in `main.ts`.

> Invariant (unit-tested): each tile's cell in the generated image averages to that tile's
> `TILE_COLOR` at the atlas position `core/atlas` assigns it.

---

## `render/chunkedTerrain.ts`

```ts
class ChunkedTerrain {
  constructor(world: World, material: THREE.Material, chunkSize?: number);
  readonly group: THREE.Group; // add to the scene; one Mesh per non-empty chunk
  rebuildAround(x, y, z): void; // remesh only the chunks an edit at (x,y,z) touches
}
```

Renders the world as a grid of per-chunk meshes (thin Three.js wiring over the core's
`buildChunkMesh` / `chunksAffectedByEdit`). Verified by the smoke test for in-browser render,
and by a unit oracle that its assembled geometry — and its state after incremental
`rebuildAround` edits — equals an independent whole-world `buildMesh`.

> Invariant: the union of chunk geometries equals the whole-world mesh, and incremental edits
> keep it that way (no stale seams).

---

## `core/selfcheck.ts`

```ts
selfCheck(): true   // throws SelfCheckError if any boot invariant is violated
```

Called once at startup in `main.ts`. Re-derives the cheapest invariants (world bijection,
get/set round-trip, lone-block 6 faces / adjacent-pair 10 faces, block facets, a raycast
pick, camera direction) in the production runtime and throws on any mismatch — so a broken
build fails at the door rather than rendering a subtly wrong world.
