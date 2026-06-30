# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Coloured (RGB) light** (`core/light.ts`): emitters carry an optional `emissionColor`
  tint (Glowstone now glows warm); `computeBlockLightRGB` floods the three channels
  independently, seeding each at `round(emission · tint)`, and `computeLightRGB` combines
  coloured block-light with white skylight as a per-channel max. A strict extension — a
  white emitter reproduces the scalar field on every channel, and the scalar
  `computeBlockLight`/`computeLight` are unchanged (the renderer still uses them until the
  meshing pass lands). Pinned by a per-channel independent relaxation, a red-channel
  byte-for-byte reduction to scalar block-light, a per-channel-max census, an `r ≥ g ≥ b`
  warm-ordering invariant, and a closed-form per-channel decay golden. (#80)

### Changed

- **Water is now a flood fill (the Minecraft Classic model).** `computeWater` reworked
  from a finite-level cellular automaton to a binary flood: a non-solid cell is water iff
  reachable from a `Block.Water` source by sideways/downward steps, never up. Water now
  fills reachable gaps and lies flat — realistic and Classic-authentic — instead of
  decaying with distance from a source like a light field (and a single source no longer
  dies 7 cells out). Rendered as flat full cubes again. Pinned by an independent
  reachability relaxation, the fixpoint condition, an inflow-witness/never-rises invariant,
  a damming metamorphic, and gap-filling/waterfall/seeded-terrain goldens. This supersedes
  the interim finite-level water work (partial-height surfaces and incremental
  `updateWater`) landed earlier this cycle. (#85)

## [0.4.0] - 2026-06-29

Lighting & fluids.

### Added

- **Glowstone**, a light-emitting block: every `BlockDef` gains an `emission` field
  (`0`…`15`) with an `emissionOf` accessor, plus an atlas tile and a hotbar slot. (#62)
- **Block-light propagation** (`core/light.ts`): a multi-source BFS flood-fill from
  emitters, attenuating one level per step through non-opaque cells (opaque blocks cast
  shadow). A max-fixpoint, so order-independent; pinned by an independent relaxation, an
  open-air Manhattan-distance golden, a shadow metamorphic, and invariants. (#63)
- **Skylight propagation** (`computeSkyLight`): every cell open to the sky is full, and
  the same flood spreads it down + sideways — a vertical drop through open air never
  attenuates (the Classic rule). `computeLight` combines block + sky as a cell-wise max.
  Pinned by an independent relaxation, closed-form goldens (a lone roof casts an
  exactly-14 shadow column), and a seeded-terrain golden. (#64)
- **Light-aware meshing**: the mesher dims each face by the light at the open cell it
  looks into, folding `lightFactor(light)` into the per-vertex colour
  (`texel × faceShade × AO × light`). Omitting the light field is byte-identical to the
  unlit mesh (a strict extension). Pinned by a light-folded colour census, a
  monotonicity metamorphic, and a Glowstone-brightens-a-shadowed-face metamorphic. (#65)
- **Incremental light updates** (`updateBlockLight` / `updateSkyLight` / `updateLight`):
  a two-pass remove/add flood applies a single edit in place and returns the exact
  changed cells, so the renderer remeshes only the affected chunks. Pinned by a
  differential oracle (incremental == from-scratch after every edit of a random
  sequence) and per-field / combined changed-set censuses. (#66)
- **Water flow** (`core/water.ts`): a deterministic cellular automaton giving a per-cell
  level `0`…`7` — sources fall full and spread one less per step, never up, the least
  fixpoint of the rule. Pinned by the fixpoint condition itself, an independent
  relaxation, a reachability invariant, floor/waterfall goldens, and a damming
  metamorphic. (#67)
- **Translucent water rendering** (`core/waterMesh.ts`): the water field is drawn as a
  separate alpha-blended pass — a watered cell's face shows only where it meets open air
  — so you see the lakebed through the surface. Pinned by a where-census, a shade census,
  and outward-winding (100% mutation score). (#74)

### Changed

- The **falsifiability gate moved out of CI** to a local `git` pre-push hook
  (`npm run hooks:install`) that runs `npm run mutation:clean` and aborts on a score
  below 70 — merges now run only the ~1.5-min fast checks. (#61)
- The **mutation-score badge is decoupled** from push-to-`main`: a dedicated workflow
  refreshes the Stryker-dashboard badge only on a published release or manual dispatch. (#68)

## [0.3.0] - 2026-06-28

World depth & rendering.

### Added

- **Ambient occlusion**: per-vertex AO darkens voxel corners by their three occluding
  neighbours, verified by an independent AO census oracle. (#29)
- **World save/load**: edits are serialized with run-length encoding and persisted to
  `localStorage`, then restored on reload (`N` starts a fresh world). Pinned by a
  round-trip census oracle. (#28)
- **Deterministic trees** in terrain generation (`Log`/`Leaves`), placed by a seeded
  cell-grid pass and pinned by a golden hash plus a re-derived root-census bijection. (#30)
- **Texture array**: blocks are textured from a procedural `DataArrayTexture` (one layer
  per tile) sampled by a per-vertex `layer`, replacing the single 4×4 atlas — so a merged
  quad can repeat its tile. The mesher emits tile-local UVs + a `layer`; the terrain
  material redirects Lambert's texture fetch to the array via `onBeforeCompile`. (#31)
- **Greedy meshing**: coplanar, same-tile, uniformly-lit faces merge into bigger quads
  (≈55% fewer quads on the default terrain), pixel-identically. Pinned by an
  area-conservation census (greedy quads decompose to exactly the visible unit faces), a
  solid-cube golden, and tile/UV + AO censuses. (#31)
- **Generated mutation-score badge**: the README badge is published to the Stryker
  dashboard from CI on push to `main`, replacing the hand-edited static value. (#32)
- **`CHANGELOG.md`** and retroactive `v0.1` / `v0.2` tags + a v0.2 release. (#33)

### Changed

- Pinned a **fast-check seed** (`test/setup.ts`) so the mutation score and the exact
  survivor set are reproducible run-to-run. (#46)
- The smoke test waits for the player to land (HUD shows "ground") instead of a fixed
  sleep. (#53)
- CI: the heavy **mutation** and **smoke** jobs skip their expensive steps on
  docs/config-only changes — on PRs and on push to `main` — while still reporting
  success, so the required checks stay green without blocking. (#48, #51)
- CI: trimmed the AO oracle `numRuns` to cut mutation runtime without losing kills. (#49)

## [0.2.0] - 2026-06-28

Tooling & polish.

### Added

- **`mutation:clean`** script that wipes the Stryker incremental cache for an
  authoritative score, plus documentation of the incremental-cache footgun. (#12)
- **ESLint + Prettier** with a CI lint gate. (#13)
- **Dependabot** for weekly npm + GitHub-Actions updates. (#16)
- **README status badges**: CI, live demo (GitHub Pages), mutation score, license. (#15)
- Regenerated the **textured hero screenshot**. (#14)

### Changed

- Pinned the public npm registry (`.npmrc`) so Dependabot's npm updater can run.
- Bumped the toolchain: Vitest 4 + StrykerJS 9, Vite 8, TypeScript 6, three 0.185,
  fast-check 4; added a `qs` override to clear a dev-only audit advisory.

## [0.1.0] - 2026-06-27

Oracle-hardened voxel core & renderer — the initial implementation.

### Added

- Pure, dependency-free, **oracle-tested voxel core**: `math`, `blocks`, `world` (the
  coord↔index bijection), `raycast` (DDA picking), `mesher` (face-culled meshing),
  `terrain` (seeded generation), `physics` (AABB vs voxel grid), and `game/movement` —
  each paired with an independent, falsifiable `*.test.ts` oracle and proven by mutation
  testing.
- A boot **self-check** that re-derives cheap invariants and throws at startup.
- **Chunked meshing**: an edit rebuilds only the affected chunks, seam-correct. (#4)
- **Texture atlas**: procedural per-face textures replace flat per-vertex colours. (#5)
- A CI-portable **headless smoke test** with a falsifiable pixel-census render check. (#1)
- Golden cases pinning **raycast**'s degenerate-input conventions — tie-break order,
  inclusive reach, entry guards. (#6)
- **MIT LICENSE**. (#2)
- Branch protection on `main` requiring the full check suite before merge. (#3)

[unreleased]: https://github.com/PSthelyBlog/minecraft-test-oracle/compare/v0.3...HEAD
[0.3.0]: https://github.com/PSthelyBlog/minecraft-test-oracle/compare/v0.2...v0.3
[0.2.0]: https://github.com/PSthelyBlog/minecraft-test-oracle/compare/v0.1...v0.2
[0.1.0]: https://github.com/PSthelyBlog/minecraft-test-oracle/releases/tag/v0.1
