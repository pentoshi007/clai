# Phase 0 evidence bundle

Baseline and quality foundation. Every record below was produced by running the
stated command in this checkout; no result is inferred.

## Anchor

| Field | Value |
|---|---|
| branch | `refactor/codebase` |
| commit at Phase 0 start | `dbec94ba7ca093865a4945e5a323344343b863b8` |
| OS / architecture | Linux 6.17.0-1020-oracle aarch64 |
| Node / npm | v24.19.0 / 11.17.0 |
| host locale | `LANG=en_IN.UTF-8` (`LC_ALL`, `TZ` unset) |
| canonical environment | `LANG=C LC_ALL=C LC_COLLATE=C LC_NUMERIC=C LC_TIME=C TZ=UTC` |

## Artifacts

| Artifact | Path |
|---|---|
| metric specification | [`refactor/quality-metrics.md`](../../quality-metrics.md) |
| warning ledger | [`warning-ledger.md`](warning-ledger.md) |
| public-contract inventory | [`public-contracts.json`](public-contracts.json) |
| metrics ratchet baseline | [`baselines/metrics-baseline.json`](baselines/metrics-baseline.json) |
| metrics report | [`reports/metrics.json`](reports/metrics.json) |
| type-syntax findings | [`reports/type-syntax.json`](reports/type-syntax.json) |
| human summary | [`reports/summary.md`](reports/summary.md) |
| duplication report | [`reports/duplication/jscpd-report.json`](reports/duplication/jscpd-report.json) |

---

## E-01 · `TZ=UTC` equivalence proof

Required before UTC could become canonical.

```text
phase/task: P0-01
git commit and branch: dbec94ba7ca093865a4945e5a323344343b863b8 / refactor/codebase
environment: Linux aarch64, Node v24.19.0
command: LC_ALL=C LANG=C npm test -- --reporter=dot        (recorded baseline)
         LC_ALL=C LANG=C TZ=UTC npm test -- --reporter=dot (candidate)
exit status: 0 / 0
result counts: 557 files passed; 5,695 passed, 12 skipped (5,707) — identical in both runs
report/artifact path: refactor/baseline.md §3; this record
expected warnings/skips: W-01, W-02, W-03, W-04 (warning-ledger.md)
changed public contracts: none
rollback boundary: n/a (measurement only)
```

Conclusion: adding `TZ=UTC` does not alter any contract, so it is included in the
canonical environment.

## E-02 · Deterministic execution wrapper

```text
phase/task: P0-01
command: node scripts/run-tests.mjs --print-env
exit status: 0
result: LANG=C LC_ALL=C LC_COLLATE=C LC_NUMERIC=C LC_TIME=C TZ=UTC

command: node scripts/run-tests.mjs --host --print-env
exit status: 0
result: host environment (locale and timezone inherited)

command: npm run test:deterministic -- --reporter=dot
exit status: 0
result counts: 561 files passed; 5,758 passed, 12 skipped (5,770); 231.16 s

command: npm run test:host -- test/architecture test/environment test/quality --reporter=dot
exit status: 0
result counts: 4 files passed; 57 passed  (host LANG=en_IN.UTF-8)
changed public contracts: none
rollback boundary: scripts/run-tests.mjs + the two package.json scripts
```

The 561/5,758 figures are the recorded 557/5,695 baseline plus the four
characterization and analyzer test files added by this phase (13 environment + 11 contracts + 39 quality analyzers/ratchet = 63 tests).
No pre-existing test changed state.

Design notes:

- locale and timezone are applied to the **child** process environment, so ICU
  and the default timezone are fixed before the test process starts;
- inherited `LANGUAGE`, `LC_CTYPE`, `LC_MESSAGES` and friends are deleted rather
  than overridden, because ICU still honors them when `LC_ALL` is set;
- the wrapper spawns Vitest through `process.execPath`, so the same command works
  on Windows `cmd.exe`/PowerShell where `VAR=value cmd` syntax does not;
- `--host` retains a direct host-environment path so canonicalization cannot
  conceal accidental locale coupling. CI runs both.

## E-03 · Locale / timezone characterization

```text
phase/task: P0-02
command: npm run test:deterministic -- test/environment --reporter=dot
exit status: 0
result counts: 1 file passed; 13 passed
report/artifact path: test/environment/locale-timezone.test.ts, test/environment/locale-probe.ts
changed public contracts: none
rollback boundary: test/environment/
```

Measured through child processes driving real production surfaces
(`StreamRenderer`, `fsList`, `formatTokenCount`):

| Observation | canonical (`C`/`UTC`) | `en_IN.utf8` / `Asia/Kolkata` |
|---|---|---|
| resolved ICU number locale | `en-US` | `en-IN` |
| `(120000).toLocaleString()` | `120,000` | `1,20,000` |
| noninteractive compaction line | `✦ compacting context · ~120,000 tokens before` | `… ~1,20,000 …` |
| `formatTokenCount(120000)` (pins `en-US`) | `120,000` | `120,000` |
| `fsList` order | `.hidden, dirA, item1.txt, item2.txt, Item3.txt, item10.txt` | identical |
| ISO timestamp collation (job order) | ascending, stable | identical |
| `2026-02-28T23:30Z` local day / hour | 28 / 23 | 1 / 5 (offset −330) |

Findings recorded, deliberately **not** fixed in Phase 0:

1. `LC_ALL=C` does **not** select byte semantics inside Node's ICU; it falls back
   to `en-US`. Group separators therefore exist under the canonical environment,
   which the suite's expectations depend on.
2. The two recorded baseline failures on an `en_IN` host come from unqualified
   `toLocaleString()` calls in `src/noninteractive/stream-blocks.ts`. Changing
   that formatting is a separately approved behavior change.
3. `fs.list` and job ordering are **not** locale-sensitive at this anchor:
   numeric-aware ICU collation and ISO-8601 comparison agree across both locales.
4. Timezone changes the local calendar day of a late-UTC instant while the ISO
   serialization and epoch value are unchanged — which is why `TZ` is pinned.

## E-04 · Public contract inventory

```text
phase/task: P0-03
command: node scripts/quality/contract-inventory.mjs --write
         npm run quality:contracts
         npm run test:deterministic -- test/contracts --reporter=dot
exit status: 0 / 0 / 0
result counts: 20 modules, 405 exports inventoried; 1 file passed, 11 tests passed
report/artifact path: refactor/evidence/phase-0/public-contracts.json,
                      test/contracts/__snapshots__/public-contracts.test.ts.snap
changed public contracts: none
rollback boundary: scripts/quality/contract-inventory.mjs + test/contracts/
```

Coverage of the hard gate required before Phase 1:

- `runAgentLoop` — `(prompt: string, options?: AgentRunOptions) => Promise<string>`
- `runAgentTurn` — `(prompt: string, options?: AgentRunOptions) => Promise<TurnOutcome>`
- every runner export is asserted present at runtime;
- `test/agent/runner-no-direct-writes.test.ts` (pre-existing) remains green in the
  full-suite run above, protecting the no-direct-write policy.

Runtime aggregates additionally frozen by snapshot: tool name/wire-name order,
per-tool parameter property order plus `mutates`/`readOnly`/`askMode` flags, the
four special-purpose tool-name sets, the slash-command catalog with usage
strings, and the 19 built-in provider ids in declaration order.

The comparator is proved to fail: a synthetic mutation of the inventory produces
`removed export`, `added export` and `changed type` differences.

## E-05 · Pinned quality toolchain and compatibility spikes

```text
phase/task: P0-04
command: npm install --save-exact --save-dev --ignore-scripts --no-audit --no-fund \
           @vitest/coverage-v8@4.1.10 knip@6.33.0 jscpd@5.0.16 \
           @stryker-mutator/core@10.0.0 @stryker-mutator/vitest-runner@10.0.0
exit status: 0
verification: every dependency in package.json is an exact version — no ^, ~, *, or tag
              npm ci --ignore-scripts --no-audit --no-fund → clean install
              npm run release:verify → "exact dependencies and synchronized lockfile"
changed public contracts: none
rollback boundary: package.json + package-lock.json (revertible per tool)
```

`jscpd@5.1.0` was rejected during the final clean-install check because it
specified the unpublished optional package
`jscpd-windows-arm64-msvc@5.0.16`; npm 11 therefore could not produce a
self-consistent cross-platform lockfile. The exact pin was corrected to
`5.0.16`, whose published optional dependency set is complete. The 5.1.0
wrapper already delegated this host to the 5.0.16 native engine, so the
compatibility and duplication results were reproduced without metric changes.

| Capability | Spike command | Result |
|---|---|---|
| coverage (V8) | `node scripts/run-tests.mjs test/loop-guard-read-ranges.test.ts --coverage` | 501/55,385 statements recorded; join produced real CRAP values (e.g. `LoopGuard.recordPollObservation` cov 0.1667, cyc 5, CRAP 19.47) |
| duplication (`.ts` + `.tsx`) | `npx jscpd src/ui-core src/tui-v2 --reporters json,consoleFull` | 158 files (122 ts / 36 tsx), 14 clones, 1.70% duplicated lines, 78 ms |
| dead code (`.ts` + `.tsx`) | `npx knip --reporter json --no-exit-code` | 13 unused files, 360 unused exports, 187 unused types, 2 unlisted, 7 unresolved, 1 duplicate |
| mutation (bounded) | `npx stryker run` on `src/llm/reasoning-marker.ts` | 11 mutants: 4 killed, 1 survived, 6 no-coverage; 12 s |
| complexity / Halstead / type-syntax (`.ts` + `.tsx`) | `npm run quality:report` + `test/quality/analyzers.test.ts` | 630 files, 9,039 functions in 4.4 s; 20 synthetic assertions incl. a `.tsx` component |

Recorded tool constraints:

- **Stryker + `process.chdir()`** — Stryker's Vitest runner executes tests in
  worker threads, where Node forbids `process.chdir()`. An unbounded dry run
  aborts with `process.chdir() is not supported in workers` before any mutant
  runs. This is a runner limitation, not a product defect: the same suites pass
  in the normal fork-based run. Mutation is therefore bounded by module via
  `vitest.mutation.config.ts` (`CLAI_MUTATION_TESTS` narrows the test scope),
  which is also what the phase plan requires during Phases 1-7.
- **Stryker sandboxes** — `.stryker-tmp/sandbox-*` contains full repository
  copies and can survive an aborted run. Vitest discovered the duplicates and
  `npm run test:arch` reported 4 files / 20 tests instead of 1 / 5. Fixed by
  excluding `**/.stryker-tmp/**` in `vitest.config.ts` and git-ignoring the
  directory; `npm run test:arch` is back to exactly 1 file / 5 tests.
- **Version manifests** — several analyzers restrict `exports`, so the report
  reads their `package.json` from disk. Recorded versions: TypeScript 6.0.3,
  Vitest 4.1.10, coverage-v8 4.1.10, knip 6.33.0, jscpd 5.0.16, Stryker 10.0.0.

## E-06 · Metric definitions

```text
phase/task: P0-05
artifact: refactor/quality-metrics.md (prose) + scripts/quality/config.mjs (machine)
verification: npm run test:deterministic -- test/quality --reporter=dot → 2 files, 39 tests passed
```

Defines scope and exclusions, the physical-line algorithm (blank and comment
lines count; strictly `<500`, Classic `<=400`), the function-like constructs each
metric counts, the cyclomatic/cognitive/Halstead formulas, the CRAP formula and
its exact coverage component, the coverage merge strategy across platform jobs,
failing mutation statuses, duplication thresholds, dead-code entrypoints, the
three-way `unknown` classification, report paths, schema version and comparison
rules, plus runtime budgets and timeout behavior.

Every formula is asserted against a hand-computed fixture, including CRAP
(`10² × 0.5³ + 10 = 22.5`) and Halstead difficulty `D = (n1/2) × (N2/n2)`.

## E-07 · Baselines from the green anchor

```text
phase/task: P0-06
command: npm run quality:report
         npm run quality:ratchet   (first run creates the baseline)
exit status: 0 / 0
result counts: measured=true, 630 files, 9,039 functions, 4.4 s
report/artifact path: reports/metrics.json, baselines/metrics-baseline.json
determinism: two consecutive runs produced byte-identical reports apart from durationMs
```

Legacy debt recorded at the anchor (report-only, drives the ratchet):

| Metric | Findings | Max observed | Terminal limit |
|---|---|---|---|
| files at/over line limit | 81 | 6,769 (`src/agent/runner.ts`) | `<500` (Classic `<400`) |
| cyclomatic `>=22` | 154 | 456 | `<22` |
| cognitive `>=22` | 322 | 3,197 | `<22` |
| Halstead difficulty `>=80` | 15 | 169.75 | `<80` |

Type-syntax classification: explicit `any` 40; `unknown` boundary-valid 433,
narrowing-required 224, internal 286 (943 total); double assertions 28; broad
casts 5; suppressions 5.

Raw `unknown` is classified rather than treated as an automatic defect: the 433
boundary-valid occurrences are explicitly **not** ratcheted. Classification is
positional, not name-based — see E-11 finding 2 and
[quality-metrics.md](../../quality-metrics.md#unknown-is-classified-by-syntactic-position-never-by-name).
The `explicitAny` and `broadCast` categories overlap by design and must not be
summed; the three `unknown` categories are a partition.

This replaces the temporary `/tmp/clai-refactor-metrics.json` audit data with a
reproducible command and a committed report.

## E-08 · Monotonic ratchets

```text
phase/task: P0-07
command: npm run quality:ratchet
exit status: 0
result: 572 legacy finding(s) held, 0 improvement(s), 0 regression(s)
command: npm run test:deterministic -- test/quality --reporter=dot
exit status: 0
result counts: 2 files passed; 39 tests passed
```

Proved by synthetic fixtures that the comparator **fails** on: a newly oversized
file; a new cyclomatic, cognitive or Halstead violation; a raised maximum; an
increase in any gated type-syntax category; a loosened limit; and a missing
metric. Proved that it **passes** while legacy debt is held, reports resolved
findings and lowered maxima as improvements, and still fails a mixed change that
regresses one metric while improving another. Boundary-valid `unknown` may
increase without failing.

`--write-baseline` refuses to write unless something improved, so a baseline
cannot be raised to make a change pass. `test/architecture/legacy-baseline.json`
was not modified and remains remove-only.

## E-09 · Warning register

```text
phase/task: P0-08
artifact: warning-ledger.md
```

Five classes recorded: W-01 keychain-unavailable fallback (environment), W-02
provider temperature omission (contract, assertion in `src/llm/request-plan.ts`
tests), W-03 nested `vi.mock` hoisting in
`test/context/request-accounting.test.ts` (debt, owner Phase 2, will become a
hard error in a future Vitest release), W-04 the 12 platform/capability skips
(environment, each with a stated reason), W-05 analyzer console noise
(environment).

## E-10 · Phase 0 validation matrix

All commands run in this checkout, in this order:

| Command | Exit | Result |
|---|---|---|
| `npm ci --ignore-scripts --no-audit --no-fund` | 0 | dependencies restored from the lockfile |
| `npm run typecheck` | 0 | no diagnostics |
| `npm run embed-prompts:check` | 0 | embedded prompts match their sources (2 prompts) |
| `npm run test:arch -- --reporter=dot` | 0 | 1 file, 5 tests passed |
| `npm run test:deterministic -- --reporter=dot` | 0 | 561 files, 5,758 passed, 12 skipped, 231.16 s |
| `npm run test:host -- test/architecture test/environment test/quality --reporter=dot` | 0 | 4 files, 57 passed |
| `npm run build` | 0 | prompts embedded, `dist` rebuilt |
| `npm run release:verify` | 0 | exact dependencies and synchronized lockfile for 4.11.2 |
| `npm run quality:contracts` | 0 | public contracts unchanged |
| `npm run quality:report` | 0 | measured=true, 630 files, 9,039 functions |
| `npm run quality:ratchet` | 0 | 572 held, 0 regressions |
| `git diff --check` | 0 | no whitespace errors |

CI wiring: the Node 22/24 semantic matrix now runs `test:deterministic`, the
host-path guard, `quality:contracts`, `quality:report` and `quality:ratchet`, and
uploads the report directory on failure.

## Out of local scope (never claimed as passed)

This Linux/Node 24 host cannot exercise the following, so they remain
**unverified** rather than passed. They are documented gaps and do not gate phase
closure:

- Node 22 semantic suite (this host runs Node 24 only);
- Bun 1.3.14 OpenTUI conformance (`npm run test:bun`);
- macOS and Windows process/privilege jobs, Windows Terminal / PowerShell /
  cmd.exe / ConPTY behavior, and Windows-binary runtime;
- macOS Classic POSIX PTY job (`npm run test:classic:pty` on macOS);
- OS keychain success paths (macOS Keychain, Windows Credential Manager);
- release verification of published artifacts from a trusted host.

## E-11 · Independent audit and remediation

An independent auditor reviewed this phase against `instructions.md` and
`plan/phase-0.md` with read-only access, reproduced the validation matrix, and
verified every documented number. Criteria 2-8 passed on re-run
(`quality:report` → identical 630 / 9,039 / 81 / 154 / 322 / 15 / 40;
`quality:ratchet` → 572 held; `test:arch` → 1 file / 5 tests; report byte-identical
across runs apart from `durationMs`). The auditor independently recomputed
cyclomatic values for `src/llm/reasoning-marker.ts` by hand
(`wrapReasoning` 1, `hasReasoningMarker` 2, `stripReasoningMarkers` 3) and
confirmed they match `reports/metrics.json`, and confirmed nothing
host-limited is over-claimed.

Three defects were found and fixed:

### Finding 1 — gates could not fail on a fresh checkout (blocker, fixed)

`quality:ratchet` created its baseline from the current tree when the file was
absent and exited 0. On a fresh CI checkout that adopts whatever state exists —
including a regression — so the CI step could never fail. `quality:contracts`
had the mirror-image defect: it crashed with `ENOENT` instead of reporting a
missing inventory.

Both now exit 1 with the deliberate creation command. Baseline creation moved to
an explicit `--init` that refuses to overwrite an existing baseline.

```text
command: mv baselines/metrics-baseline.json /tmp; node scripts/quality/ratchet.mjs
exit status: 1
stderr: quality:ratchet: missing baseline … The baseline must be committed for
        this gate to mean anything. Create it deliberately with: --init

command: mv public-contracts.json /tmp; node scripts/quality/contract-inventory.mjs --check
exit status: 1
stderr: contract-inventory: missing baseline … It must be committed.

command: (both restored) node scripts/quality/contract-inventory.mjs --check
exit status: 0 → public contracts unchanged
```

### Finding 2 — `unknown` classifier was name-gameable (major, fixed)

The boundary classifier matched identifier names against a hint list
(`payload`, `result`, `value`, …). The auditor showed that
`const cachedResult: unknown` and `const resultValue: unknown` were classified
`unknownBoundary`, which is **not** ratcheted — so internal imprecision could
escape the Phase 7 gate purely by being named well.

The name heuristic was removed. Classification is now purely syntactic: catch
bindings and decode-target shapes (`Record<string, unknown>`, `unknown[]`,
index signatures) are boundary; parameters are narrowing-required; everything
else is internal. `test/quality/analyzers.test.ts` guards the regression using
the auditor's exact identifiers.

Effect at the same anchor, with `src/` untouched (`git diff --stat -- src` empty):

| Category | before (name-based) | after (positional) |
|---|---|---|
| `unknownBoundary` (not gated) | 398 | 433 |
| `unknownNarrowing` (gated) | 37 | 224 |
| `unknownInternal` (gated) | 508 | 286 |
| total | 943 | 943 |

The ratchet detected the reclassification on real data before the baseline was
re-established — `regression: increased unknownNarrowing: 37 -> 224` alongside
`improvement: reduced unknownInternal: 508 -> 286`, exit 1 — which is independent
evidence that the gate works outside its synthetic fixtures. The baseline was then
re-initialized deliberately at the same green anchor because the **definition**
changed, not the code. Definition changes belong in Phase 0; after Phase 0 closes,
the same situation would be a regression to fix or revert.

### Finding 3 — over-broad ignore pattern (minor, fixed)

`.gitignore` contained a bare `reports/mutation/`, which matches that path at any
depth. Narrowed to `refactor/evidence/phase-0/reports/mutation/`.

### Accepted without change

- `x as any` is counted in both `explicitAny` and `broadCast`. The overlap only
  makes the ratchet stricter; it is now documented, and a test asserts it, so the
  counts are not mistaken for a partition.
- CRAP has no enforcement evidence at this anchor because coverage is not part of
  the Phase 0 CI steps. This is stated in `quality-metrics.md` and is correct:
  CRAP is a Phase 8 terminal gate, and `scope.crapMeasured` is `false` until a
  full-suite coverage run exists.

### Phase-close commit record and remaining evidence caveats

Phase 0 was split into the four reviewed local commits required by
`plan/phase-0.md`:

1. `c5e8e5b` — `test(refactor): characterize locale and public contracts`
2. `9d740d7` — `build(quality): add pinned report-only analyzers`
3. `d5b6035` — `test(quality): add monotonic baseline comparators`
4. `8157a3c` — `ci(quality): standardize deterministic test execution`

The branch is published from `refactor/codebase`. Program closure is governed by
locally reproducible evidence; there is no CI-wait gate. Node 22, Bun, macOS,
Windows, ConPTY, OS-keychain-success, and published-artifact verification cannot
run on this host, so they remain unverified and are never claimed as passed.

The final clean-install check subsequently exposed `jscpd@5.1.0`'s unpublished
optional Windows ARM64 package. The exact `5.0.16` correction and regenerated
version metadata form a separate Phase 0 tooling erratum. They are locally
validated but remain uncommitted pending explicit commit authorization; no Phase
1 production extraction may be mixed into that repair boundary.

## Public contract changes

**None.** Phase 0 added scripts, tests, configuration, reports and documentation
only. No file under `src/` was modified.

## Rollback boundaries

| Concern | Revert surface |
|---|---|
| deterministic execution | `scripts/run-tests.mjs`, the `test:deterministic`/`test:host` scripts, the CI step |
| characterization | `test/environment/` |
| contract inventory | `scripts/quality/contract-inventory.mjs`, `test/contracts/` |
| pinned analyzers | `package.json` + `package-lock.json` (each tool independently) |
| metric definitions and reports | `scripts/quality/{config,ast-metrics,type-syntax,report}.mjs`, `refactor/quality-metrics.md` |
| ratchets | `scripts/quality/ratchet.mjs`, `refactor/evidence/phase-0/baselines/`, `test/quality/` |
