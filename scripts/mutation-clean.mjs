#!/usr/bin/env node
// `npm run mutation:clean` — run StrykerJS with a guaranteed-fresh result.
//
// stryker.config.json sets "incremental": true so iterative reruns are fast, but
// the incremental cache (reports/stryker-incremental.json) plus the sandbox
// (.stryker-tmp) make a second back-to-back `npm run mutation` reuse cached mutant
// verdicts and overwrite reports/mutation/mutation.json with them. A mutant you
// just killed can then show as Survived (and vice versa) — see issue #12. The
// Stryker CLI in this version accepts no `--incremental false` / `--no-incremental`
// override, so the only honest path is to delete the cache + sandbox first.
//
// This wrapper wipes both, then runs Stryker once, so the reported score reflects
// the current source. Use it whenever you need an authoritative local number;
// `npm run mutation` stays the fast incremental path for tight iteration.
import { rmSync } from "node:fs";
import { spawnSync } from "node:child_process";

for (const path of ["reports/stryker-incremental.json", ".stryker-tmp"]) {
  rmSync(path, { recursive: true, force: true });
}

// Invoked from an npm script, so node_modules/.bin is on PATH; shell:true also
// lets Windows resolve the stryker shim. Propagate Stryker's exit code (the
// break-threshold gate) so `mutation:clean` fails CI/locally exactly as `mutation`.
const result = spawnSync("stryker", ["run"], { stdio: "inherit", shell: true });
process.exit(result.status ?? 1);
