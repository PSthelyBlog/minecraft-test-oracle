# Testing & the Oracle Methodology

This project was built with the [`test-oracle`](https://github.com/PSthelyBlog/test-oracle)
plugin. The thesis: a green test suite means nothing if the tests can't *fail*. So every
logic module has an **independent, per-case, falsifiable oracle**, and **mutation testing**
proves those oracles actually catch bugs.

## Commands

```bash
npm test            # run all 69 oracle tests once (Vitest)
npm run test:watch  # watch mode
npm run mutation    # StrykerJS — mutate the core, report which mutants survive
npm run smoke       # headless-Chromium boot/render check (start a dev/preview server first)
npm run typecheck   # tsc --noEmit
```

Stack: **Vitest** (runner), **fast-check** (property-based generators), **StrykerJS**
(mutation testing, Vitest runner).

## What makes an oracle, not just a test

A weak test asserts the code returns *something*. An **oracle** asserts a property that must
hold, stated **independently of the implementation**, so it disagrees when the code is wrong.
The shapes used here:

| Shape | Meaning | Example in this repo |
|-------|---------|----------------------|
| **Round-trip / inverse** | `decode(encode(x)) === x` | `chunkGeometry` uploads exactly what the mesher emitted |
| **Census / bijection** | every case mapped exactly once | `world.index` is a bijection onto `[0, volume)` |
| **Independent re-derivation** | a *different algorithm* computes the same answer | analytic slab ray/AABB vs the DDA `raycast` |
| **Metamorphic** | a transformed input changes the output predictably | diagonal speed == cardinal speed; a solid cube shows only its shell |
| **Invariant** | a property that always holds | resolved player box is never inside solid; `opaque ⇒ solid` |
| **Golden** | deterministic output frozen once | terrain world hash; block-colour hash |

The strongest oracles here are the **independent re-derivations** — the analytic ray/AABB
intersection for `raycast`, and the interval-overlap check for `physics` — because they share
no code with the function under test.

## Why mutation testing, and what it found

`npm test` being green only proves the oracles *pass*. **Mutation testing** deliberately
breaks the source (flips `<` to `<=`, `+` to `-`, deletes statements) and re-runs the tests.
A mutant that survives is a bug your tests would not have caught — a **blind spot**.

Treating every survivor as a blind spot during development surfaced real problems:

1. **A real rendering bug.** The mesher's quad corners were wound *clockwise* as seen from
   outside. With default front-face culling that makes every face invisible. The winding
   oracle (cross-product of the first triangle vs the stored normal) caught it; the fix was
   to reorder the corners CCW-outward.
2. **A self-referential oracle.** The physics test used `boxIntersectsSolid` to verify the
   output of `moveAndCollide` — but Stryker mutates `boxIntersectsSolid`, so a mutated
   version agreed with itself and survived. Fixed by writing an **independent** overlap
   check in the test.
3. **A count-blind oracle.** The mesher face-count census couldn't see a mutation that
   swapped *which* neighbour culls *which* face — the total count was identical. Fixed with
   a **directional** oracle (`isFaceVisible` per face).
4. **A flat-world blind spot.** The physics differential test ran over a flat floor (solid at
   every x,z), so bugs in the box's X/Z extent couldn't change the result. Fixed by testing
   over a **sparse** world.
5. **Coverage gaps.** The Z-axis collision branch and player-movement *direction* (as opposed
   to speed) were never exercised. Fixed with targeted cases.

## Current results

Run `npm run mutation` for the live numbers. As of this base implementation:

| Module | Mutation score | Notes |
|--------|---------------:|-------|
| `blocks.ts` | 100% | static data; falsifiability proven by injection (see below) |
| `math.ts` | 100% | |
| `movement.ts` | 100% | |
| `physics.ts` | ~98% | |
| `world.ts` | ~97% | |
| `mesher.ts` | ~97% | incl. chunked meshing; 3 equivalent sign mutants (see below) |
| `terrain.ts` | ~95% | |
| `raycast.ts` | ~84% | remaining survivors are equivalent (see below) |
| **overall** | **~94%** | 69 tests across 12 files |

The Stryker thresholds (`stryker.config.json`) are `break: 70`, `low: 80`, `high: 90`. The
run fails CI below 70.

## Equivalent mutants (why not 100%)

Some surviving mutants are **equivalent** — they change the source without changing any
observable behaviour, so *no* test can kill them. The methodology says to analyse and
document these, not to chase a vanity number. The ones left here:

- **Loop bounds that read one cell out of bounds** (`y < sizeY` → `y <= sizeY` in the
  mesher): `world.get` returns `Air` out of bounds, contributing no faces. No effect.
- **Empty error-message strings** (`world.ts` constructor): the error still throws; the
  message text is not behaviour.
- **Exact-boundary `<=` vs `<`** and **zero-direction-component step signs** (`raycast.ts`
  DDA guards and corner tie-breaks): only differ on measure-zero inputs (a ray passing
  exactly through a voxel corner, a reach of exactly 0) that don't occur in gameplay rays.
- **`min(sizeY-1, h)` clamp** (`terrain.ts`): the terrain amplitude never reaches the cap,
  so the clamp never binds.
- **`else { block = Air }` → `{}`** (`terrain.ts`): leaves `block` undefined, which a
  `Uint8Array` coerces to `0` = Air anyway.
- **Neighbour-offset sign** (`chunksAffectedByEdit` in `mesher.ts`, `coord + delta` →
  `coord - delta`): the offset list is symmetric (each axis appears as both `+1` and `−1`),
  so flipping a sign visits the same neighbours in a different order and returns the **same
  chunk set**. Only the set matters, so these 3 mutants are equivalent. (The chunk-count
  `chunkDims` mutants — `/` → `*` — were *not* equivalent and were killed by a minimal-cover
  oracle: extra chunks are empty so the face census misses them, but `(n−1)·size < dim` does
  not.)

`raycast.ts` sits lowest at ~84% precisely because DDA traversal has many degenerate-input
guards of this kind. If you want them pinned to a convention anyway, add exact-corner and
exact-reach golden cases.

## Static data: `blocks.ts` and `ignoreStatic`

`BLOCKS` is a module-load-time constant. StrykerJS with the Vitest runner can't activate a
mutant inside an import-time constant (the object is built before the mutant flag is set), so
those mutants are reported as `static` and **`ignoreStatic: true`** removes them from the
score. The oracle is still genuinely falsifiable — proven by direct injection: flipping
`Stone.solid` in the source fails the facet census immediately. Don't confuse "Stryker can't
exercise it" with "untested".

## The paired-oracle convention & the doctor

The convention: **every source module has a sibling `<module>.test.ts`.** Verify it with:

```bash
node ".../test-oracle/scripts/oracle-doctor.mjs" .
```

It checks the wiring (deps, scripts, configs) and lists any module lacking a sibling oracle.
Current state: **11/12 modules paired**. The one exception is `src/main.ts` — the browser
entry shell (DOM, WebGL, the frame loop) which can't be imported in Node. It is covered by
the **smoke test** (`scripts/smoke.mjs`) instead: a headless Chromium run that boots the game,
asserts no console/page errors, that the frame loop ran (HUD shows coordinates), that the
player resolved onto the ground, and that the hotbar built.

### The render check is a falsifiable oracle, not a byte-size heuristic

The smoke test's hardest job is proving the WebGL canvas *actually drew the world* — the
classic silent failure (a failed shader, geometry that never uploaded, a lost context)
leaves a blank or single-colour canvas while everything else looks fine. The check is a
**pixel census**, not "is the PNG big enough": it screenshots the canvas, decodes it back to
pixels in the page, and pins three independent facts the real frame satisfies and a broken
one cannot — terrain **fills** the frame (≥50% of pixels are not the sky clear-colour),
the frame has real luminance **variance** (a flat canvas has std ≈ 0), and it has **many
distinct colours** (a single-colour canvas has ~1). It first hides the DOM chrome, because
in headless there is no gesture to take pointer-lock, so the start overlay's 60%-black scrim
stays up and would otherwise darken the sky into a terrain-like tone.

Proven falsifiable the same way the unit oracles are — by watching it fail: dropping the
terrain mesh from the scene clears the canvas to bare sky, and the census collapses to
`nonSkyFraction 0, lumStd 0, 1 colour` → all three render checks fire (the equivalent of a
killed mutant for the shell).

### CI-portable

The browser path is env-driven: `CHROME_PATH` selects a system Chrome, and otherwise the
test falls back to Playwright's bundled Chromium (`npx playwright install chromium`). So the
same script runs locally and as the **`smoke` CI job**, which builds, serves `vite preview`,
and runs the render check (software WebGL via SwiftShader) on every push — WebGL rendering is
verified in CI, not just on a developer's Mac.

## Adding an oracle for a new module

1. Create `src/.../foo.ts` with pure logic (no DOM/Three.js — keep it in the core).
2. Add `src/.../foo.test.ts`. Ask **"how could this fail silently?"** and pick a shape from
   the table above. Prefer an *independent* re-derivation or a census over re-stating the
   implementation.
3. `npm test` — make it green.
4. `npm run mutation` — **watch it fail**. Every survivor is a missing check. Add an
   assertion that kills it, or document it as equivalent with a reason.
5. If you mutate files outside `src/core`/`src/game`, add the path to `mutate` in
   `stryker.config.json`.

> Rule of thumb: if you can delete a line of the source and the suite stays green, you don't
> have an oracle for that line yet.

## CI suggestion

```yaml
# .github/workflows/ci.yml (sketch — see the real file for the full smoke job)
- run: npm ci
- run: npm run typecheck
- run: npm test
- run: npm run mutation     # fails if score < break threshold (70)
# render check: build, serve, boot in headless Chromium, census the framebuffer
- run: npx playwright install --with-deps chromium
- run: npm run build
- run: npm run preview -- --port 4173 --strictPort &
- run: URL=http://localhost:4173/ npm run smoke
```

The mutation step is what keeps the suite honest over time: as the code changes, a dropping
score means new blind spots. The smoke job does the same for the shell — if the render ever
silently breaks, the pixel census fails CI.
