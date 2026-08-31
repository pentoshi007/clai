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
| PLAN-07 | `[ ]` | Commit and push the planning milestone from `refactor/codebase` | Pending commit and upstream evidence |

No production implementation is permitted until PLAN-05 through PLAN-07 are complete.

## Phase 0 — baseline and quality foundation

Plan: [plan/phase-0.md](plan/phase-0.md)

- [ ] **P0-01 Canonical environment** — Add one documented test wrapper that sets locale and timezone before Node starts; wire local scripts and CI to it. Evidence: default-host and canonical command results.
- [ ] **P0-02 Locale/TZ characterization** — Add subprocess tests for locale-sensitive number formatting, collation, file ordering, job ordering, and date/time behavior without silently changing product semantics. Evidence: fixtures and results under at least canonical and `en_IN` environments.
- [ ] **P0-03 Public contract inventory** — Capture exports/signatures and runtime-policy edges for every Phase 1-6 hotspot. Evidence: generated inventory or focused contract tests.
- [ ] **P0-04 Pinned quality toolchain** — Add exact-version coverage, complexity/Halstead, CRAP, mutation, dead-code, and duplication tooling in report-only mode. Evidence: `package.json`, lockfile, compatibility runs, version manifest.
- [ ] **P0-05 Metric definitions** — Document production/test/generated scope, line definition, function attribution, formulas, exclusions, timeout policy, and machine-readable report paths. Evidence: reviewed quality configuration.
- [ ] **P0-06 Reproducible baselines** — Replace temporary AST data with committed commands/reports; classify all `unknown` occurrences by boundary role. Evidence: sorted baseline artifacts from the green anchor.
- [ ] **P0-07 Monotonic ratchets** — Reject new/regressed findings while legacy debt remains report-only; do not expand architecture baselines. Evidence: focused tests proving improve/hold/fail behavior.
- [ ] **P0-08 Warning register** — Classify baseline warnings and assign remediation/removal conditions. Evidence: warning ledger and stable test output.
- [ ] **P0-09 Phase validation and evidence** — Pass the complete Phase 0 matrix and record the green anchor. Evidence: phase evidence bundle.

Milestone boundary: quality/test/configuration commits only, except separately approved behavior fixes. Suggested final subject: `build(quality): establish refactor quality ratchets`.

## Phase 1 — agent turn orchestration

Plan: [plan/phase-1.md](plan/phase-1.md)

- [ ] **P1-01 Characterize runner contracts** — Cover outputs/events, compaction, responders, tools, usage, cancellation, loop guards, evidence, and finalization.
- [ ] **P1-02 Map captured state** — Produce a typed dependency/ownership map for `runAgentTurn` and `executeSingleTool`.
- [ ] **P1-03 Extract pure utilities** — Move continuation overlap and existing pure helpers without logic edits.
- [ ] **P1-04 Extract output/event services** — Make event and display dependencies explicit; preserve order and channels.
- [ ] **P1-05 Extract compaction services** — Preserve thresholds, single-admission rules, summaries, retry, and usage.
- [ ] **P1-06 Extract responder ownership** — Preserve claims, wake/poll behavior, persistence, and parent linkage.
- [ ] **P1-07 Extract tool execution coordination** — Decompose dispatch/result recording while retaining tool/safety boundaries.
- [ ] **P1-08 Extract finalization** — Guarantee exactly-once outcome, persistence, queue continuation, and working-time events.
- [ ] **P1-09 Reduce facade and close gates** — Keep `runAgentLoop`/`runAgentTurn` signatures stable; make `runner.ts` and extracted files `<500`; remove its legacy entry; pass Phase 1 metrics/tests.

Milestone boundary: one seam per reversible commit. Suggested final subject: `refactor(agent): decompose turn orchestration`.

## Phase 2 — LLM transport and routing

Plan: [plan/phase-2.md](plan/phase-2.md)

- [ ] **P2-01 Freeze wire contracts** — Characterize provider paths, headers, bodies, omission rules, tools, images, sampling, reasoning, and prompt caching.
- [ ] **P2-02 Separate request builders** — Extract dialect/provider payload construction behind stable facades.
- [ ] **P2-03 Separate stream decoders** — Extract SSE/event parsing, tool/thinking deltas, usage, EOF, and in-band errors.
- [ ] **P2-04 Separate error policy** — Extract error normalization/classification without changing text or retryability.
- [ ] **P2-05 Separate retry/rotation** — Isolate retry, backoff, key/endpoint rotation, sticky state, and provider fallback.
- [ ] **P2-06 Separate profile/catalog validation** — Reduce validation complexity with explicit decoders and domain types.
- [ ] **P2-07 Reduce facades and close gates** — Make `http.ts`, `router.ts`, and changed files `<500`; remove legacy entries; pass conformance/admission/LLM suites and metrics.

Milestone boundary: wire snapshots and behavior moves never share a blind snapshot update. Suggested final subject: `refactor(llm): separate transport and routing`.

## Phase 3 — tools, jobs, files, and shell

Plan: [plan/phase-3.md](plan/phase-3.md)

- [ ] **P3-01 Freeze aggregate tool contracts** — Capture names, schemas, descriptions, order, result envelopes, and MCP append order.
- [ ] **P3-02 Split definitions by family** — Preserve one stable aggregate export and deterministic ordering.
- [ ] **P3-03 Split registry handlers by family** — Preserve normalization, safety calls, artifacts, and output bounds.
- [ ] **P3-04 Decompose job identity/storage** — Preserve singleton identity, IDs, ownership, ordering, durability, and permissions.
- [ ] **P3-05 Decompose process lifecycle** — Separate start/tail/stop/cleanup/writer concerns; preserve process-tree semantics and detach behavior.
- [ ] **P3-06 Decompose file tools** — Separate reads/listing and atomic mutations while preserving path, ordering, permission, and confirmation contracts.
- [ ] **P3-07 Decompose shell/package tools** — Separate command analysis, foreground/background execution, install, and cleanup behavior.
- [ ] **P3-08 Reduce facades and close gates** — Make scoped files `<500`, remove applicable legacy entries, and pass tool/job/fs/shell/security metrics and tests.

Milestone boundary: never create parallel registries, job stores, or process owners. Suggested final subject: `refactor(tools): decompose registry and lifecycle services`.

## Phase 4 — persistence and durable state

Plan: [plan/phase-4.md](plan/phase-4.md)

- [ ] **P4-01 Freeze storage contracts** — Characterize paths, formats, migrations, transactions, recovery, permissions, ordering, retention, and redaction.
- [ ] **P4-02 Split history codecs/backends** — Separate record codecs, JSONL/SQLite access, indexing, recovery, and scrub/retention.
- [ ] **P4-03 Split plan persistence/domain mapping** — Preserve single-active, dependency, transaction, revision, and session linkage behavior.
- [ ] **P4-04 Split config/key/scope storage** — Introduce narrow validated stores without changing precedence, masking, or file modes.
- [ ] **P4-05 Centralize shared atomic primitives** — Reuse only proven identical path/permission/atomic-write behavior; avoid premature generic repositories.
- [ ] **P4-06 Reduce facades and close gates** — Make scoped files `<500`, remove legacy entries, and pass store/history/plan/config/key/scope metrics and tests.

Milestone boundary: migrations or format changes require separately approved behavior work. Suggested final subject: `refactor(store): separate durable storage concerns`.

## Phase 5 — parsing, policy, safety, web, and interactive sessions

Plan: [plan/phase-5.md](plan/phase-5.md)

- [ ] **P5-01 Split tool-call parsing by protocol** — Preserve native/text parsing, incremental repair, occurrence ordering, and diagnostics.
- [ ] **P5-02 Split plan/evidence/loop policy** — Separate normalization, task transitions, evidence, reminders, and loop decisions without weakening gates.
- [ ] **P5-03 Decompose safety classification** — Isolate pure parsing/classification while preserving monotonic confirm/block outcomes and scope enforcement.
- [ ] **P5-04 Decompose HTTP/web pipeline** — Separate validation, DNS/scope, redirects, transport, decoding, bounds, audit, and redaction.
- [ ] **P5-05 Decompose interactive-session manager** — Separate registry/identity, lifecycle, input policy, output/artifacts, redaction, recovery, and platform adapters.
- [ ] **P5-06 Recheck MCP boundary behavior** — Verify auth, redirects, namespaces, untrusted data, and lifecycle against changed shared utilities.
- [ ] **P5-07 Reduce facades and close gates** — Make scoped files `<500`, remove legacy entries, and pass parser/plan/security/web/session/MCP metrics and tests.

Milestone boundary: security behavior may only stay equal or become stricter in a separately reviewed behavior commit. Suggested final subject: `refactor(policy): isolate parsing and execution boundaries`.

## Phase 6 — app, UI core, and renderers

Plan: [plan/phase-6.md](plan/phase-6.md)

- [ ] **P6-01 Freeze semantic parity** — Characterize shared events/state, transcript hydration, commands, stdout/stderr, exit codes, and all renderer projections.
- [ ] **P6-02 Split app controllers/ports** — Keep session, queue, cancellation, command, and lifecycle semantics renderer-neutral.
- [ ] **P6-03 Split UI-core command/state modules** — Separate command families, transcript reducers/stores, layout, selection, and focus concerns.
- [ ] **P6-04 Split rendering primitives** — Decompose Markdown, syntax highlighting, width/wrap, tool presentation, and pager policy.
- [ ] **P6-05 Decompose OpenTUI components** — Reduce ToolCard/transcript/pager/composer/app complexity without key, mouse, focus, scroll, or performance regressions.
- [ ] **P6-06 Decompose Classic components** — Follow the 400-line contributor guideline and preserve POSIX/Windows selection and input behavior.
- [ ] **P6-07 Decompose noninteractive output** — Preserve streaming order, stdout/stderr split, quiet/verbose behavior, cancellation, and exit status.
- [ ] **P6-08 Remove obsolete runtime-policy edges** — Update exact remove-only architecture expectations in the same structural commit.
- [ ] **P6-09 Reduce facades and close gates** — Make scoped files `<500`, remove legacy entries, and pass app/UI/renderer/session-runtime/Bun/PTY metrics and tests.

Milestone boundary: shared semantic model before renderer-specific cleanup. Suggested final subject: `refactor(ui): decompose shared and renderer surfaces`.

## Phase 7 — repository-wide closure

Plan: [plan/phase-7.md](plan/phase-7.md)

- [ ] **P7-01 Close remaining file-size inventory** — Process every remaining ordinary production file `>=500` lines; keep all new/extracted files below the limit.
- [ ] **P7-02 Close complexity inventory** — Bring every function-like unit below cyclomatic/cognitive 22 and Halstead difficulty 80.
- [ ] **P7-03 Remove explicit `any`** — Reach zero without replacing it with unchecked `unknown` or casts.
- [ ] **P7-04 Close `unknown` classification** — Reach zero internal/unsafe/unjustified cases while retaining validated boundary `unknown`.
- [ ] **P7-05 Remove unsafe casts and suppressions** — Eliminate double assertions, broad casts, and unresolved suppression markers.
- [ ] **P7-06 Review comments manually** — Remove only stale, syntax-narrating, duplicate, or commented-out implementation; preserve rationale and contracts.
- [ ] **P7-07 Empty architecture debt** — Remove all obsolete oversized and runtime-policy exception entries; never add replacements.
- [ ] **P7-08 Pass repository structural gates** — Full suite/build plus zero line/type/complexity/comment-review backlog.

Milestone boundary: one module and debt class at a time; no repository-wide mechanical sweep. Suggested final subject: `refactor(codebase): close structural quality debt`.

## Phase 8 — terminal quality and platform closure

Plan: [plan/phase-8.md](plan/phase-8.md)

- [ ] **P8-01 Reach 100% coverage** — Statements, branches, functions, and lines in the defined production scope, aggregating platform-specific evidence where required.
- [ ] **P8-02 Reach CRAP `<25`** — Every measured function below the gate with final complexity/coverage reports.
- [ ] **P8-03 Kill all mutants** — Zero survived and zero no-coverage mutants; any proven equivalent exclusion is narrow, reviewed, and documented.
- [ ] **P8-04 Remove dead code/dependencies** — Zero unresolved production findings from the pinned analyzer and manual review.
- [ ] **P8-05 Remove duplicate/redundant code** — Zero reportable clones and zero unresolved reviewed redundancy findings without harmful abstraction.
- [ ] **P8-06 Verify all terminal structural/type gates** — Reconfirm `<500`, complexity/Halstead, explicit-any, unknown-safety, cast, suppression, and architecture results.
- [ ] **P8-07 Run complete platform matrix** — Node 22/24, Bun/OpenTUI, Classic POSIX/PTTY, macOS, Windows, process/privilege, MCP, package, built-entrypoint, and release checks.
- [ ] **P8-08 Independent final review** — Audit behavior evidence, exclusions, reports, task completion, and rollback history.
- [ ] **P8-09 Close and push program** — Commit final evidence, push the feature branch, and open review without bypassing protections.

Milestone boundary: terminal gates require measured evidence; an unavailable platform job remains blocked, not passed. Suggested final subject: `refactor(codebase): complete behavior-preserving modernization`.

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
