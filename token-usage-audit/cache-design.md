# Cache-safe optimization design

## 1. Non-negotiable invariants

| ID | Invariant | Required proof |
| --- | --- | --- |
| C1 | An established leading prompt and ordered native tool definitions remain byte-identical for the same session/route/profile. | Compare serialized provider inputs, not just internal hashes, over multiple turns and restart. |
| C2 | Sent history is immutable within a conversation segment. New facts/configuration/clears append after it. | Longest common prefix and full earlier-message equality; negative controls intentionally mutate an early byte. |
| C3 | Runtime permission/orchestration/MCP availability is enforced independently of the stable catalog. | Enable/disable/reconnect tests preserve schemas while blocked execution stays blocked. |
| C4 | Cache affinity is deterministic and session-isolated. | Existing `withSessionAffinity`, `cachePolicyFields` and cache-isolation tests remain green. |
| C5 | Provider-specific roles, tool names, argument serialization, reasoning signatures, images and breakpoints retain their existing contracts. | Actual request-body fixtures per serializer; no shared universal-normalization shortcut. |
| C6 | Continuation, retry, fallback, compaction and upgrade never silently pick a smaller prompt/schema for an already established profile. | Old-session replay across process restart and version change, plus fault injection. |
| C7 | Provider-exact usage, estimates, cache reads/writes and failed-attempt costs remain distinguishable. | Usage-parser and UI-projection tests; unknown is not zero. |
| C8 | Security evidence and coding contracts are not truncated or deferred merely to hit a target. | Independent outcome assertions and first-attempt tool checks in `validation.md`. |
| C9 | After normal warm-up, comparable cache-hit rate and eligible-prefix reuse are the same or better than baseline; no optimization-induced runtime prefix drift. | Paired warm-session measurements on matched routes/settings/workloads, plus byte-identical established-prefix assertions; report external misses and unknown usage separately. |

C1/C2 do not mean every request has the same whole-prompt hash: newly appended history changes the request and often the compiled fingerprint. Preserve the already-sent sequence and compare the reusable boundary. Likewise a stable logical fingerprint is insufficient: `compileRequestPlan` excludes request-context messages from some sections, while adapters still send them.

## 2. Lane S: strict continuity

Allowed without changing an existing profile:

- Offline instrumentation and evaluation tooling that adds no model-visible bytes and no hot-path work when disabled.
- Deterministic caching of rendering/serialization only if output, mutation isolation, memory use and latency are proven equivalent or better. Do not add another cache without profiling a real cost.
- Avoid producing redundant **new** state notices when their complete authoritative content is already available. Existing exact-duplicate suppression is the baseline; new suppression requires explicit dependency/version accounting.
- Make use of existing independent-call execution and `fs.read.files`; measure model rounds rather than removing useful tools.

Forbidden:

- Editing the existing prompt or description strings, even punctuation, under the same profile.
- Sorting/changing the tool array, renaming tools, removing aliases, or moving dynamic material into the leading prompt.
- Deleting/summarizing previously sent history to create a shorter prefix.
- Lowering output/reasoning budgets, switching models, reducing evidence fidelity, changing authorization behavior or changing UI estimates to claim savings.

A newly appended context section can be improved without invalidating earlier prefix bytes, but can still affect model quality. It needs evaluation too. If a proposed optimization is already implemented or offers no measured benefit, retain the current implementation and close it as a documented no-op, not fictitious savings.

## 3. Lane V: versioned new-session experiment

**Part of the optimization roadmap, gated by evidence rather than a separate prefix-change approval.** The user permits a different optimized prefix after the fixes. The invariant is that the selected prefix stays stable while the agent runs and yields same-or-better comparable cache reuse. Evaluate a candidate in isolated sessions, then make a passing profile the new-session default at release. Do not activate an untested candidate or hot-swap an established session.

A new profile has a normal initial warm-up; preserving cache entries from an older release's different text is not the requirement. Keeping `prompt_cache_key` unchanged cannot transfer KV states to changed text. Same-profile resume/continuation must remain stable, and unsupported cross-version reuse must not be claimed.

### Minimal profile model (explicit experimental path implemented in P3)

`src/prompts/profile-{state,binding}.ts` and `legacy-profile.ts` implement durable explicit bindings. Ordinary unbound sessions keep the legacy path; no optimized default is active. [P3 evidence](evidence/phase-3.md) records preservation tests, ambiguous-old-history limits and measured explicit-path overhead. The lifecycle below remains the release contract; implemented storage does not prove cache/performance rollout gates.

An immutable profile manifest needs:

- a versioned ID and content digest;
- exact full/native/text instruction artifacts or references to immutable bundled artifacts;
- ordered canonical tool definitions, including descriptions and parameter constraints;
- explicit internal capabilities used for mode-guidance composition;
- serializer/profile format versions and tested route compatibility;
- provenance linking to baseline, evaluation report and release decision.

Do not include clock, working directory, current task, authorization state, active MCP catalog, selected skills, metrics, mutable flags or session identity in this content-addressed profile. They remain runtime state or appended context. Profile IDs/metrics are local metadata, not extra prompt text.

A route binding distinguishes the provider/model and effective protocol/modality/catalog shape needed by current routing. A native/text fallback or provider switch is not automatically cache-equivalent. Model those transitions explicitly using current request/replay compatibility rules; preserve the old route's binding when returning to it.

### Integration surfaces

| Contract | Existing surface | Intended responsibility |
| --- | --- | --- |
| Selection | `src/agent/turn/tool-routing.ts`, `src/agent/runner.ts` | Resolve a profile once for a new route; reuse its exact prompt/tool artifacts. Keep existing native/text/vision semantics. |
| Session lifetime | `src/agent/session-policy.ts`, `src/app/controllers/session-controller.ts` | Retain profile bindings across turns; restore them before generating the next request. |
| Persistence | `src/store/history/recovery.ts`, `src/store/history.ts`, `src/store/history/sqlite-backend.ts`, `src/store/history/jsonl-backend.ts` | Store versioned profile references, preserve them in JSONL/SQLite export/import/recovery and backups. Do not persist authorization grants as part of this change. |
| Prompt composition | `src/prompts/index.ts`, `src/agent/turn/system-sections.ts`, `src/agent/turn/setup/turn-messages.ts` | Explicit capability flags replace brittle source-text detection while legacy output stays identical. |
| Wire/cache | `src/llm/request-plan.ts`, `src/llm/cache-policy-fields.ts`, `src/llm/adapters/`, `src/llm/responses-request.ts` | Validate existing output invariants; do not redesign transport or affinity solely for token savings. |
| Generated artifacts | `scripts/embed-prompts.mjs`, `src/prompts/embedded.ts` | Deterministic generation for explicitly selected profiles; source and packaged builds agree. |

Proposed new modules may be small focused profile manifest/resolver modules under `src/prompts/`; choose names during implementation. Do not grow `runner.ts`, `index.ts` or the session controller into a second framework. Preserve existing dependency versions and avoid broad rewrites.

### Lifecycle and migration

1. **Legacy session still running:** retain its currently bound prompt/schema exactly; never hot-swap on a config refresh.
2. **New session during development/evaluation:** use the legacy default unless the isolated trial explicitly selects a candidate.
3. **New session after validated release:** select the released optimized default, resolve once and bind once. A per-session opt-in is not required; profile identity remains metadata outside the prompt.
4. **Restart/resume with known profile reference:** load exact immutable artifacts before constructing the next turn; no fallback to current default.
5. **Legacy history without profile metadata:** attempt only a deterministic mapping to a known legacy artifact based on trustworthy stored provenance. Do not guess from the present model/context limit or reconstruct missing bytes from a summary. If identity cannot be established, require a user-visible continuation/new-session decision rather than silently claiming continuity.
6. **Missing/corrupt/unsupported profile:** fail safely before network submission with actionable recovery. Preserve history and do not discard tasks or job ownership.
7. **Upgrade:** ship legacy artifacts for the supported history compatibility window; test an old history against the new executable.
8. **Rollback:** select legacy for future sessions only. Keep a candidate session pinned to its candidate artifact if continued; otherwise end it and explicitly start a new legacy session. Never switch its tools mid-flight.

Legacy resume compatibility is itself a release gate: profile work must not turn previously supported ordinary resumes into routine failures or new mandatory prompts. If no safe mapping can satisfy both exact continuity and existing resume behavior, do not deploy the resolver change; retain the working legacy path and block candidate rollout. Recovery decisions above describe ambiguous/corrupt experimental bindings, not permission to break supported histories.

Profiles should be bundled or loaded once into a bounded immutable cache. Persist a small content-addressed reference rather than duplicating a large catalog each turn. Avoid network retrieval and synchronous per-request disk I/O. If exact artifacts must be retained externally, use atomic writes, validated digests, redaction-safe content and reference-aware retention. Do not remove an artifact still referenced by resumable history.

## 4. Provider-wire preservation

- OpenAI-compatible chat and Responses use distinct wrappers and role representations. Keep stable ordered function metadata and tool/result IDs. Compare `buildChatBody` and `buildResponsesBody` outputs, not just `ToolDefinition[]`.
- Anthropic separates the first system block, preserves signed thinking, and adds conversation cache breakpoints. `src/llm/adapters/anthropic-tools.ts` currently uses a 20-block lookback and at most three conversation breakpoints; test these with `src/llm/anthropic.ts`, not a new universal heuristic.
- Gemini sanitizes schemas and carries its own function-call/signature rules. Shortened schema candidates must pass the existing sanitizer and replay tests without weakening constraints.
- Gateway/provider capability layers can reject optional cache fields. Preserve existing suppression/fallback behavior; do not introduce new provider API options as part of this roadmap without separate evidence.
- Reasoning controls, sampling, modality and route changes may change the provider-rendered context. Record them and distinguish an explicit transition from accidental drift.
- Compaction necessarily changes some conversation content. Preserve the existing tested reusable source prefix and instruction continuity; do not advertise whole-history cache continuity through arbitrary compaction. Do not change compaction frequency to manufacture a smaller startup metric.

## 5. Prompt and schema optimization boundaries

The candidate must have a rule-to-test map before prose is removed. Consolidate semantic duplication, not safety/correctness requirements. Keep a concise core covering both coding and security; do not classify an entire session as one domain and dynamically swap the core when the task changes.

For native routes, put precise argument mechanics in attached tool schemas and avoid repeating complete schemas in the prompt. For text routes, retain discoverable names, argument examples and parsing guidance; their lower token estimate is not grounds to disable native tools.

Keep tool names, required arguments, enums, units, defaults, bounds, aliases and side-effect flags stable initially. Shortening descriptions is already a new-profile change. Any constraint correction, such as `web.fetch.maxBytes`, must be explicit and checked against the runtime validator. Do not remove useful constraints to make a schema smaller.

Do not use lazy tool discovery for core tools: it adds model rounds and selection uncertainty. Keep MCP's existing fixed-control discovery approach. No generic “do everything” operation dispatcher or shell-only tool collapse is recommended.

## 6. Decision record requirements

For each proposed change record: hypothesis, source owner, legacy bytes affected or not, expected full-request savings, counterexamples, test IDs, measured actual savings, tool/error/round delta, quality outcome, latency distribution, cache proof and rollback. Any unknown critical field blocks activation.

No active-profile rollback toggle, hidden cache-key salt, random tool ordering, prompt minifier or provider-specific shortcut is an acceptable substitute for this design.
