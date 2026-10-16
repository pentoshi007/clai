# P4 — Isolated instruction-density experiment

## Decision

**Reject promotion; retain the ordinary legacy default.** `density-v1` remains an explicitly selected evaluation/compatibility artifact, never a runtime default or per-task toggle. Deterministic preservation passed, but the limited model pilot did not meet the no-extra-errors/rounds/full-task/latency gate. TE-022 cache eligibility and broader route coverage also remain unresolved. No global quality equivalence, performance improvement or cache benefit is claimed.

P3 delivery receipt: `3217f2726532710a9bc2e78d3c832de15e068b52` was pushed and remote equality verified before P4. P4's commit/push receipt is carried into P5. Dependencies and lockfile are unchanged.

## Hypothesis and implementation

Consolidating only the three coding/build/debug sections could reduce fixed input without removing responsibilities. The [obligation map](prompt-density-map.md) owns every source clause. Security, tool/protocol, scope, plan, skill, project and user content is untouched. Compact rendering is deliberately unchanged. No catalog pruning, model/budget change, native-to-text substitution, evidence reduction or `http.fetch` replacement occurred.

- Sources: `src/prompts/{candidate-density-sections.md,density-profile.ts,profile-catalog.ts}`.
- The existing generator emits/checks legacy content unchanged plus one isolated embedded candidate.
- The central resolver accepts explicit `density-v1`; profile storage retains exact bound artifacts on restore.
- Evaluation config has a strict candidate whitelist. Matching before/after sessions select `legacy-v1` / `density-v1` from the same frozen checkout. Reports record actual profile ID and digest, rather than falsely attributing candidate runs to legacy.
- Candidate digest: `ba3153aa928b0d27a8197dca298e666651013e53d5c1703d4e88d91a165edf22`; baseline explicit profile digest: `158f25567937d0df1371e8f4bf68d8ccf1809aba88bfb4b03e52af15347c12bf`.

## Offline measurements

All 64 production assembly shapes are compared. The 32 full-core cases remove 2,656 core characters and 2,735 serialized wire bytes each. Full-request character-based token estimates decrease by 804–805 tokens, **2.72–4.65%**, depending on route/context. The 32 compact cases have **zero change**. These are estimates, not provider counts or complete-task savings.

| Synthetic route | Baseline estimated input | Candidate estimated input | Reduction |
| --- | ---: | ---: | ---: |
| Coding, native/full/local/nonvision | 24,109 | 23,304 | 3.34% |
| Security, text/full/local/nonvision | 19,329 | 18,524 | 4.16% |
| Coding, native/compact/local/nonvision | 15,663 | 15,663 | 0% |

Scratch evidence: `tests/p4-assembly.json` under the active session scratch. Production accounting and final wire are measured; tools/history/dynamic content are independently equal, so shorter core wording does not accidentally reinsert mode guidance.

## Limited paired model pilot

Configuration: `live/p4-pilot.json`; same checkout, Codex `gpt-5.6-luna`, native, thinking enabled/medium, stored authentication, three counterbalanced pairs per selected natural coding/security fixture, maximum 60 generation admissions. Completed **12 trials / 44 admissions**, with all independent final outcomes passing. This is a two-fixture pilot, not the mandatory complete matrix or a holdout.

Reports: `live/token-evaluation-wkmtzY`; analyzed receipt: `tests/p4-live-summary.json`. Both are under the active session scratch. Every before/after first request reports provider-exact usage and actual profile/digest provenance.

| Fixture / repeat | First input, before→after | Full-task input, before→after | Model rounds, before→after | Elapsed ms, before→after |
| --- | ---: | ---: | ---: | ---: |
| Coding / 1 | 15,118→14,505 | 80,494→76,472 | 5→5 | 14,837→16,397 |
| Coding / 2 | 15,117→14,505 | 80,832→92,203 | 5→6 | 16,157→15,907 |
| Coding / 3 | 15,117→14,506 | 78,976→93,356 | 5→6 | 14,054→16,665 |
| Raw-security evidence / 1 | 15,143→14,532 | 30,731→29,546 | 2→2 | 6,850→8,042 |
| Raw-security evidence / 2 | 15,144→14,532 | 30,713→29,536 | 2→2 | 6,432→8,910 |
| Raw-security evidence / 3 | 15,145→14,530 | 30,720→29,495 | 2→2 | 6,988→6,789 |

Coding repeat 2's candidate issued `git status` in a non-repository workspace, producing exit 128, one tool error and a corrective round; baseline did not. Repeat 3 also used an extra call/round. These observations fail the conservative gate; this small sample does not establish that prose compression caused every difference. No expanded paid run is justified for promoting this version. Latency/resource differences are not an established distribution-level performance pass.

Known cache-hit/reuse rates are **null**: warm requests exist but provider eligibility is unknown. A reported zero eligible count is not evidence that none were eligible. Existing P1 unavailable/unsupported route receipts remain applicable; no universal rollout scope is inferred.

## Verification and failures retained

- Application and audit TypeScript checks pass. Initial implicit-any error in the new renderer was fixed with the precise binding type.
- Focused P4 suites: **6 files / 161 tests pass**; includes 64 legacy locks, 64 candidate assemblies, clause-deletion negative controls, unchanged other sections, config rejection, restore binding and actual-runner provenance.
- Adjacent persistence/cache/compaction/prompt regressions: **8 files / 42 tests pass**.
- The first repeated in-process evaluator test exposed its removed first workspace's cached configuration; tests now reset imported modules between trial simulations, matching the actual evaluator's fresh-process isolation. No production config behavior was weakened.
- Prompt generator `--check`, application build and package dry-run pass. All required density/catalog/legacy distribution modules are packaged.
- Node distributed CLI prints `4.15.2`. An initial mistyped `bin/clai.js` probe failed; the manifest's actual `bin/clai.mjs` passed.
- Source versus distributed digest/rendering and restored bindings pass in Node and a **Bun-compiled executable**, both printing the digest above.
- Legacy agent/ask/embedded/index bytes remain unchanged; canonical 47-tool baseline lock is retained.

## Cleanup, compatibility and next phase

The retained candidate is intentionally referenced by the strict evaluator, resolver, tests and generated/distributed artifacts; it is not dead/unreferenced code. No default activation, environment switch, history rewrite or live fixture process remains. P5 may investigate schemas alone against legacy, but cannot treat this rejected prompt pilot as a passing combined prerequisite. Any combined experiment is exploratory and cannot override P4's failed release gate. P6 must retain baseline unless every unresolved criterion is genuinely resolved.
