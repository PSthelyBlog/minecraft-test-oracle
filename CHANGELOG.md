# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

In progress: **v0.3 — world depth & rendering**.

### Added

- **Ambient occlusion**: per-vertex AO darkens voxel corners by their three occluding
  neighbours, verified by an independent AO census oracle. (#29)
- **World save/load**: edits are serialized with run-length encoding and persisted to
  `localStorage`, then restored on reload (`N` starts a fresh world). Pinned by a
  round-trip census oracle. (#28)
- **Deterministic trees** in terrain generation (`Log`/`Leaves`), placed by a seeded
  cell-grid pass and pinned by a golden hash plus a re-derived root-census bijection. (#30)
- **Generated mutation-score badge**: the README badge is published to the Stryker
  dashboard from CI on push to `main`, replacing the hand-edited static value. (#32)

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

[unreleased]: https://github.com/PSthelyBlog/minecraft-test-oracle/compare/v0.2...HEAD
[0.2.0]: https://github.com/PSthelyBlog/minecraft-test-oracle/compare/v0.1...v0.2
[0.1.0]: https://github.com/PSthelyBlog/minecraft-test-oracle/releases/tag/v0.1
