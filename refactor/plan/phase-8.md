# Phase 8 — Terminal quality and platform closure

Status: **planned**
Depends on: Phase 7 complete
Scope: repository-wide quality evidence and complete supported-platform/release verification

## Objective

Close every remaining measured quality gate and prove the behavior-preserving refactor across the full CI, runtime, package, and platform matrix. This phase does not declare success until all metrics are measured and terminal thresholds pass.

## Entry criteria

- Every ordinary production file is `<500` and every function meets the complexity/Halstead thresholds.
- Explicit `any`, unsafe/unjustified `unknown`, unsafe casts, unresolved suppressions, architecture debt, and comment-review backlog are zero.
- Coverage, CRAP, mutation, dead-code, and duplication tools are exact-pinned, stable, and already running as monotonic ratchets.
- Canonical full suite, build, architecture, conformance, and admission checks are green at the Phase 7 anchor.
- All Phase 1-7 evidence bundles are reviewed and linked from the task ledger.

## Validation prerequisites

The `test:deterministic` and `quality:*` scripts used in this phase are Phase 0 deliverables; use the final names recorded by Phase 0. All must exist and be blocking before terminal closure.

## Workstream 1 — 100% coverage

Reach 100% statements, branches, functions, and lines for the production scope defined in Phase 0.

Rules:

- Add behavior-focused tests, not assertions that merely execute lines.
- Exercise error, cancellation, retry, boundary, recovery, redaction, and terminal paths.
- Merge coverage from required Node/Bun/OS jobs for genuinely platform-specific branches.
- Generated outputs and non-executable contractual fixtures may remain outside production scope only under the reviewed Phase 0 definition.
- Do not add blanket ignore comments, exclude difficult modules, or mark unreachable code without proof. Delete truly unreachable production code and rerun dead-code/mutation analysis.
- A rounded display of `100%` is insufficient; raw counters must show zero uncovered items.

## Workstream 2 — CRAP `<25`

For every measured function, compute CRAP using the Phase 0 formula and merged coverage input. Because coverage is 100%, remaining failures should identify excessive structural complexity or a scope/formula defect. Refactor with characterization; do not game function boundaries with meaningless wrappers.

Acceptance is a maximum strictly below 25 with no unmeasured function in production scope.

## Workstream 3 — zero surviving mutants

Run mutation testing in escalating scopes:

1. changed/target module during each closure commit;
2. package/layer partitions in parallel;
3. full production scope at phase close.

Required result:

- zero `Survived` mutants;
- zero `NoCoverage` mutants;
- zero unresolved timeout/error mutants;
- no disabled mutator/operator solely to improve the score.

A proven equivalent mutant requires a narrow, reviewed suppression tied to exact code and rationale, plus an attempt to remove/refactor the equivalent construct. Equivalent/ignored counts remain visible and must have zero unresolved entries. Do not narrow mutation scope to omit executable production code.

Set a documented local runtime budget. If one full run is impractical, partition deterministically and aggregate all partitions; do not substitute a partial run for repository-wide evidence.

## Workstream 4 — zero dead code

The exact-pinned analyzer must report no unresolved:

- dead production files;
- unused exports/types/classes/functions;
- unreachable branches identified by the configured analyzer/manual review;
- unused production dependencies;
- obsolete compatibility re-exports left by the refactor.

Configure all legitimate CLI, platform, dynamic import, generated, package, and test entrypoints explicitly. Do not blanket-ignore a directory. Verify removals with targeted tests, full build, package contents, and runtime smoke.

## Workstream 5 — zero duplicate/redundant code

The token-aware clone report must contain zero reportable production clones under the Phase 0 threshold. Review remaining semantic redundancy manually, including duplicate decoders, registries, state owners, formatters, and platform branches.

Do not introduce a harmful generic abstraction merely to reach zero. If two implementations intentionally differ by security, wire, performance, or platform contract, encode the shared safe primitive only when parity tests prove identity; keep policy differences explicit. The evidence report must resolve each reviewed candidate, not simply raise the clone threshold.

## Workstream 6 — final structural/type verification

Rerun and archive repository-wide reports proving:

- cyclomatic maximum `<22`;
- cognitive maximum `<22`;
- Halstead difficulty maximum `<80`;
- CRAP maximum `<25`;
- ordinary source maximum `<500` physical lines;
- explicit `any` zero;
- narrowing-required/internal-imprecise `unknown` zero;
- double assertions, unsafe casts, and unresolved suppressions zero;
- architecture exceptions/debt zero;
- coverage raw uncovered counters zero;
- mutation survived/no-coverage/error/timeout counters zero;
- dead and duplicate/redundant unresolved counters zero.

Every report records tool/version, schema, Git SHA, environment, scope, exclusions, and timestamp.

## Workstream 7 — complete behavior/platform matrix

### Repository checks

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run typecheck
npm run embed-prompts:check
npm run test:arch -- --reporter=dot
npm run test:conformance -- --reporter=dot
npm run test:admission -- --reporter=dot
npm run test:deterministic -- --reporter=dot
npm run build
npm run release:verify
npm pack --dry-run
npm run quality:final
```

Also smoke the built `dist/index.js`/published entrypoint using the same command CI uses, and verify package contents contain required prompts/assets but no quality reports, secrets, or temporary fixtures.

### Runtime and renderer checks

```sh
npm run test:bun
npm run test:classic:pty
```

Run OpenTUI conformance/performance and noninteractive stdout/stderr/exit tests. Verify abort/cancellation, no-TTY startup, terminal restoration, and session detach/reattach.

### Host matrix

Obtain green evidence on the execution host for:

- the semantic suite on the installed Node runtime;
- Linux process, permission, PTY, and package behavior;
- Classic POSIX suite and PTY smoke;
- built-entrypoint, compile/release verification, and package dry run.

A skipped, unavailable, or emulated host check does not prove the corresponding contract. Record it as out of local scope, never as passed. Other runtimes, operating systems, and terminal hosts (Node 22, Bun/OpenTUI, macOS, Windows/ConPTY, OS keychains) are documented gaps rather than closure blockers.

## Workstream 8 — independent audit

An independent reviewer must verify:

- each task has concrete evidence;
- reports cover the declared scope and exclusions are narrow/justified;
- no baseline was raised and no generated output was hand-edited;
- public exports, request fingerprints, tool schemas/order, persistence fixtures, security properties, semantic parity, and platform contracts remain equivalent;
- move-only and cleanup commits are independently revertible;
- no compatibility facade, duplicate owner, temporary script, disabled gate, or TODO remains unintentionally;
- the final branch contains no unrelated production behavior change.

Resolve findings with focused commits and rerun affected plus terminal checks.

## Acceptance criteria

- [ ] Coverage is exactly 100% statements, branches, functions, and lines with zero raw uncovered items.
- [ ] Every function has CRAP `<25` and all complexity/Halstead limits pass.
- [ ] Mutation reports zero survived, no-coverage, unresolved timeout, and unresolved error mutants.
- [ ] Dead-code/dependency reports contain zero unresolved production findings.
- [ ] Duplicate report and reviewed redundancy ledger contain zero unresolved findings.
- [ ] File/type/cast/suppression/architecture gates remain at their Phase 7 terminal values.
- [ ] All locally available repository, built-entrypoint, package, release, renderer, PTY, and Linux checks pass; other-host contracts are documented as out of local scope.
- [ ] Independent review is complete and every exception/exclusion is justified and visible.
- [ ] Worktree is clean; final evidence is committed and pushed only from the feature branch.

## Evidence bundle

Archive or link machine-readable reports for:

- coverage counters and merged source map data;
- complexity, cognitive, Halstead, and CRAP results;
- mutation partitions and aggregate;
- dead code/dependencies;
- duplication and manual redundancy ledger;
- file/type/cast/suppression/architecture inventory;
- all test/build/package/release/platform job URLs or logs;
- public contract fingerprints and final diff review;
- independent reviewer sign-off and rollback history.

Reports generated in ignored build directories must have immutable CI artifacts/links; do not commit huge transient output unless the Phase 0 evidence policy calls for a compact summary.

## Commit, push, and rollback plan

Use focused commits for each uncovered branch, mutant group, dead-code removal, and deduplication seam. Never combine all quality closure in one opaque diff. Suggested phase-close subject:

```text
refactor(codebase): complete behavior-preserving modernization
```

Before push:

```sh
git diff --check
git status --short --branch
git log --oneline --decorate -n 20
```

Push the current feature branch with hooks intact; never push to `main`/`master`. A final-gate regression requires reverting the smallest responsible commit and rerunning the affected partition plus complete terminal matrix before re-closing.
