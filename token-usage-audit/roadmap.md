# Phased implementation roadmap

This is the future implementation plan, not authorization to change production behavior now. Execute using [tasks.md](tasks.md), with [IMPLEMENTER.md](IMPLEMENTER.md) governing phase evidence and commits. Every phase may conclude “retain baseline” when evidence rejects its hypothesis.

## Dependency graph

`P0 baseline/contract lock → P1 proof harness → P2 strict-prefix improvements`

`P1 → P3 durable profile compatibility → owner version-transition approval → P4 prompt candidate → P5 schema candidate → P6 evaluation/release`

P2 and P3 are separable after P1, but implement one coherent phase at a time. P6 also evaluates any P2 candidate; if version-transition approval is withheld, close P4/P5 as blocked and complete the strict-lane report without enabling them. Do not claim a whole-program optimization is complete while required gates are blocked.

## P0 — Establish a reproducible baseline and coverage ledger

**Purpose:** measure the actual problem before changing its denominator.

**Work:**

- Re-run the supplied local evidence against the current base and record commit, OS/runtime, provider/model, dialect, profile settings, MCP/vision/orchestration state and configuration provenance.
- Extend `scripts/measure-token-overhead.ts` to include actual `buildSystemSections`/runner request assembly with synthetic project, skill, plan and scope fixtures. Keep isolated configuration; do not read a user's secrets or dump their prompt.
- Measure canonical definitions and final serialized provider bodies separately. Include prompt, mode/workflow, environment, project rules, skills, plans, scope, tools, history, images and reasoning artifacts. Capture count source: character estimate, tokenizer estimate or provider-exact.
- Create rule-to-test and tool-contract ledgers. List exact coverage for coding, security, query/directive, background/terminal, plan continuation, MCP and compaction. Link retained responsibilities to source and assertions.
- Preserve baseline schema/source hashes. Test stable order as well as membership. Preserve the current selected-tool count per route; do not reduce it during measurement.

**Affected surfaces:** `scripts/measure-token-overhead.ts`, `scripts/token-overhead-fixtures.ts`, `src/agent/request-accounting.ts`, `src/agent/context-breakdown.ts`, `src/llm/context-snapshot.ts`, tests under `test/context/` and `test/conformance/`. Prefer offline harness extensions; runtime instrumentation is opt-in, redacted, allocation-light and off by default.

**Gate:** no source behavior or wire-byte difference; deterministic fixtures repeat identically; observed versus estimated tokens clearly labelled. User's exact session remains unknown unless captured with consent.

**Cleanup/rollback:** remove temporary probes, retain compact non-sensitive evidence and reproduction commands. Revert measurement-only hooks if they change hot-path output or measurable latency.

## P1 — Make quality, cache and performance claims falsifiable

**Purpose:** prevent the optimizer from passing by using weaker tests or easier tasks.

**Work:**

- Refactor `scripts/evaluate-token-overhead.ts` into small harness components as needed. Retain its paired trials but parameterize existing provider adapters rather than adding a new transport.
- Add the scenario matrix in `validation.md`, including natural prompts that do not prescribe tool names. Fix weak verifiers such as background `/42/`; prove actual process/job/cursor/receipt behavior.
- Capture every attempt (including invalid calls, blocked calls and failed requests), model rounds, exact/unknown token usage, warm/cold state, first-token latency, task latency, assembly time and memory. Do not count only successful callbacks.
- Add intentional-negative controls: early prompt byte change, description change, tool reorder, one mismatched argument, missing evidence, incorrect code fix, and an extra discovery round. Every relevant gate must detect its injected defect.
- Test live-request stability at the final serializer boundary for chat, Responses, Anthropic, Gemini and gateway profiles already supported by the repo. Keep signature/image/tool-result placement tests intact.
- Redact request captures by construction and use only synthetic security fixtures. Store restricted raw wire fixtures only when needed; committed evidence contains hashes/counts and sanitized assertions.

**Affected surfaces:** existing evaluation/fixture scripts; `test/llm/context-prefix-wire.test.ts`, `test/agent/stable-catalog-cache-continuity.test.ts`, `test/agent/compaction-cache-fidelity.test.ts`, provider adapter tests, HTTP and filesystem tests. Add dedicated evaluation-harness tests; do not weaken old snapshots to accommodate a candidate.

**Gate:** baseline passes mandatory functional assertions; negative controls fail for the intended reason; incomplete provider runs are blocked/unknown, not accepted. No model-visible instrumentation.

**Cleanup/rollback:** replace duplicate metrics/weak verifiers rather than leaving competing acceptance paths. Keep a single report schema and document any compatibility reader. Revert harness-only changes if baseline behavior is affected.

## P2 — Ship only measured strict-prefix improvements

**Purpose:** reduce repeated work/context without changing the existing leading prompt/catalog.

**Work:**

- Profile `composeTurnMessages`, `dropSectionsAlreadyInHistory`, `upsertKeyed`, `upsertSessionStateMessage` and plan/context emitters on repeated turns. Existing exact deduplication is the starting point, not a new feature.
- Identify redundant newly emitted boilerplate separately from authoritative plan detail, task criteria, scope, project instructions and recovery state. Require version/source identity for suppression; substring similarity alone cannot prove equivalence.
- Keep the latest authoritative state complete. Never remove already-sent messages, clear markers, task dependencies or safety-relevant state. Test changes, no-change, clear, re-add, resume and compaction.
- Where profiling supports it, memoize immutable prompt/schema derivation by complete semantic inputs. Prove cloned/immutable outputs cannot be mutated by consumers. No per-turn disk/network work or unbounded memoization.
- Verify existing batching: independent calls in one round and `fs.read.files` return labelled per-entry results. Do not add a universal batch/dispatcher tool or combine dependent edits to reduce a counter.
- If there is no material safe gain, record a no-op decision and retain baseline behavior. Do not modify prompts to force an apparent result.

**Affected surfaces:** `src/agent/turn/setup/turn-messages.ts`, `src/agent/injected-blocks.ts`, `src/agent/session-state.ts`, `src/agent/turn/system-sections.ts`, `src/agent/plan/context-message.ts`, `src/agent/turn/tool-result-recorder.ts`, `src/agent/reliability-policy.ts`. Edit only surfaces implicated by evidence.

**Tests:** `test/turn-request-context-trim.test.ts`, `test/agent/system-sections.test.ts`, `test/agent/prompt-sections.test.ts`, `test/agent/session-state-projection.test.ts`, `test/token-overhead.test.ts`, `test/fs-read-multiple.test.ts`, `test/tools/fs-read-concurrency.test.ts`, cache matrix and selected live behavior matrix.

**Gate:** established prefix/tool bytes unchanged; no lost authority/evidence; measured full-task benefit with no quality/error/round/latency regression. Startup savings may be small or zero.

**Cleanup/rollback:** delete superseded emission paths only after no callers remain. Preserve historical stored messages. Roll back by restoring prior future-emission behavior, never by rewriting stored history.

## P3 — Lock immutable profiles across restart and upgrade

**Purpose:** make a future prompt/schema change safe for existing sessions.

**Work:**

- Implement the minimal versioned profile and lifecycle in `cache-design.md`; bind legacy artifacts first with identical bytes. New candidate activation remains disabled.
- Replace source-text substring detection of execution coverage with explicit internal capabilities. Preserve legacy assembled output exactly, including compact/full mode behavior.
- Persist route-profile references through session history, JSONL/SQLite, imports/exports, backups, resume and reset. Trace all `HistoryRecord` construction/projection sites before editing types.
- Preserve session-affinity and auxiliary-request isolation. Do not change cache keys as a workaround or bind user-specific dynamic content into the static profile.
- Add migration handling for unknown legacy profiles and missing/corrupt artifacts. Do not guess or silently select the current default; surface a continuation decision before sending a changed request.
- Test new process + old history + changed default/config/build, native/text fallback, provider switch and return, compaction, MCP changes and cancellation/job resume. Preserve supported old artifacts without scattering obsolete implementations.

**Affected surfaces:** profile modules under `src/prompts/` (new, small); `src/prompts/index.ts`; `src/agent/runner.ts`; `src/agent/turn/tool-routing.ts`; `src/agent/session-policy.ts`; `src/app/controllers/session-controller.ts`; `src/store/history.ts`; `src/store/history/recovery.ts`; JSONL/SQLite backends and persistence callers; build/embed integration if required.

**Tests:** extend `test/app/session-cache-continuity.test.ts`, `test/agent/tool-routing.test.ts`, `test/native-prompt-cache-cross-turn.test.ts`, `test/openai-prompt-cache-cross-turn.test.ts`, `test/llm/session-cache-isolation.test.ts`, history persistence/recovery suites. Add an actual fresh-process upgrade/resume fixture, not just two calls sharing one map.

**Gate:** all legacy routes render identically before/after; no authorization state persistence expansion; old history loads; corrupt metadata fails safely; no hot-path latency/memory regression. Candidate version transition requires separately recorded owner approval after this gate.

**Cleanup/rollback:** one authoritative profile resolver; explicit retained compatibility artifacts, no dead flag combinations. Reverting the resolver must not strand newly written histories; demonstrate downgrade handling or keep the reader until migration is safe.

## P4 — Evaluate a denser instruction profile (approval-gated)

**Purpose:** remove duplicated expression without removing responsibilities.

**Work:**

- Create one candidate profile, leaving legacy prompt and schema artifacts untouched. Change prompt only first; keep schemas identical so attribution is possible.
- Consolidate the largest duplicated instruction responsibilities using the P0 rule-to-test map. Keep both coding and security behavior, query/directive distinction, scope, evidence discipline, error recovery and continuation intact.
- Keep native argument contracts in tools; retain text-route tool names/examples and parser guidance. Do not force text protocol because its estimate is lower.
- Measure complete request assembly after each candidate. Explicit profile capabilities must prevent a shorter core from accidentally reintroducing the 5,431-character mode directive.
- Keep project rules, user instructions, full plan acceptance criteria, engagement scope and active skill content intact. Do not use lossy summaries or per-task prompt switching to pass the budget.
- Regenerate embedded artifacts deterministically and test source/Bun/Node/distributed prompt consistency.

**Affected surfaces:** new candidate prompt artifact(s), `src/prompts/index.ts`, `scripts/embed-prompts.mjs`, `src/prompts/embedded.ts`, profile manifest/resolver, mode-composition tests. No edits to the legacy content used by established sessions.

**Gate:** all obligations have equivalent coverage; offline tests and paired model pilot pass; no extra invalid calls/rounds/latency, no loss of security evidence. A lower character count alone does not close this phase.

**Cleanup/rollback:** retain only the approved candidate and required legacy artifact, not a pile of unreferenced experiments. Rejecting the candidate means leaving it disabled or removing unreferenced experimental files; never changing an active binding.

## P5 — Evaluate concise, precise tool descriptions (approval-gated)

**Purpose:** reduce the other large fixed cost without making tools harder to call.

**Work:**

- Use `tool-catalog.md` and the per-tool contract ledger. Keep all currently selected capabilities and canonical/wire names; no default mergers/removals.
- Shorten repeated descriptive prose in the highest-cost tools first. Preserve required fields, schemas, aliases, bounds, units, defaults, ordering, flags and tool-result semantics. Test each family in isolation before combining changes.
- Correct the candidate `web.fetch.maxBytes` bounds using shared validation constants; add boundary parity tests. This may add tokens and is preferred to a retry.
- Validate final emitted schemas after enrichment/sanitization, not just definition source. OpenAI/Anthropic/Gemini adapters and text-route guidance must agree with runtime acceptance.
- Keep `http.fetch` and its evidence contract. Keep terminal/secret/cursor tools, wait/read acknowledgments, filesystem batch semantics, media and MCP controls.
- Freeze and hash the final ordered candidate catalog. Update intentional candidate snapshots separately; the existing legacy hash remains protected.

**Affected surfaces:** `src/tools/definitions/` candidate description data, profile resolver, `src/tools/definitions.ts`, `src/llm/adapters/openai-tools.ts`, `src/llm/adapters/anthropic-tools.ts`, `src/llm/adapters/gemini-tools.ts` (tests/compatibility, not gratuitous rewrites), `src/tools/web/validate-args.ts` and constants if deduplicating bounds; text prompt generation.

**Gate:** schema/runtime parity; all first-attempt contract fixtures pass; live unprompted selection remains correct; no added tool errors, repairs or model rounds. Run combined P4+P5 trials as well as individual attribution trials.

**Cleanup/rollback:** one source of truth per profile for description/constraints; remove superseded candidate generators and update embed/check scripts. Retain legacy serialized definitions and all old-history-compatible names. No global hash replacement to hide changed legacy bytes.

## P6 — Evaluate, decide, release and monitor

**Purpose:** ship only demonstrated gains, or honestly retain baseline.

**Work:**

- Execute the full offline suite and staged paired live evaluation from `validation.md`. Test cold startup and warm multi-turn tasks separately, plus long-session/recovery paths. Include supported smaller models, not only the strongest model.
- Report percentage reduction per route and full task, actual cache reads/writes/unknowns, latency distributions, first-attempt validity, tool errors, rounds, quality and local resource use. Include failed attempts and auxiliary work.
- If the 50% aspiration fails but a smaller safe gain passes every gate, recommend that gain. If any material regression or uncertainty remains, keep the candidate disabled; do not relax the gate retrospectively.
- Publish explicit supported/validated routes. No global-default claim from one provider. Offline coverage is mandatory for all affected serializers; missing live access blocks universal rollout.
- Activate only owner-approved new-session profiles after every applicable gate. Existing sessions remain pinned. Preserve a new-session-only rollback and compatibility artifacts.
- Observe canary sessions for unexpected prefix drift, malformed calls, repeated reads, permission mistakes, cache misses, latency and quality. Use existing redacted telemetry facilities; no telemetry network opt-in changes.
- Finish the cleanup/search/build/package review and reconcile every task before final report. Document blocked routes, rejected optimizations and residual uncertainty.

**Affected surfaces:** evaluation scripts/reports, profile selection configuration only if approved, user-facing documentation, relevant help/config tests, build/package manifests if a new artifact must ship. Preserve the locked dependency set.

**Gate:** the decision record explicitly states release/retain-baseline/blocked, the evidence supports that state, and phase changes are committed/pushed. Runtime smoke covers Node and Bun distribution paths; no server is required for this CLI-only change except isolated test fixtures, which must be cleaned up.

**Cleanup/rollback:** remove unreferenced experiment code/flags, dead exports and stale instructions; retain intentionally referenced legacy artifacts. Test new-session rollback without mutating any existing profile. Push the final phase only after reconciliation and clean verification.
