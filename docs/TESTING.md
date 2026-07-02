# Testing & the Oracle Methodology

This project was built with the [`test-oracle`](https://github.com/PSthelyBlog/test-oracle)
plugin. The thesis: a green test suite means nothing if the tests can't _fail_. So every
logic module has an **independent, per-case, falsifiable oracle**, and **mutation testing**
proves those oracles actually catch bugs.

## Commands

```bash
npm test            # run all 201 oracle tests once (Vitest)
npm run test:watch  # watch mode
npm run mutation       # StrykerJS — mutate the core, report which mutants survive (fast, incremental)
npm run mutation:clean # same, but wipe the incremental cache first → authoritative score (see below)
npm run smoke          # headless-Chromium boot/render check (start a dev/preview server first)
npm run typecheck      # tsc --noEmit
```

Stack: **Vitest** (runner), **fast-check** (property-based generators), **StrykerJS**
(mutation testing, Vitest runner).

## What makes an oracle, not just a test

A weak test asserts the code returns _something_. An **oracle** asserts a property that must
hold, stated **independently of the implementation**, so it disagrees when the code is wrong.
The shapes used here:

| Shape                         | Meaning                                            | Example in this repo                                                |
| ----------------------------- | -------------------------------------------------- | ------------------------------------------------------------------- |
| **Round-trip / inverse**      | `decode(encode(x)) === x`                          | `chunkGeometry` uploads exactly what the mesher emitted             |
| **Census / bijection**        | every case mapped exactly once                     | `world.index` is a bijection onto `[0, volume)`                     |
| **Independent re-derivation** | a _different algorithm_ computes the same answer   | analytic slab ray/AABB vs the DDA `raycast`                         |
| **Metamorphic**               | a transformed input changes the output predictably | diagonal speed == cardinal speed; a solid cube shows only its shell |
| **Invariant**                 | a property that always holds                       | resolved player box is never inside solid; `opaque ⇒ solid`         |
| **Golden**                    | deterministic output frozen once                   | terrain world hash; block-colour hash                               |

The strongest oracles here are the **independent re-derivations** — the analytic ray/AABB
intersection for `raycast`, and the interval-overlap check for `physics` — because they share
no code with the function under test.

## Why mutation testing, and what it found

`npm test` being green only proves the oracles _pass_. **Mutation testing** deliberately
breaks the source (flips `<` to `<=`, `+` to `-`, deletes statements) and re-runs the tests.
A mutant that survives is a bug your tests would not have caught — a **blind spot**.

Treating every survivor as a blind spot during development surfaced real problems:

1. **A real rendering bug.** The mesher's quad corners were wound _clockwise_ as seen from
   outside. With default front-face culling that makes every face invisible. The winding
   oracle (cross-product of the first triangle vs the stored normal) caught it; the fix was
   to reorder the corners CCW-outward.
2. **A self-referential oracle.** The physics test used `boxIntersectsSolid` to verify the
   output of `moveAndCollide` — but Stryker mutates `boxIntersectsSolid`, so a mutated
   version agreed with itself and survived. Fixed by writing an **independent** overlap
   check in the test.
3. **A count-blind oracle.** The mesher face-count census couldn't see a mutation that
   swapped _which_ neighbour culls _which_ face — the total count was identical. Fixed with
   a **directional** oracle (`isFaceVisible` per face).
4. **A flat-world blind spot.** The physics differential test ran over a flat floor (solid at
   every x,z), so bugs in the box's X/Z extent couldn't change the result. Fixed by testing
   over a **sparse** world.
5. **Coverage gaps.** The Z-axis collision branch and player-movement _direction_ (as opposed
   to speed) were never exercised. Fixed with targeted cases.
6. **Greedy-mesh oracle gaps.** When greedy meshing was added, mutation flagged two blind spots
   the area-conservation census couldn't see: the merged-quad **UV orientation** (a swapped
   s/t→axis assignment mis-tiles a _non-square_ merge while keeping the area product `M·N`), and
   the **triangle split** of the non-uniform 1×1 quads (winding is outward either way). Fixed
   with a per-cell unit-tile check and an independent brighter-diagonal re-derivation — a reminder
   that a coverage census alone doesn't pin per-quad appearance.

## The incremental-cache footgun: `mutation` vs `mutation:clean`

`stryker.config.json` sets `"incremental": true` so iterative reruns only re-test the
mutants your change touched — a big speedup while you iterate. The catch: the incremental
cache (`reports/stryker-incremental.json`) and sandbox (`.stryker-tmp`) persist between
runs, so a **second back-to-back `npm run mutation` can reuse cached mutant verdicts and
overwrite `reports/mutation/mutation.json` with them.** A mutant you just _killed_ can then
show as `Survived` (and vice-versa) — the exact stale-report failure mode mutation testing
exists to prevent. (Seen for real in #6: a `raycast.ts` mutant reported `Survived` while the
test provably killed it.) The Stryker CLI in this version accepts no `--incremental false`
override, so the only fix is to delete the cache first.

So:

- **`npm run mutation`** — fast, incremental. Use while iterating on one module.
- **`npm run mutation:clean`** — wipes `reports/stryker-incremental.json` + `.stryker-tmp`,
  then runs Stryker once. Use this for **the authoritative score** — before reading the final
  table, updating the numbers below, or trusting whether a survivor is real.

CI is unaffected (every run is a clean checkout), so this is a local-DX footgun, not a CI
correctness bug. `mutation:clean` propagates Stryker's exit code, so it gates on the
`break: 70` threshold exactly like `mutation`.

## Reproducible runs: the pinned fast-check seed

The cache footgun above is one source of an untrustworthy local number; **unseeded property
tests** were the other. By default fast-check picks a random seed each run, so a mutant
sitting near a property's detection edge could be killed on one run and survive on the next —
the score wobbled by a mutant between otherwise-identical runs. That undercuts the point: the
core bans `Math.random`/`Date.now` so its output is reproducible, yet the tests verifying it
were not.

So the suite **pins a fixed fast-check seed** in `test/setup.ts` (wired via `setupFiles` in
`vitest.config.ts`), making every property run draw the same edge-biased sequence each time.
The score and the exact survivor set are now identical run-to-run. The seed fixes the
_sequence_, not the breadth — each property still explores its full `numRuns`.

This is reproducibility, **not** masking: the pinned survivor set was verified **seed-
independent** — running the whole suite under several different seeds yields the _same_
survivors, so no seed kills any of them (they are the genuinely-equivalent mutants documented
below). If a future change makes a previously-killed mutant survive only under the pinned
seed, that is a weak oracle to **strengthen** (raise its `numRuns` or add a targeted example),
not a number to accept. Explore other samples locally with `FAST_CHECK_SEED=<n> npm test`.

## Current results

Run `npm run mutation:clean` for the authoritative live numbers (see the footgun above for
why `mutation:clean` and not `mutation`). As of this base implementation:

| Module           | Mutation score | Notes                                                                                   |
| ---------------- | -------------: | --------------------------------------------------------------------------------------- |
| `blocks.ts`      |           100% | static data; falsifiability proven by injection (see below)                             |
| `math.ts`        |           100% |                                                                                         |
| `movement.ts`    |           100% | incl. swim physics (buoyancy/drag/swim-up); every mutant killed                         |
| `atlas.ts`       |           100% | per-face tile (layer) selection; `TILE_COLOR` static (injection-proven)                 |
| `waterMesh.ts`   |           100% | translucent water pass; where/shade/winding censuses kill every mutant                  |
| `medium.ts`      |           100% | observer's medium (air/water/solid); partition census + submersion differential; 0 surv |
| `physics.ts`     |           ~99% | AABB collide + `submersion`; 1 equivalent survivor (the `delta[1] < 0` onGround guard)  |
| `world.ts`       |           ~97% |                                                                                         |
| `mesher.ts`      |           ~96% | chunked + greedy, tile-local UV/layer, AO, RGB light; 18 equivalent survivors           |
| `terrain.ts`     |         ~94.5% | incl. deterministic trees; equivalent loop/cell-grid bounds + a measure-zero gate       |
| `raycast.ts`     |           ~92% | degenerate conventions now pinned; 9 equivalent survivors (see below)                   |
| `persistence.ts` |           ~91% | RLE save/load round-trip; 6 equivalent survivors (loop bounds + messages)               |
| `water.ts`       |           ~86% | flood fill (reachability/relaxation/inflow-witness); all 6 survivors equivalent (below) |
| `gravity.ts`     |           ~86% | sand/gravel settle; conservation/no-floating/column-independence; 5 equivalent (below)  |
| `lava.ts`        |           ~85% | bounded flood (budget relaxation/subset-vs-water/goldens); 9 equivalent (below)         |
| `light.ts`       |         ~83.5% | block/sky/combined + RGB channels + emissive field; all 26 survivors equivalent (below) |
| **overall**      |     **~94.0%** | 201 tests across 21 files                                                               |

The Stryker thresholds (`stryker.config.json`) are `break: 70`, `low: 80`, `high: 90`. A run
below 70 exits non-zero — which aborts the local `pre-push` hook (and fails the push-to-`main`
badge job as a backstop).

### The README badge is generated, not hand-synced

The README **Mutation score** badge is no longer a hand-edited static value. A dedicated
workflow (`.github/workflows/mutation-badge.yml`) runs Stryker with the **`dashboard` reporter**
(`--reporters …,dashboard`, using the `STRYKER_DASHBOARD_API_KEY` repo secret) and uploads the
full report to the
[Stryker dashboard](https://dashboard.stryker-mutator.io/reports/github.com/PSthelyBlog/minecraft-test-oracle/main).
The badge points at the dashboard's shields **endpoint** (`badge-api.stryker-mutator.io/…/main`).
It refreshes when a **release is published** or on **manual dispatch** (Actions → _mutation
badge_ → Run workflow) — deliberately **not** on every push to `main`, because the mutation run
is slow and merging a PR should be cheap. `dashboard.version` is pinned to `main` in
`stryker.config.json` so the report lands on the `…/main` badge regardless of the triggering ref.
This is the _only_ mutation run in CI and it gates nothing — the falsifiability gate is the local
pre-push hook. The per-module table below is still maintained by hand — it is documentation of _where_ the
survivors are, not the headline number.

## Equivalent mutants (why not 100%)

Some surviving mutants are **equivalent** — they change the source without changing any
observable behaviour, so _no_ test can kill them. The methodology says to analyse and
document these, not to chase a vanity number. The ones left here:

- **Loop bounds that read one cell out of bounds** (`y < sizeY` → `y <= sizeY` in the
  mesher): `world.get` returns `Air` out of bounds, contributing no faces. No effect.
- **Empty error-message strings** (`world.ts` constructor): the error still throws; the
  message text is not behaviour.
- **`raycast.ts` degenerate-input survivors.** The DDA's behaviour on measure-zero inputs
  used to leave ~16% of mutants alive. The _intentional_ conventions are now **pinned with
  golden cases** (`describe("raycast degenerate-input conventions")`): the zero-reach and
  zero-direction guards both fire before the inside-block hit; a block entered at _exactly_
  `maxDist` is hit while one just beyond is missed; and exact edge/corner ties break by axis
  priority **X > Y > Z**. What remains (raycast ~92%) is genuinely **equivalent**:
  - _zero-direction step sign_ (`d > 0` → `d >= 0` on each axis): when a direction component
    is exactly 0 that axis' `tMax` is `Infinity` and is never selected, so the step value is
    never read.
  - _`d !== 0 ? abs(1/d) : Infinity` → `true`_: `1/0` is already `Infinity`, so forcing the
    division branch produces the identical value.
  - _dead `normal` initializer_ (`[0,0,0]` → `[]`): every return path assigns `normal` first
    (or uses a literal), so the initial value is never observed.
  - _`while (t <= maxDist)` → `t < maxDist`_: differs only when a voxel boundary lands at
    `t === maxDist` exactly _and_ the next cell is reached at the same `t` (a corner exactly
    at the reach limit) — a measure-zero input.
  - _`step > 0` → `step >= 0`_ in `boundaryT`: unreachable, because `step === 0` already
    returned `Infinity` one line above.
- **`min(sizeY-1, h)` clamp** (`terrain.ts`): the terrain amplitude never reaches the cap,
  so the clamp never binds.
- **`else { block = Air }` → `{}`** (`terrain.ts`): leaves `block` undefined, which a
  `Uint8Array` coerces to `0` = Air anyway.
- **`terrain.ts` tree-placement survivors (equivalent).** The tree pass tiles the world into
  cells and bounds-checks each candidate, so several mutants change nothing observable:
  the generation/cell **loop bounds** (`<` → `<=`) and the **cell-count** divides
  (`ceil(size / TREE_CELL)` → `* TREE_CELL`) only ever add cells whose candidate column lands
  out of bounds and is skipped — the same trees are placed; the **`trees` array initializer**
  (`[]` → `["…"]`) injects a junk element whose `undefined` coordinates fail `inBounds`, a
  no-op; and the **density gate** (`hash ≥ TREE_DENSITY` → `> `) differs only when a cell hash
  is _exactly_ `0.5` — a measure-zero input the census would otherwise kill. The placement
  that _is_ observable (which cell grows, where, how tall, rooted on grass) is pinned by the
  tree golden hash, the **census bijection** (re-derived roots ⇔ actual `Log` trunk bases), and
  the grounded-trunk invariant.
- **Neighbour-offset sign** (`chunksAffectedByEdit` in `mesher.ts`, `coord + delta` →
  `coord - delta`): the offset list is symmetric (each axis appears as both `+1` and `−1`),
  so flipping a sign visits the same neighbours in a different order and returns the **same
  chunk set**. Only the set matters, so these 3 mutants are equivalent. (The chunk-count
  `chunkDims` mutants — `/` → `*` — were _not_ equivalent and were killed by a minimal-cover
  oracle: extra chunks are empty so the face census misses them, but `(n−1)·size < dim` does
  not.)
- **AO corner-offset X component** (`cornerAO` in `mesher.ts`, `su[0] + sv[0]` →
  `su[0] - sv[0]`): the diagonal corner-occluder offset is the sum of the two tangent step
  vectors. X is never the _second_ tangent axis (the tangent pairs are `[1,2] / [0,2] / [0,1]`,
  so `v ∈ {2,2,1}`), hence `sv[0]` is structurally always `0` and `±sv[0]` is indistinguishable.
  The **Y and Z** components of the same expression are _not_ equivalent (both axes appear as a
  `v`) and the AO census kills them; only this one X mutant survives.
- **Greedy-mesher survivors (13, all equivalent).** The greedy mesher
  (`buildGreedyMesh` / `buildGreedyChunkMesh`) is pinned by an **area-conservation census**
  (its quads decompose to exactly the visible unit faces — no overlap, gap, or stray), a
  **solid-cube golden** (6 quads, so a no-op "greedy" can't pass), a **tile/UV census** with a
  per-cell unit-tile check, an **AO census** that re-derives each covered cell's shading and the
  brighter-diagonal split, and a **per-channel light census** (below) that re-derives each cell's
  shade × AO × light on all three channels. What survives is genuinely equivalent, in classes
  already seen above:
  - _the `sAxis` ternary branches_ (`mesher.ts`, `ConditionalExpression → true`/`false` in the
    `f.corners[1][k] !== f.corners[0][k]` chain): `sAxis` only matters through `sAxis === u`,
    which decides whether a merged quad's UV `s` scales by `w` or `h`. Across the six faces
    `sAxis ∈ {0, 2}` while the first tangent `u ∈ {0, 1}`, so forcing these branches never
    flips `sAxis === u` — the tiling is unchanged. The mutants that _do_ change the s/t→axis
    assignment are killed by the per-cell unit-tile check (and the `1×3` non-square golden).
  - _array-initializer overwrites_ (`[0,0,0]`/`[0,0,0,0]` → `[]` for the per-cell `cell`, `B`,
    and `levels` scratch vectors): every slot is assigned before it is read (the axis triple is
    a permutation of `{0,1,2}`; the four AO corners are all filled), so the initializer's value
    is never observed — the same class as the terrain/`world` initializer survivors.
  - _mask preallocation_ (`new Array(U*V)` → `new Array()` for `key`/`keyLevel`/`keyLayer`/
    `keyLightR`/`keyLightG`/`keyLightB`/`used`): JS arrays grow on index assignment and an unset
    slot reads `undefined` (falsy, like the `false`/`null` fill), so dropping the size hint changes
    nothing — only the entries the greedy walk actually sets are ever read. (The three per-channel
    `keyLight*` masks — the RGB face light in the merge key — are in this same class.)
  - _the rectangle-height loop bound_ (`sv + h < V` → `<=` / `sv - h`): redundant with the inner
    row scan, which breaks as soon as a cell's key differs — and an out-of-slice read is
    `undefined ≠ key`, so it stops at the same `h` (the mesher/persistence loop-bound class).
- **`light.ts` coloured-light survivors (9, all equivalent).** `computeBlockLightRGB` floods each
  channel with the shared `floodLight`, seeded at `round(emission · tint[c])`, and `computeLightRGB`
  is the per-channel cell-wise max with white skylight — so the new survivors are the SAME classes as
  the scalar block/combined light, now per channel: the per-channel **seed loop bounds** (`y/z/x <
size` → `<=`) and the combine **loop bound** (`i < r.length` → `<=`) read one cell out of bounds, a
  no-op (loop-bound class); the **zero-seed guards** (`e === 0 ? continue` → `false`, and `seed > 0` →
  `true` / `>= 0`) only ever seed a cell at level `0` and queue it, which `floodLight` propagates as
  `0 − 1` into nothing — a no-op (the emitter-seed-guard class); and the three **per-channel max
  selects** (`block.{r,g,b}[i] > sky[i]` → `>=`) differ only on a tie, where both branches return the
  same value (the max-select-tie class, exactly as scalar `computeLight`). Pinned by the per-channel
  independent relaxation, the red-channel byte-for-byte reduction to scalar block-light, the
  per-channel-max census, the warm `r ≥ g ≥ b` ordering invariant, and a closed-form per-channel
  Manhattan-decay golden.
- **`light.ts` emissive-field survivors (4, all equivalent).** The optional `EmissiveField`
  (v0.7 — lava's whole tongue glows) seeds every field cell at `round(emission · color[c])`
  alongside the block emitters, before the same shared BFS. Pinned by an **empty-field identity**
  (a strict extension), an **independent re-derivation** (field seeding == placing a real
  `Block.Lava` at every flooded cell and using the block-emitter path), the dark-basin golden, and
  a **dim-field-over-emitter invariant** (max semantics — added specifically to kill the
  unconditional-overwrite mutant `light[i] < seed → true`, which was **not** equivalent). The four
  that remain are known classes, confirmed byte-identical over 5 000 random worlds × 3 channels:
  - _the zero-seed gate_ (`seed > 0` → `true` / `>= 0`): a zero seed passes the gate but
    `light[i] < 0` is unsatisfiable on a `Uint8Array`, so nothing is written or queued (the
    emitter-seed-guard class).
  - _the field-scan Y bound_ (`y < sizeY` → `<=`): the extra row's indices land past the array
    end — `field[i] === undefined ≠ 1`, a no-op (the loop-bound class). The X and Z bounds are
    **not** equivalent (their overflow _aliases into a real neighbouring cell's index_ and
    enqueues phantom coordinates) and are killed by the re-derivation — a reminder that "same
    mutant, different axis" can differ.
  - _the write compare_ (`light[i] < seed` → `<=`): at equality it rewrites the identical value
    and re-queues — it can never lower (the assignment equals the compare bound), so the fixpoint
    is unchanged (the relax-compare class).
- **`light.ts` survivors (13, all equivalent).** Block-light and skylight are the same BFS
  flood (a shared `floodLight`) whose result is a max-fixpoint, so several mutation points are
  provably output-preserving — the same classes seen above, here intrinsic to flood-fill. The
  subtler ones were confirmed equivalent empirically (identical field over hundreds–thousands of
  random worlds), not just by argument:
  - _seed/queue loop bounds_ (`y < sizeY` → `<=` ×3, and the BFS `head < qx.length` → `<=`): the
    extra iteration reads one cell out of bounds (→ Air, `emissionOf` 0, never seeded) or an
    `undefined` queue slot (`inBounds(NaN)` is false), a no-op — the mesher/persistence loop class.
  - _neighbour-offset signs_ (`x + dx` → `x − dx` ×3): `NEIGHBORS` lists every axis as both `+1`
    and `−1`, so flipping a sign visits the same six neighbours in a different pairing → the same
    field. Identical to the `chunksAffectedByEdit` symmetric-offset equivalence.
  - _the emitter seed guard_ (`emission > 0` → `true` / `>= 0`): seeds non-emitters with light `0`
    (a no-op) and queues them; the BFS re-queues any cell whenever its light actually rises, so
    pre-queuing dim cells never changes the fixpoint.
  - _the relax compare_ (`light[ni] < level − 1` → `<=`): at equality it rewrites the identical
    value and re-queues; levels strictly decrease away from sources so it still terminates with
    the same output (the `<`/`<=` redundant-guard class).
  - _the skylight column-seed start_ (`computeSkyLight`, `y = sizeY − 1` → `sizeY + 1`): the two
    extra iterations seed cells one and two rows above the world. `world.get` reads them as Air
    (so the column never breaks early), the `light[index(…)]` writes land past the `Uint8Array`
    end (ignored), and when those phantom cells are flooded every in-bounds neighbour compares
    against `light[OOB] = undefined` (`x < undefined−1` is always false), so nothing propagates —
    the real columns are seeded identically. Confirmed equivalent over 2000 random worlds (the
    loop/queue-bound class).
  - _the combined-light merge_ (`computeLight`, 2 survivors): the loop bound
    (`i < out.length` → `<=`) writes one cell past the `Uint8Array` (ignored) and reads
    `block[OOB]/sky[OOB] = undefined` (the `undefined > undefined` ternary picks the ignored
    write) — the loop-bound class; and the max select (`block[i] > sky[i]` → `>=`) differs only
    on a tie, where both branches return the **same** value, so the max is unchanged. Both
    confirmed equivalent over 100 000 random arrays.
- **`physics.ts` survivor (1, equivalent).** `moveAndCollide`'s onGround guard
  (`delta[1] < 0` → `<= 0`) differs only when `delta[1] === 0` _and_ the Y move collides — but
  a zero vertical move from a non-embedded start never newly intersects, so the guard's `<`/`<=`
  boundary is unreachable (the measure-zero / unreachable-guard class). The `submersion` function
  added for swim physics is **fully killed** — its degenerate-box guard and out-of-world dryness are
  pinned by explicit edge cases, the overlap by the 1D-depth re-derivation and the 3D golden.
- **`persistence.ts` survivors (6, all equivalent).** Two classes, both already seen elsewhere:
  the **run-extension loop bound** in `encodeWorld` (`j < data.length` → `j <= data.length` / the
  whole condition → `true`) is redundant with the inner `data[j] === value` guard — an
  out-of-bounds read is `undefined`, which is never equal to the byte `value`, so the loop stops
  in the same place (same class as the mesher loop bounds); the two **base64 loop bounds** behave
  identically (an extra iteration sees an empty slice → appends nothing, or writes past the
  Uint8Array → ignored); and two **error-message strings** (`decodeWorld`'s version/coverage
  `RangeError` text) are not behaviour, like the `world.ts` constructor messages. The two checks
  that _do_ carry weight — the version guard and the exact `Σruns === volume` coverage check — are
  killed by the round-trip census and the malformed-input tests. (The earlier `decodeWorld`
  length/overflow guards were _removed_, not documented: they were fully backstopped by DataView's
  bounds-checking and the coverage check, so no test could kill them — a redundant line, not an
  oracle gap.)
- **`water.ts` survivors (6, all equivalent).** Water is a binary flood fill (the Classic model):
  a non-solid cell is water iff reachable from a `Block.Water` source by sideways/downward steps,
  never up. Pinned by an **independent reachability relaxation** (Gauss–Seidel == the BFS), the
  **fixpoint** condition itself, an **inflow-witness** invariant (every non-source drop has water
  above or a horizontal water neighbour — never rises), a **damming** metamorphic, gap-filling /
  waterfall / never-rises goldens, and a seeded-terrain golden. All six survivors are in classes
  already seen elsewhere, output-preserving:
  - _seed + flood loop bounds_ (`y/z/x < size` → `<=` ×3, and the flood `head < qx.length` → `<=`):
    the extra iteration reads one cell out of bounds (→ Air, not a `Water` source) or an `undefined`
    queue slot (`inBounds(NaN)` is false), a no-op — the shared loop-bound class.
  - _horizontal flood-offset signs_ (`x + dx` → `x − dx`, `z + dz` → `z − dz`): `FLOW` lists each
    horizontal axis as both `+1` and `−1`, so flipping a sign visits the same neighbours in a
    different order → the same field (the symmetric-offset class). Note the **down step is not
    symmetric** — `FLOW` has only `[0, −1, 0]` — so the `y + dy` → `y − dy` mutant would flow water
    _up_ and is **killed** by the never-rises invariant and the relaxation, confirming the oracle's
    directional strength.
- **`lava.ts` survivors (9, all equivalent).** Lava is a **bounded** flood fill: a per-cell
  budget max-fixpoint (sources hold `LAVA_RANGE + 1`; a horizontal step costs 1, a down step is
  free, never up; presence = budget > 0). Pinned by an **independent budget relaxation**
  (Gauss–Seidel == the BFS), a **subset differential vs `computeWater`** (bounded ⊆ unbounded from
  the same sources — water.ts shares no code with lava.ts), an **inflow-witness** invariant, the
  **radius-3 diamond golden** (molten at Manhattan 3, dry at 4 — the boundary pinned on both
  sides), a **deep-shaft golden** (a fall costs no budget), a damming metamorphic, and determinism.
  All nine survivors are in classes already documented elsewhere — confirmed **byte-identical over
  20 000 random worlds**, each mutant in isolation:
  - _seed + presence loop bounds_ (`y/z/x < size` → `<=` ×3, and the presence `i < lava.length` →
    `<=`): the extra iteration reads one cell out of bounds (→ Air, never a `Lava` source) or
    reads `budget[length] === undefined` (`undefined > 0` is false) and writes past the
    `Uint8Array` end (ignored) — the shared loop-bound class.
  - _the flood queue bound_ (`head < qx.length` → `<=`): the extra iteration reads `undefined`
    coordinates; the budget guard compares `undefined < 1` (false, so it falls through) and
    `inBounds(NaN)` rejects every step — a no-op, the queue-bound class.
  - _the zero-budget guard_ (`nb < 1` → `false`): redundant with the write compare — a candidate
    of 0 can never beat a stored budget (`budget[ni] < 0` is unsatisfiable on a `Uint8Array`), so
    removing the early return changes nothing (the redundant-guard class).
  - _the write compare_ (`budget[ni] < nb` → `<=`): at equality it rewrites the identical value
    and re-queues; the assignment equals the compare bound so it can never _lower_ a budget, and
    the extra wavefronts die out — same fixpoint (the `<`/`<=` relax-compare class, as in
    light.ts).
  - _horizontal flood-offset signs_ (`x + dx` → `x − dx`, `z + dz` → `z − dz`): `HORIZONTAL`
    lists each axis as both `+1` and `−1`, so flipping a sign visits the same neighbours in a
    different order → the same max-fixpoint (the symmetric-offset class). The **down step is not
    symmetric** — the `y − 1` → `y + 1` mutant would flow lava _up_ and is **killed** by the
    never-rises/inflow-witness oracles, and the budget mutants that _move the boundary_ (seed
    `RANGE + 1`, the `b − 1` charge) are killed by the diamond golden — confirming the oracle's
    directional and metric strength.
- **`gravity.ts` survivors (5, all equivalent).** `settle` drops loose blocks (Sand/Gravel)
  straight down onto support, per column. Pinned by a **per-id conservation census**, a
  **no-floating** invariant, **per-column conservation** (no sideways flow), **idempotence**, a
  **column-independence** differential (whole-world settle == settling each column alone), a
  fixed-blocks-unmoved census, and drop/pile goldens. All five survivors are `<` → `<=` loop bounds
  in classes already seen — confirmed **byte-identical over 20 000 random worlds** with all five
  applied at once:
  - _the column + scan loop bounds_ (`z/x < size` → `<=` ×2, `y < sizeY` → `<=`): the extra
    iteration reads a column/cell one past the edge — `world.get` returns `Air` (never falling,
    never a support, so `pile` stays empty and nothing flushes) and any `world.set` lands out of
    bounds and is ignored. A no-op — the shared loop-bound class.
  - _the two pile-flush bounds_ (`i < pile.length` → `<=`, at the mid-column flush and the final
    flush): the extra `i = pile.length` reads `pile[length] === undefined`, and `world.set(…,
undefined)` coerces to `0` = Air — written either to a cell that is already Air (above the pile)
    or to the support cell that is immediately overwritten by the fixed block one line later, or out
    of bounds (ignored). No observable change — the array-index-past-end / coerced-write class.

`raycast.ts` used to sit lowest (~84%) precisely because DDA traversal has many
degenerate-input guards. The ones that encode a _choice_ (tie-break order, inclusive reach,
the entry guards) are now pinned with explicit golden cases, lifting it to ~92%; the
remainder above are the survivors that no test can kill because nothing observes them.

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
Current state: **15/16 modules paired**. The one exception is `src/main.ts` — the browser
entry shell (DOM, WebGL, the frame loop) which can't be imported in Node. It is covered by
the **smoke test** (`scripts/smoke.mjs`) instead: a headless Chromium run that boots the game,
asserts no console/page errors, that the frame loop ran (HUD shows coordinates), that the
player resolved onto the ground, and that the hotbar built.

### The render check is a falsifiable oracle, not a byte-size heuristic

The smoke test's hardest job is proving the WebGL canvas _actually drew the world_ — the
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
   the table above. Prefer an _independent_ re-derivation or a census over re-stating the
   implementation.
3. `npm test` — make it green.
4. `npm run mutation` — **watch it fail**. Every survivor is a missing check. Add an
   assertion that kills it, or document it as equivalent with a reason.
5. If you mutate files outside `src/core`/`src/game`, add the path to `mutate` in
   `stryker.config.json`.

> Rule of thumb: if you can delete a line of the source and the suite stays green, you don't
> have an oracle for that line yet.

## Where the falsifiability gate runs: locally, via a pre-push hook

The mutation test is the slowest check (minutes, and **9–23 min on shared CI runners** — the
score is deterministic, the wall-clock is not). So it is **not** a CI/PR gate. It runs
**locally**, as a git `pre-push` hook, before the code ever reaches a PR:

```bash
npm run hooks:install   # once per clone — points core.hooksPath at scripts/hooks
```

`scripts/hooks/pre-push` then runs **`npm run mutation:clean`** before any push whose commits
touch code/test/build inputs (`src/`, `test/`, `scripts/`, the lockfile/manifest, the
`*.config.*` / `tsconfig`, `index.html`, or `ci.yml`) and **aborts the push** if the score
drops below the break threshold (70) or a new mutant survives. Docs-only pushes skip it; bypass
a single push with `SKIP_MUTATION=1 git push` (use sparingly — that is the whole guarantee).

So the loop is: write an oracle → `npm test` (green) → **`git push`** (the hook runs the
falsifiability gate locally) → fix any survivor → push again. Same gate as before, off the
critical path of every PR.

### What CI still does

| Check                           | When                       | Gate?                    |
| ------------------------------- | -------------------------- | ------------------------ |
| `typecheck · test · build`      | every PR + push to `main`  | **required**             |
| `lint (eslint · prettier)`      | every PR + push to `main`  | **required**             |
| `smoke (headless render check)` | every PR + push to `main`¹ | **required**             |
| `mutation badge`                | release published · manual | no — refreshes the badge |

¹ **smoke** only does real work when the change touches code/build inputs (an inline `git diff`
step); a docs/config-only change skips the expensive steps but the job still reports SUCCESS, so
the required check stays green (skip the steps, not the job). It stays a required PR gate — it is
the only place WebGL rendering is verified (a missing geometry upload would clear the canvas to
bare sky). **Mutation is not in this set**: the falsifiability gate runs locally (the pre-push
hook), and the `mutation badge` workflow runs only on a published release or manual dispatch —
so **merging a PR never triggers the slow mutation run**, which is the whole point of this split.
