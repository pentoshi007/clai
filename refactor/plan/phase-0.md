# Phase 0 — Baseline and quality foundation

Status: **complete** — evidence in [../evidence/phase-0/README.md](../evidence/phase-0/README.md)
Depends on: validated planning milestone
Blocks: nothing — Phase 1 may begin from this green anchor

## Objective

Turn the planning audit into a reproducible, evidence-based quality system before moving production behavior. Establish one canonical test environment, characterize intentional environment variation, inventory public contracts, add exact-pinned quality tooling in report-only mode, and create monotonic baselines.

Phase 0 is not a general cleanup phase. Production behavior fixes discovered here must be proposed, tested, and committed separately from quality infrastructure.

## Scope

Expected change areas:

- `package.json` and `package-lock.json` for exact-pinned quality packages/scripts;
- `vitest.config.ts`, `test/vitest.setup.ts`, and test helpers where appropriate;
- `.github/workflows/ci.yml` and trusted local wrapper scripts;
- `scripts/` for deterministic execution and machine-readable quality reports;
- `test/architecture/` for remove-only ratchet coverage, not baseline expansion;
- focused characterization tests for locale, timezone, ordering, exports, and signatures;
- `refactor/evidence/` or an equivalent checked-in schema/index for phase reports.

Out of scope:

- decomposition of production hotspots;
- broad formatting or warning cleanup;
- changing locale-sensitive product output to a preferred format;
- raising, replacing, or broadly ignoring existing architecture baselines;
- making unstable tools blocking before compatibility and runtime evidence exists.

## Entry criteria

- Planning artifacts are committed and pushed from `refactor/codebase`.
- Worktree is clean and the Git anchor is recorded.
- `npm ci` succeeds using the committed lockfile.
- The baseline in `../baseline.md` is reproducible: typecheck, prompt check, architecture tests, canonical-locale full suite, and build pass.
- The host-locale `en_IN` discrepancy is acknowledged rather than treated as a production regression.

## Workstream 1 — deterministic test execution

1. Add a cross-platform wrapper that sets canonical locale and timezone **before** starting Node. The initial candidate is `LC_ALL=C`, `LANG=C`, and `TZ=UTC` on POSIX; Windows must receive equivalent environment values through Node or CI configuration rather than shell-only syntax.
2. Prove `TZ=UTC` against the current baseline before making it canonical. If it changes expected behavior, characterize the difference and select the documented canonical zone without hiding the contract.
3. Route the default CI semantic suite and documented local full-suite command through the wrapper.
4. Keep a direct host-environment test path so canonicalization cannot conceal accidental locale/timezone coupling.
5. Record Node 22 and 24 behavior. Do not infer Bun or OS parity from Linux Node results.

### Required locale/TZ characterization

Use child processes when necessary so locale initialization occurs before module import. Cover at least:

- `120000` number/token/byte formatting under canonical and `en_IN` environments;
- `fs.list` numeric/name ordering;
- job ordering where timestamps/names use collation;
- date/time serialization and display that can cross day or zone boundaries;
- parity between app, Classic/OpenTUI semantic data, and noninteractive rendering.

If current host-sensitive formatting is deemed a defect, open a separate behavior task. Do not fix it in the wrapper or an extraction commit.

## Workstream 2 — public contract inventory

Before Phase 1, produce a deterministic inventory for the Phase 1-6 hotspots:

- exported values/types and callable signatures;
- module side effects and singleton-producing imports;
- registered tool names, schema order, command aliases, provider names, and stable aggregate ordering;
- architecture edges and current remove-only exceptions;
- generated sources/outputs and commands that synchronize them.

Prefer focused compile-time/runtime contract tests over a brittle text snapshot. Normalize paths and ordering. A changed contract must fail with a readable diff.

At minimum, hard-block Phase 1 until `runAgentLoop` and `runAgentTurn` signatures, runner exports, request fingerprints, and runner direct-write policy are protected.

## Workstream 3 — exact-pinned quality tooling

Introduce tools in separate, behavior-neutral commits. Each package must use an exact version in `package.json` and the lockfile; tags and open ranges are forbidden.

Required capabilities:

1. V8 coverage integrated with Vitest. At the anchor, `@vitest/coverage-v8` must match Vitest `4.1.10` exactly unless both are upgraded in an independently validated tooling commit.
2. TypeScript/TSX-aware cyclomatic, cognitive, and Halstead reporting with stable function attribution.
3. CRAP calculation tied to the chosen cyclomatic and coverage data.
4. Mutation testing compatible with Vitest, TypeScript ESM, and bounded module selection.
5. Dead file/export/dependency detection.
6. Duplicate/clone detection with token-aware TypeScript support.
7. A repository-owned type-syntax report for explicit `any`, boundary/internal `unknown`, double assertions, broad casts, and suppression markers.
8. A physical-line report that recognizes generated and behavior-bearing exemptions.

For each capability:

- run a compatibility spike on representative `.ts` and `.tsx` files;
- pin and print the tool version in reports;
- emit JSON plus a concise human summary;
- define deterministic ordering and exit statuses;
- establish a runtime budget and timeout behavior;
- run report-only first;
- prove that a synthetic regression is detected before enabling blocking mode.

Do not send repository content or reports to external services.

## Workstream 4 — metric definitions and scope

Commit one reviewed specification/configuration that defines:

- production source globs and test scope;
- generated exclusions (`src/prompts/embedded.ts`, `src/version.generated.ts`) and why;
- treatment of prompt Markdown, fixtures, snapshots, declaration/type-only code, scripts, and platform-only branches;
- physical line-count algorithm, including blank/comment lines, with the terminal comparator defined as strictly fewer than 500 lines;
- function-like constructs counted by each complexity metric;
- CRAP formula and the exact coverage component used;
- coverage merge strategy across Node/Bun/OS jobs;
- mutation statuses considered failing (`survived` and `no coverage` at minimum);
- duplicate thresholds and what “redundant code zero” adds beyond clone detection;
- dead-code entrypoint/project configuration;
- how valid boundary `unknown` is classified and narrowed;
- report paths, schema versions, baseline format, and comparison rules.

No terminal gate can be claimed until its analyzer reports `measured: true` under this definition.

## Workstream 5 — baselines and ratchets

1. Run every analyzer at the same green Git anchor.
2. Store a sorted, machine-readable baseline or immutable report reference with environment and tool versions.
3. Keep existing legacy findings visible. Initial reports may be non-blocking, but new findings, raised maxima, and increased counts fail immediately once comparator stability is proven.
4. Require new files and reliably attributable changed functions to meet terminal limits.
5. Ratchet values only downward. A baseline increase requires stopping the refactor and fixing or reverting the regression; it is not an approval workflow.
6. Keep `test/architecture/legacy-baseline.json` remove-only.
7. Replace the temporary `/tmp/clai-refactor-metrics.json` audit with the reproducible command; do not copy an opaque temporary report and call it a gate.

## Workstream 6 — warnings and evidence

Classify baseline warnings:

- expected contract warning with an assertion;
- environment-only warning with documented prerequisites;
- actionable debt with owner, target phase, and removal condition.

Create the phase evidence format from `../instructions.md`. Evidence must include commit, branch, environment, command, exit status, counts, reports, warnings/skips, public-contract change, rollback boundary, and review.

## Acceptance criteria

- [x] One canonical full-suite command works locally with locale/TZ set before Node starts.
- [x] Locale/TZ/ordering tests preserve and explain both canonical and supported host-sensitive behavior.
- [x] Export/signature/registration inventories protect all Phase 1-6 hotspots; runner contracts are a hard gate.
- [x] Every quality dependency is exact-pinned and lockfile-backed.
- [x] Every requested metric has a reviewed definition and deterministic report, even if initially report-only.
- [x] New/regressed findings fail; legacy baselines can only hold or improve.
- [x] Raw `unknown` is classified rather than treated as an automatic defect.
- [x] Synthetic failing fixtures prove each comparator/gate.
- [x] No generated output was hand-edited and no production behavior was silently changed.
- [x] Phase validation is green and the evidence bundle is independently reviewed.

## Validation

Run after each tooling seam and at phase close:

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run typecheck
npm run embed-prompts:check
npm run test:arch -- --reporter=dot
# New canonical wrapper/script created by this phase
npm run test:deterministic -- --reporter=dot
npm run build
npm run quality:report
npm run quality:ratchet
git diff --check
```

Names such as `test:deterministic`, `quality:report`, and `quality:ratchet` are intended stable outcomes; choose final script names once and document them. Also run the locale/TZ child-process tests directly and the Node 22/24 CI jobs.

## Commit and rollback plan

Recommended boundaries:

1. `test(refactor): characterize locale and public contracts`
2. `build(quality): add pinned report-only analyzers`
3. `test(quality): add monotonic baseline comparators`
4. `ci(quality): standardize deterministic test execution`

No commit should combine all four concerns. Revert a tool independently if it is unstable; retain valid characterization tests. Phase 1 starts only from the reviewed green phase-close commit.
