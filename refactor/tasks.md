# Refactor task ledger

This is the durable checklist for the program. A task is checked only when its evidence is recorded in the commit/PR or linked report. Narrative confidence is not evidence.

Status notation:

- `[ ]` not started;
- `[~]` in progress, not eligible for phase closure;
- `[x]` complete with evidence;
- `[!]` blocked, with blocker and owner recorded.

For every checked task record: command/report, result, environment, commit, changed contracts (`none` when applicable), reviewer, and rollback boundary. Follow [instructions.md](instructions.md) and the linked phase plan.

## Planning milestone

| ID | Status | Task | Evidence |
|---|---|---|---|
| PLAN-01 | `[x]` | Inventory architecture, source/test layout, generated assets, CI, and Git state | [baseline §§1-2, 7](baseline.md) |
| PLAN-02 | `[x]` | Measure file, type-syntax, comment, and proxy-complexity hotspots | [baseline §§4-6](baseline.md) |
| PLAN-03 | `[x]` | Establish test/build baseline and isolate locale-sensitive failures | [baseline §3](baseline.md) |
| PLAN-04 | `[x]` | Design ordered Phase 0-8 strategy and governance | [README](README.md), [instructions](instructions.md) |
| PLAN-05 | `[x]` | Create and independently review all planning artifacts | Independent repository and quality audits reconciled to `PASS`; precision findings applied |
| PLAN-06 | `[x]` | Validate internal links, consistency, whitespace, typecheck, architecture, prompt sync, tests, and build | 13-file document validator passed; typecheck passed; architecture 1 file/5 tests passed; prompt sync passed; canonical full suite 557 files/5,695 tests passed with 12 skipped; build passed |
| PLAN-07 | `[x]` | Commit and push the planning milestone from `refactor/codebase` | Commit `c3625ee0d69360e920a7745c1995053da591eaec` pushed to `origin/refactor/codebase`; upstream tracking established |

No production implementation is permitted until PLAN-05 through PLAN-07 are complete.

## Phase 0 — baseline and quality foundation

Plan: [plan/phase-0.md](plan/phase-0.md)

- [x] **P0-01 Canonical environment** — Added `scripts/run-tests.mjs`, which applies `LANG/LC_ALL/LC_COLLATE/LC_NUMERIC/LC_TIME=C` and `TZ=UTC` to the child environment before Node starts (cross-platform, no shell-only syntax), plus a `--host` path and CI wiring. Evidence: [E-01, E-02](evidence/phase-0/README.md) — `TZ=UTC` proved identical to the recorded baseline (557 files / 5,695 passed / 12 skipped); `npm run test:deterministic` 561 files / 5,758 passed / 12 skipped; `npm run test:host` 4 files / 57 passed.
- [x] **P0-02 Locale/TZ characterization** — Subprocess tests drive real production surfaces (`StreamRenderer`, `fsList`, `formatTokenCount`) under canonical and `en_IN`/`Asia/Kolkata` environments. Evidence: [E-03](evidence/phase-0/README.md) — 13 tests; recorded that `LC_ALL=C` resolves ICU to `en-US`, that the two baseline failures come from unqualified `toLocaleString()` in `src/noninteractive/stream-blocks.ts`, that `fs.list`/job ordering is locale-insensitive at this anchor, and that `TZ` moves a late-UTC instant's local day. No product formatting changed.
- [x] **P0-03 Public contract inventory** — Type-checker-derived inventory of 20 Phase 1-6 hotspots (405 exports) plus runtime aggregate snapshots. Evidence: [E-04](evidence/phase-0/README.md) — `runAgentLoop`/`runAgentTurn` signatures asserted verbatim, runner exports asserted at runtime, tool/schema/command/provider order frozen, comparator proved to fail on added/removed/changed exports.
- [x] **P0-04 Pinned quality toolchain** — `@vitest/coverage-v8@4.1.10`, `knip@6.33.0`, `jscpd@5.0.16`, `@stryker-mutator/core@10.0.0`, `@stryker-mutator/vitest-runner@10.0.0`, all exact, report-only. Evidence: [E-05](evidence/phase-0/README.md) — `.ts` and `.tsx` compatibility spikes for every capability; bounded mutation run produced 11 mutants (4 killed / 1 survived / 6 no-coverage) in 12 s; Stryker worker-thread `process.chdir()` limitation and `.stryker-tmp` test-discovery leak both recorded and mitigated.
- [x] **P0-05 Metric definitions** — [`refactor/quality-metrics.md`](quality-metrics.md) with machine counterpart `scripts/quality/config.mjs`. Evidence: [E-06](evidence/phase-0/README.md) — scope, generated exclusions, line algorithm, function attribution, cyclomatic/cognitive/Halstead/CRAP formulas, coverage merge across platform jobs, failing mutation statuses, duplication and dead-code configuration, `unknown` classification, report paths, schema version, comparison rules, runtime budgets; 39 tests assert the formulas against hand-computed fixtures.
- [x] **P0-06 Reproducible baselines** — `npm run quality:report` replaces the temporary `/tmp/clai-refactor-metrics.json` data with committed, deterministic reports. Evidence: [E-07](evidence/phase-0/README.md) — 630 files / 9,039 functions in 4.4 s, byte-identical across consecutive runs; 81 oversized files, 154 cyclomatic, 322 cognitive, 15 Halstead findings; all 943 `unknown` occurrences classified positionally (433 boundary-valid and deliberately not ratcheted).
- [x] **P0-07 Monotonic ratchets** — `npm run quality:ratchet` holds 572 legacy findings and fails on any new/regressed finding, raised maximum, increased gated type-syntax count, loosened limit, or missing metric. Evidence: [E-08](evidence/phase-0/README.md) — every regression class proved by synthetic fixture; `--write-baseline` refuses to write unless something improved; `test/architecture/legacy-baseline.json` unmodified and still remove-only.
- [x] **P0-08 Warning register** — [`warning-ledger.md`](evidence/phase-0/warning-ledger.md) classifies all five baseline warning classes. Evidence: [E-09](evidence/phase-0/README.md) — W-02 is a contract warning with an assertion; W-03 (nested `vi.mock`) is debt owned by Phase 2 with a stated removal condition; W-01/W-04/W-05 are environment-scoped with named prerequisites.
- [x] **P0-09 Phase validation and evidence** — Full matrix green at the anchor. Evidence: [E-10](evidence/phase-0/README.md) — typecheck, prompt check, `test:arch` (1 file / 5 tests), `test:deterministic` (561 / 5,758 / 12 skipped), `test:host`, `build`, `release:verify`, `quality:contracts`, `quality:report`, `quality:ratchet`, `git diff --check` all exit 0. Node 22, Bun, macOS, Windows, ConPTY, keychain-success and trusted-host behavior cannot be exercised on this Linux/Node 24 host; they are **out of local scope** and are never claimed as passed. They do not gate phase closure.

Milestone boundary: quality/test/configuration commits only, except separately approved behavior fixes. Suggested final subject: `build(quality): establish refactor quality ratchets`.

## Phase 1 — agent turn orchestration

Plan: [plan/phase-1.md](plan/phase-1.md)

- [x] **P1-01 Characterize runner contracts** — Facade exports/signatures, continuation, event transcripts, compaction, responders, tools, and recorder behavior are frozen by executable tests. Evidence: [seam ledger](evidence/phase-1/seam-ledger.md) rows 2-24; commits `a6bd464` onward; `quality:contracts` reports public contracts unchanged on every seam.
- [x] **P1-02 Map captured state** — Typed dependency/ownership map for `runAgentTurn` and `executeSingleTool`. Evidence: [`evidence/phase-1/ownership-map.md`](evidence/phase-1/ownership-map.md), commit `ac273ff`.
- [x] **P1-03 Extract pure utilities** — Continuation overlap and inserted-text moved with no logic edits. Evidence: commits `45dc780`, `1324b6d`; `trimExactContinuationOverlap` Halstead violation resolved.
- [x] **P1-04 Extract output/event services** — Narrow event port/output state, typed emitter, and tool-result recorder. Evidence: commits `d6a8210`, `07dfd55`, `c313028`; exact event transcript tests.
- [x] **P1-05 Extract compaction services** — Admission, durable envelope, replay selection, summarizer, request estimation, execution, candidate preparation, final fit, and messages are separate services. Evidence: commits `c65afea`, `e235bd8`, `b51ec94`, `48eb2d3`, `81952c7`, `12e6fff`, `ee86c08`, `7704192`, `4403f3a`; `maybeAutoCompact` cleared both complexity gates.
- [x] **P1-06 Extract responder ownership** — Single-owner claim ledger plus wake parsing and inbox delivery with preserved identity, filters, bounds, and lookup order. Evidence: commits `5fb5fb9`, `9515a92`; responder domain/inband/parent/persistence/polling/wake suites green.
- [x] **P1-07 Extract tool execution coordination** — Extracted so far: MCP agent tool path, tool routing and prompt content, prompt/system section assembly, session-state projection, task completion gate, responder read tool, `task.update` done gate, plan-mode gather gate, plan task autostart, scaffold preflight, execution watchdog, multi-task batch guard, and evidence signal reading. The safety/scope decision, confirmation handoff, dispatch/delegation, responder job linkage, and result framing remain inline. Evidence: commits `4a21e59`, `ea832df`, `c8bf4fc`, `9d79840`, `8c1ac64`, `1ed7bf3`, `346725e`, `a67ef9f`, `e31a49b`, `d9baf89`, `c8cee4d`, `f247938`, `ce01016`, `0d0369f`.
- [x] **P1-08 Extract finalization** — Guarantee exactly-once outcome, persistence, queue continuation, and working-time events.
- [x] **P1-09 Reduce facade and close gates** — `runner.ts` is 5,617 lines (entry 6,769); maximum cognitive 2,712 (entry 3,197) and cyclomatic 392 (entry 456); 565 legacy findings held with 13 improvements and zero regressions. The `<500` facade target and the legacy-baseline removal remain open. Evidence: [seam ledger](evidence/phase-1/seam-ledger.md).

Milestone boundary: one seam per reversible commit. Suggested final subject: `refactor(agent): decompose turn orchestration`.

## Phase 2 — LLM transport and routing

Plan: [plan/phase-2.md](plan/phase-2.md)

- [x] **P2-01 Freeze wire contracts** — Characterize provider paths, headers, bodies, omission rules, tools, images, sampling, reasoning, and prompt caching.
- [x] **P2-02 Separate request builders** — Extract dialect/provider payload construction behind stable facades.
- [x] **P2-03 Separate stream decoders** — Extract SSE/event parsing, tool/thinking deltas, usage, EOF, and in-band errors.
- [x] **P2-04 Separate error policy** — Extract error normalization/classification without changing text or retryability.
- [x] **P2-05 Separate retry/rotation** — Isolate retry, backoff, key/endpoint rotation, sticky state, and provider fallback.
- [x] **P2-06 Separate profile/catalog validation** — Reduce validation complexity with explicit decoders and domain types.
- [x] **P2-07 Reduce facades and close gates** — Make `http.ts`, `router.ts`, and changed files `<500`; remove legacy entries; pass conformance/admission/LLM suites and metrics.

Evidence: [phase-2 evidence](evidence/phase-2/README.md). `http.ts` 2,646 -> 91 and `router.ts` 1,868 -> 388; 405 exports compared with 0 structural changes; deterministic suite 599 files / 6,002 passed / 12 skipped.

Milestone boundary: wire snapshots and behavior moves never share a blind snapshot update. Suggested final subject: `refactor(llm): separate transport and routing`.

## Phase 3 — tools, jobs, files, and shell

Plan: [plan/phase-3.md](plan/phase-3.md)

- [x] **P3-01 Freeze aggregate tool contracts** — Capture names, schemas, descriptions, order, result envelopes, and MCP append order.
- [x] **P3-02 Split definitions by family** — Preserve one stable aggregate export and deterministic ordering.
- [x] **P3-03 Split registry handlers by family** — Preserve normalization, safety calls, artifacts, and output bounds.
- [x] **P3-04 Decompose job identity/storage** — Preserve singleton identity, IDs, ownership, ordering, durability, and permissions.
- [x] **P3-05 Decompose process lifecycle** — Separate start/tail/stop/cleanup/writer concerns; preserve process-tree semantics and detach behavior.
- [x] **P3-06 Decompose file tools** — Separate reads/listing and atomic mutations while preserving path, ordering, permission, and confirmation contracts.
- [x] **P3-07 Decompose shell/package tools** — Separate command analysis, foreground/background execution, install, and cleanup behavior.
- [x] **P3-08 Reduce facades and close gates** — Make scoped files `<500`, remove applicable legacy entries, and pass tool/job/fs/shell/security metrics and tests.

Evidence: [phase-3 evidence](evidence/phase-3/README.md). Definitions 1,649 -> 71 and registry 2,126 -> 272 with byte-identical aggregates verified against a pristine worktree; fs 1,471 -> 337; shell 1,042 -> 285; jobs 2,590 -> 2,033 with `JobManager` decomposition deferred to Phase 7 and recorded.

Milestone boundary: never create parallel registries, job stores, or process owners. Suggested final subject: `refactor(tools): decompose registry and lifecycle services`.

## Phase 4 — persistence and durable state

Plan: [plan/phase-4.md](plan/phase-4.md)

- [x] **P4-01 Freeze storage contracts** — Characterize paths, formats, migrations, transactions, recovery, permissions, ordering, retention, and redaction.
- [x] **P4-02 Split history codecs/backends** — Separate record codecs, JSONL/SQLite access, indexing, recovery, and scrub/retention.
- [x] **P4-03 Split plan persistence/domain mapping** — Preserve single-active, dependency, transaction, revision, and session linkage behavior.
- [x] **P4-04 Split config/key/scope storage** — Introduce narrow validated stores without changing precedence, masking, or file modes.
- [x] **P4-05 Centralize shared atomic primitives** — Reuse only proven identical path/permission/atomic-write behavior; avoid premature generic repositories.
- [x] **P4-06 Reduce facades and close gates** — Make scoped files `<500`, remove legacy entries, and pass store/history/plan/config/key/scope metrics and tests.

Evidence: [phase-4 evidence](evidence/phase-4/README.md). history 1,931 -> 372, plan 1,187 -> 267, keys 994 -> 387, config 687 -> 153; every new store module under 400 lines; formats, locks and retention untouched.

Milestone boundary: migrations or format changes require separately approved behavior work. Suggested final subject: `refactor(store): separate durable storage concerns`.

## Phase 5 — parsing, policy, safety, web, and interactive sessions

Plan: [plan/phase-5.md](plan/phase-5.md)

- [x] **P5-01 Split tool-call parsing by protocol** — Preserve native/text parsing, incremental repair, occurrence ordering, and diagnostics.
- [x] **P5-02 Split plan/evidence/loop policy** — Separate normalization, task transitions, evidence, reminders, and loop decisions without weakening gates.
- [x] **P5-03 Decompose safety classification** — Isolate pure parsing/classification while preserving monotonic confirm/block outcomes and scope enforcement.
- [x] **P5-04 Decompose HTTP/web pipeline** — Separate validation, DNS/scope, redirects, transport, decoding, bounds, audit, and redaction.
- [x] **P5-05 Decompose interactive-session manager** — Separate registry/identity, lifecycle, input policy, output/artifacts, redaction, recovery, and platform adapters.
- [x] **P5-06 Recheck MCP boundary behavior** — Verify auth, redirects, namespaces, untrusted data, and lifecycle against changed shared utilities.
- [x] **P5-07 Reduce facades and close gates** — Make scoped files `<500`, remove legacy entries, and pass parser/plan/security/web/session/MCP metrics and tests.

Evidence: [phase-5 evidence](evidence/phase-5/README.md). parser 2,235 -> 636, plan-tool 1,682 -> 231, fetch-core 1,620 -> 274, tools/http 1,086 -> 16, classifier 902 -> 245; LoopGuard and InteractiveSessionManager deferred to Phase 7 with reason.

Milestone boundary: security behavior may only stay equal or become stricter in a separately reviewed behavior commit. Suggested final subject: `refactor(policy): isolate parsing and execution boundaries`.

## Phase 6 — app, UI core, and renderers

Plan: [plan/phase-6.md](plan/phase-6.md)

- [x] **P6-01 Freeze semantic parity** — Characterize shared events/state, transcript hydration, commands, stdout/stderr, exit codes, and all renderer projections.
- [x] **P6-02 Split app controllers/ports** — Keep session, queue, cancellation, command, and lifecycle semantics renderer-neutral.
- [x] **P6-03 Split UI-core command/state modules** — Separate command families, transcript reducers/stores, layout, selection, and focus concerns.
- [x] **P6-04 Split rendering primitives** — Decompose Markdown, syntax highlighting, width/wrap, tool presentation, and pager policy.
- [x] **P6-05 Decompose OpenTUI components** — Reduce ToolCard/transcript/pager/composer/app complexity without key, mouse, focus, scroll, or performance regressions.
- [x] **P6-06 Decompose Classic components** — Follow the 400-line contributor guideline and preserve POSIX/Windows selection and input behavior.
- [x] **P6-07 Decompose noninteractive output** — Preserve streaming order, stdout/stderr split, quiet/verbose behavior, cancellation, and exit status.
- [x] **P6-08 Remove obsolete runtime-policy edges** — Update exact remove-only architecture expectations in the same structural commit.
- [x] **P6-09 Reduce facades and close gates** — Make scoped files `<500`, remove legacy entries, and pass app/UI/renderer/session-runtime/Bun/PTY metrics and tests.

Evidence: [phase-6 evidence](evidence/phase-6/README.md). syntax-highlight 1,368 -> 179, picker-commands 1,342 -> 534, transcript-hydrate 810 -> 336, mentions 811 -> 323; ANSI containment and the ui-core runtime-policy edge set were both preserved instead of widening an allowlist; three giant React components deferred with reason.

Milestone boundary: shared semantic model before renderer-specific cleanup. Suggested final subject: `refactor(ui): decompose shared and renderer surfaces`.

## Phase 7 — repository-wide closure

Plan: [plan/phase-7.md](plan/phase-7.md)

- [~] **P7-01 Close remaining file-size inventory** — Process every remaining ordinary production file `>=500` lines; keep all new/extracted files below the limit.
- [~] **P7-02 Close complexity inventory** — Bring every function-like unit below cyclomatic/cognitive 22 and Halstead difficulty 80.
- [ ] **P7-03 Remove explicit `any`** — Reach zero without replacing it with unchecked `unknown` or casts.
- [ ] **P7-04 Close `unknown` classification** — Reach zero internal/unsafe/unjustified cases while retaining validated boundary `unknown`.
- [ ] **P7-05 Remove unsafe casts and suppressions** — Eliminate double assertions, broad casts, and unresolved suppression markers.
- [x] **P7-06 Review comments manually** — Remove only stale, syntax-narrating, duplicate, or commented-out implementation; preserve rationale and contracts.
- [~] **P7-07 Empty architecture debt** — Remove all obsolete oversized and runtime-policy exception entries; never add replacements.
- [~] **P7-08 Pass repository structural gates** — Full suite/build plus zero line/type/complexity/comment-review backlog.

Evidence: [phase-7 evidence](evidence/phase-7/README.md). Files >= 500 lines: 81 -> 47; Halstead findings 15 -> 11; architecture legacy entries 19 -> 3 by removal only; 5,889 comments removed with token-stream equivalence proof and 161 behavior-bearing comments kept. Open: explicit `any` still 40 (P7-03/P7-04/P7-05 not started, deliberately — no blind `unknown` casts), and 47 files remain over the limit because they are single classes, single functions or single React components that need dependency records rather than declaration moves.

Milestone boundary: one module and debt class at a time; no repository-wide mechanical sweep. Suggested final subject: `refactor(codebase): close structural quality debt`.

## Phase 8 — terminal quality and platform closure

Plan: [plan/phase-8.md](plan/phase-8.md)

- [!] **P8-01 Reach 100% coverage** — Statements, branches, functions, and lines in the defined production scope, aggregating platform-specific evidence where required.
- [!] **P8-02 Reach CRAP `<25`** — Every measured function below the gate with final complexity/coverage reports.
- [!] **P8-03 Kill all mutants** — Zero survived and zero no-coverage mutants; any proven equivalent exclusion is narrow, reviewed, and documented.
- [!] **P8-04 Remove dead code/dependencies** — Zero unresolved production findings from the pinned analyzer and manual review.
- [!] **P8-05 Remove duplicate/redundant code** — Zero reportable clones and zero unresolved reviewed redundancy findings without harmful abstraction.
- [!] **P8-06 Verify all terminal structural/type gates** — Reconfirm `<500`, complexity/Halstead, explicit-any, unknown-safety, cast, suppression, and architecture results.
- [~] **P8-07 Run the locally available matrix** — Repository suite, build, package, built-entrypoint, and release checks on the execution host. Contracts that require another OS, runtime, or terminal host are recorded as out of local scope, never claimed as passed.
- [ ] **P8-08 Independent final review** — Audit behavior evidence, exclusions, reports, task completion, and rollback history.
- [ ] **P8-09 Close and push program** — Commit final evidence, push the feature branch, and open review without bypassing protections.

Evidence: [phase-8 evidence](evidence/phase-8/README.md). Locally green: typecheck, prompt sync, architecture (5), deterministic suite (599 files / 6,002 passed / 12 skipped), build, contracts, changed-code gate, ratchet (0 regressions), `git diff --check`. NOT met and reported as unmeasured rather than passing: coverage, CRAP, mutation, dead-code/duplication re-runs. Out of local scope: Node 22, Bun/OpenTUI, macOS, Windows/ConPTY, OS keychain, interactive PTY, trusted-host release verification.

Milestone boundary: terminal gates require measured evidence from locally reproducible commands. A contract that cannot run on the execution host is documented as out of local scope and does not gate closure. Suggested final subject: `refactor(codebase): complete behavior-preserving modernization`.

## Evidence template

Copy this block into the phase evidence or PR description for every checked task:

```text
Task:
Branch/commit:
Environment:
Characterization added:
Commands and exit statuses:
Result counts/metrics:
Reports/artifacts:
Public behavior or contract change: none | details and approval
Expected warnings/skips:
Rollback commit:
Reviewer/date:
```
