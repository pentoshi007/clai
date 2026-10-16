# Implementation task ledger

Status: **implementation in progress** (authorized 2026-10-16). P0–P1 delivered; P2 verified as a measured retain-baseline decision with its receipt carried into P3. P3–P6 remain pending. Checkboxes track verified criteria, not rollout approval. No optimized profile is enabled.

Read [IMPLEMENTER.md](IMPLEMENTER.md) first. Acceptance details and exact affected surfaces are in [roadmap.md](roadmap.md); test IDs are in [validation.md](validation.md). Mark tasks as verified work is completed, commit and push each phase. A new optimized release prefix is allowed; no separate prefix-change approval is required. Do not check evidence-gated work before its criteria pass.

## Phase state

| Phase | Dependencies | State | Evidence / commit / push |
| --- | --- | --- | --- |
| P0 Baseline and contract lock | implementation authorization | complete | [phase-0.md](evidence/phase-0.md); `fe80e611`, push verified |
| P1 Evaluation and regression gates | P0 | complete | `1f9ad72d`, remote equality verified; [phase-1.md](evidence/phase-1.md), [coverage](evidence/phase-1-coverage.md); limited-route baseline, no candidate/cache pass |
| P2 Strict-prefix optimization | P1 | verified retain-baseline decision; delivery receipt in P3 | [phase-2.md](evidence/phase-2.md); additional startup/task savings 0; runtime unchanged |
| P3 Durable profile compatibility | P1 | pending | — |
| P4 Instruction candidate | P3 + TE-022 cache baseline | pending prerequisites | — |
| P5 Tool-description candidate | P4 | pending prerequisites | — |
| P6 Evaluation and release decision | applicable candidate phases; P1 required | pending | — |

P4/P5 are part of the optimization scope, not blocked on another prefix-change decision. Every candidate must keep its selected prefix stable during use and demonstrate same-or-better comparable cache reuse. Missing evidence or a regression still blocks release; do not label partial work as all phases shipped.

## P0 — Baseline and contracts

- [x] **TE-001 — Rebaseline the actual checkout.** Record commit/runtime/config/route provenance and reproduce supplied offline measurements; unexplained drift resolved before edits.
  - Verified: base `e450cebf`, no runtime drift from `ada38924`; old measurements and all eight inventory routes reproduced identically. [P0 evidence](evidence/phase-0.md).
- [x] **TE-002 — Account for full first-request assembly.** Add synthetic real-runner context fixtures for coding/security/ask/plan, MCP, vision, skills and project rules; canonical versus serialized counts and estimate provenance explicit (D01/D02).
  - Verified: 64 isolated production-assembly combinations, session-state refresh, canonical/wire attribution, images/reasoning, complete dynamic authority and deterministic repeat equality. [Measurements](evidence/assembly-baseline.json); `test/context/token-assembly-baseline.test.ts`. Live provider usage remains unknown.
- [x] **TE-003 — Lock rule and tool contracts.** Create source-to-obligation-to-test mapping; capture ordered legacy prompt/schema digests, boundaries, aliases and flags; no required behavior unowned.
  - Verified: all 31 source headings owned, section/paragraph boundaries protected, 47 complete ordered tool contracts and renderer bytes locked. [Contracts](contracts.md); `test/context/token-contract-ledger.test.ts`. Structural coverage is not model-behavior equivalence; P1 remains required.
- [x] **TE-004 — Deliver P0.** Record evidence, pass focused accounting checks and byte-equivalence baseline, update this ledger, commit and verify branch push.
  - Verified: `fe80e61101e72ab626e86a18c3d037c3f68b6601` pushed to `origin/audit/token-efficiency-roadmap`; remote ref equality and clean tracking status observed. Receipt carried into P1 per delivery protocol.

## P1 — Evaluation and regression gates

- [x] **TE-005 — Make paired trials route-aware and isolated.** Use existing adapters, synthetic configuration, pinned settings, counterbalanced order, explicit call budget and redacted evidence.
  - Verified: all built-in adapter selectors, explicit stored/environment/local auth, private child roots before imports, isolated counterbalanced trials, hard admissions including probes, source/harness drift guards and matching provenance. Codex native baseline available; NVIDIA 400, OpenAI 401 and Gemini 503 classified, not accepted. Other live routes remain unvalidated, not silently substituted.
- [x] **TE-006 — Repair weak outcome verifiers.** Prove real background execution/wait and immutable fixture tests; add natural prompts without prescribed tools and independent hidden assertions (C01–C10).
  - Verified: complete coding/lifecycle definitions and positive/negative offline assertions; natural baseline receipts cover C01–C10, including actual PTY and production Responder wake/read. Independent hidden assertions and immutable package/tests remain enforced. Corpus corrections and earlier failed/inconclusive trials are retained in [P1 evidence](evidence/phase-1.md).
- [x] **TE-007 — Capture complete efficiency metrics.** Include failed attempts, repairs, cached/write/input/output usage, auxiliary work, first-token/task latency, local overhead and unknown values; report rounds separately from invocations.
  - Verified: attempts/admissions/logical rounds/invocations/successes/auxiliary work remain separate; failed/unknown usage, provider precision, latency/CPU/RSS, setup/request timings and conservative execution-reliability/repair counts are reported. Per-schema validity, unobserved probe usage, refresh time, pricing and eligible-prefix denominators remain explicit limitations and block candidate acceptance; no zero-cost or cache-pass inference.
- [x] **TE-008 — Build security fixture coverage.** Implement S01–S10 with known findings and negative controls, raw/header/redirect/TLS/body-digest evidence and scope assertions.
  - Verified: actual loopback HTTP/TLS, redirect credentials/cookies, true statuses, compressed decoded digests, positive/patched/404 controls, scanner status/size, exploit/fix, interruption and adversarial source tests; S01–S10 each passed the available native baseline route. No external target or real sensitive document used.
- [x] **TE-009 — Prove gates detect regressions.** Add D03–D13 and fault controls for early prefix mutation, tool reorder, wrong fix, missing evidence and extra request; preserve existing cache/provider tests.
  - Verified: [coverage ownership](evidence/phase-1-coverage.md) maps every baseline D01–D13 surface; negative controls reject source/history/prompt/schema drift, missing/incorrect evidence, wrong fixes, extra rounds, unknowns, bad budgets and wrong job/PTY lifecycle. New profile/version, candidate schema and packaging obligations remain explicitly owned by P3/P5/P6 rather than claimed implemented here.
- [x] **TE-010 — Deliver P1.** Baseline passes and negative controls fail as designed; update ledger/evidence, commit and verify branch push.
  - Verified technical gate: 934 files / 10,476 tests passed, 2 files / 32 tests skipped; final context 23 files / 203 tests passed after last harness corrections; app/audit types and prompt consistency pass. Delivery receipt is carried into P2 after commit/remote verification. This is a proof harness and limited-route baseline, not an optimized release or comparable cache pass.

## P2 — Strict-prefix improvements

- [x] **TE-011 — Identify remaining redundant future context.** Profile current upserts/section filtering/plan-state output; quantify only avoidable new content, not existing deduplication or user-owned requirements.
  - Verified: 1,000 samples of production paths; unchanged keyed/session/plan upserts add 0 messages/bytes; changed/clear/re-add preserve history. [P2 evidence](evidence/phase-2.md).
- [x] **TE-012 — Implement or reject safe suppression.** Preserve full authority, clear/re-add behavior and sent history; D03/D04/D07 plus quality fixtures pass. A justified no-op is acceptable and must state zero savings.
  - Decision: retain baseline, incremental startup/task savings 0; global seen-content suppression loses re-added authority and shortening plans drops criteria.
- [x] **TE-013 — Implement or reject equivalent local caching.** Only after profiling; output bytes/order identical, cache bounded and mutation-safe, no latency/memory regression.
  - Decision: reject an extra cache; prompt p95 0.357ms, selected tools 0.044ms and 60-task plan 0.062ms. Zero token benefit does not justify retention/invalidation risk. Runtime unchanged.
- [x] **TE-014 — Validate existing batching end-to-end.** D11/C06/C07 verify per-file results, partial errors, correct cursors and independent rounds without new tools or less verification.
  - Verified: partial success, missing-file, Unicode/range/cursor and independent-read concurrency checks; P1 natural runtime receipts retained. No new dispatcher or weakened verification.
- [x] **TE-015 — Deliver P2.** Publish measured benefit or retain-baseline decision; legacy prefix/catalog unchanged; all relevant gates pass; update ledger, commit and verify branch push.
  - Technical gate: 12 files / 140 tests and audit types pass; canonical and selected route digests unchanged. Commit/remote receipt carried into P3 after delivery.

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
