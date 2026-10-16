# Implementation task ledger

Status: **not started**. The audit is delivered; none of the implementation checkboxes below represents work completed by that audit.

Read [IMPLEMENTER.md](IMPLEMENTER.md) first. Acceptance details and exact affected surfaces are in [roadmap.md](roadmap.md); test IDs are in [validation.md](validation.md). Mark tasks as verified work is completed, commit and push each phase. A new optimized release prefix is allowed; no separate prefix-change approval is required. Do not check evidence-gated work before its criteria pass.

## Phase state

| Phase | Dependencies | State | Evidence / commit / push |
| --- | --- | --- | --- |
| P0 Baseline and contract lock | implementation authorization | pending | — |
| P1 Evaluation and regression gates | P0 | pending | — |
| P2 Strict-prefix optimization | P1 | pending | — |
| P3 Durable profile compatibility | P1 | pending | — |
| P4 Instruction candidate | P3 + TE-022 cache baseline | pending prerequisites | — |
| P5 Tool-description candidate | P4 | pending prerequisites | — |
| P6 Evaluation and release decision | applicable candidate phases; P1 required | pending | — |

P4/P5 are part of the optimization scope, not blocked on another prefix-change decision. Every candidate must keep its selected prefix stable during use and demonstrate same-or-better comparable cache reuse. Missing evidence or a regression still blocks release; do not label partial work as all phases shipped.

## P0 — Baseline and contracts

- [ ] **TE-001 — Rebaseline the actual checkout.** Record commit/runtime/config/route provenance and reproduce supplied offline measurements; unexplained drift resolved before edits.
- [ ] **TE-002 — Account for full first-request assembly.** Add synthetic real-runner context fixtures for coding/security/ask/plan, MCP, vision, skills and project rules; canonical versus serialized counts and estimate provenance explicit (D01/D02).
- [ ] **TE-003 — Lock rule and tool contracts.** Create source-to-obligation-to-test mapping; capture ordered legacy prompt/schema digests, boundaries, aliases and flags; no required behavior unowned.
- [ ] **TE-004 — Deliver P0.** Record evidence, pass focused accounting checks and byte-equivalence baseline, update this ledger, commit and verify branch push.

## P1 — Evaluation and regression gates

- [ ] **TE-005 — Make paired trials route-aware and isolated.** Use existing adapters, synthetic configuration, pinned settings, counterbalanced order, explicit call budget and redacted evidence.
- [ ] **TE-006 — Repair weak outcome verifiers.** Prove real background execution/wait and immutable fixture tests; add natural prompts without prescribed tools and independent hidden assertions (C01–C10).
- [ ] **TE-007 — Capture complete efficiency metrics.** Include failed attempts, repairs, cached/write/input/output usage, auxiliary work, first-token/task latency, local overhead and unknown values; report rounds separately from invocations.
- [ ] **TE-008 — Build security fixture coverage.** Implement S01–S10 with known findings and negative controls, raw/header/redirect/TLS/body-digest evidence and scope assertions.
- [ ] **TE-009 — Prove gates detect regressions.** Add D03–D13 and fault controls for early prefix mutation, tool reorder, wrong fix, missing evidence and extra request; preserve existing cache/provider tests.
- [ ] **TE-010 — Deliver P1.** Baseline passes and negative controls fail as designed; update ledger/evidence, commit and verify branch push.

## P2 — Strict-prefix improvements

- [ ] **TE-011 — Identify remaining redundant future context.** Profile current upserts/section filtering/plan-state output; quantify only avoidable new content, not existing deduplication or user-owned requirements.
- [ ] **TE-012 — Implement or reject safe suppression.** Preserve full authority, clear/re-add behavior and sent history; D03/D04/D07 plus quality fixtures pass. A justified no-op is acceptable and must state zero savings.
- [ ] **TE-013 — Implement or reject equivalent local caching.** Only after profiling; output bytes/order identical, cache bounded and mutation-safe, no latency/memory regression.
- [ ] **TE-014 — Validate existing batching end-to-end.** D11/C06/C07 verify per-file results, partial errors, correct cursors and independent rounds without new tools or less verification.
- [ ] **TE-015 — Deliver P2.** Publish measured benefit or retain-baseline decision; legacy prefix/catalog unchanged; all relevant gates pass; update ledger, commit and verify branch push.

## P3 — Durable profile compatibility

- [ ] **TE-016 — Introduce immutable legacy profile binding.** Implement resolver/manifest with exact prompt and ordered schemas; no candidate activation, no changed legacy bytes (C1/C3/C5).
- [ ] **TE-017 — Replace brittle composition detection.** Use internal profile capabilities instead of matching prose; full/compact/native/text legacy assembly remains identical (D01/D02).
- [ ] **TE-018 — Persist and restore route bindings.** Update all history/session/persistence callers, JSONL/SQLite and import/export/recovery; do not persist extra authorization state.
- [ ] **TE-019 — Handle legacy/unknown/corrupt profiles safely.** No guessed defaults; actionable pre-request recovery; exact known artifacts retained; old history never discarded.
- [ ] **TE-020 — Prove process/version transitions.** Fresh-process upgrade/resume, config changes, provider return, native/text fallback, compaction and rollback fixtures preserve supported prefix boundaries (D07–D09).
- [ ] **TE-021 — Deliver P3.** Legacy wire equality, compatible persistence, packaged artifact availability and performance checks pass; update ledger, commit and verify branch push.
- [ ] **TE-022 — Lock comparable cache baselines and candidate scope.** Record routes/settings/workloads, cold/warm classification, eligible-prefix denominator and warm hit/reuse metrics. Define tests for zero runtime prefix drift and same-or-better cache reuse (C1/C6/C9); no separate owner decision is needed for a new release prefix.

## P4 — Instruction candidate (requires P3 and TE-022 evidence)

- [ ] **TE-023 — Create isolated candidate instruction artifacts.** Keep legacy untouched and schema fixed; consolidate only mapped semantic duplication; no dynamic coding/security core switch.
- [ ] **TE-024 — Preserve native/text and dynamic obligations.** Keep text-call guidance, project/user/skill/scope/plan content and edit/recovery semantics; explicit capabilities prevent mode-guidance rebound.
- [ ] **TE-025 — Regenerate and verify artifacts.** Source/embedded/package paths agree; legacy digest unchanged; full assembled-request accounting demonstrates the candidate's real reduction (D12).
- [ ] **TE-026 — Evaluate prompt-only behavior.** Deterministic coverage and multi-route coding/security pilot pass with no first-attempt/round/latency/quality regression; otherwise reject and retain baseline.
- [ ] **TE-027 — Deliver P4.** Document accepted experiment or rejection, clean unreferenced artifacts, keep candidate disabled pending final gates; update ledger, commit and verify branch push.

## P5 — Tool-description candidate (requires passing P4 path)

- [ ] **TE-028 — Shorten descriptions contract-first.** Prioritize measured large tools; preserve names, order, shapes, required fields, enums, units, defaults, aliases, flags and discovery/continuation behavior.
- [ ] **TE-029 — Correct candidate schema/validator parity.** Encode `web.fetch.maxBytes` 1,024–1,048,576 from authoritative constants; test below/at/above boundaries and actual emitted schema; preserve legacy profile bytes (D10).
- [ ] **TE-030 — Prove provider and text-route compatibility.** OpenAI/Anthropic/Gemini enrichment/sanitization and text guidance remain accurate; do not remove `http.fetch` or introduce `$ref`/dispatcher shortcuts without independent proof.
- [ ] **TE-031 — Evaluate schemas alone and combined.** First-attempt natural tool selection, coding/security evidence and total rounds/cost/latency meet gates; rejection is documented, not hidden by hash updates.
- [ ] **TE-032 — Deliver P5.** Freeze ordered candidate catalog, retain legacy/old-history compatibility, remove stale candidate paths; update ledger, commit and verify branch push.

## P6 — Evaluation and release decision

- [ ] **TE-033 — Run broader deterministic/build/package checks.** Typecheck, prompt generation check, deterministic/conformance suites, applicable host/Bun checks, source and distributed CLI smoke; inspect generated diff.
- [ ] **TE-034 — Complete paired live and holdout evaluation.** Cold/warm/multi-turn/recovery matrix across declared-supported models; staged repetitions, failed-attempt accounting and uncertainty analysis; missing access remains blocked.
- [ ] **TE-035 — Publish decision and achievable savings.** Per-route startup/full-task tokens, cache, quality, first-attempt validity, rounds, latency and resource metrics; choose release/retain-baseline/blocked without weakening gates.
- [ ] **TE-036 — Release only a validated passing profile.** Use the optimized default for new sessions; existing/resumed sessions stay pinned. Prove same-or-better comparable warm-cache hit/reuse, no runtime prefix mutation, bounded canary and new-session-only rollback. Leave unchecked if any required evidence is missing or a regression remains.
- [ ] **TE-037 — Complete cleanup and compatibility review.** No dead flags/exports, stale docs, duplicate generators, dangling handlers or missing packaged assets; intentionally retained legacy artifacts documented and tested.
- [ ] **TE-038 — Deliver final phase.** Reconcile every requested criterion and task, record residuals and remote commit refs, commit and verify branch push; never label blocked activation “released.”

## Phase evidence entry template

Use a small file named `evidence/phase-N.md` when implementing, not during this audit:

- Phase/task IDs and status:
- Baseline/candidate commits, profiles, fixture/config versions:
- Hypothesis and affected surfaces:
- Before/after measurements and provenance:
- Commands and independent outcome assertions:
- Wire-prefix, schema, first-attempt and quality results:
- Latency/resource results and uncertainty:
- Cleanup and rollback proof:
- Rejected alternatives and remaining blockers:
- Commit and verified push receipt (or explicit delivery blocker):

Never store credentials, private source dumps, sensitive response bodies or giant raw logs in this ledger.
