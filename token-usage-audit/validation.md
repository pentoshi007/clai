# Validation and release gates

## 1. What is being compared

Compare the unchanged baseline and one isolated candidate against identical fixture revisions, models, provider routes, sampling/reasoning settings, permissions and work limits. Record every differing configuration field. Use unique isolated workspaces/config/history and distinct sessions per trial; do not change dependencies between variants.

Use paired, counterbalanced ordering (A/B and B/A). Separate cold/new-prefix trials from repeated warm multi-turn trials. Do not warm one candidate and compare it with a cold baseline. A provider cache miss alone is not proof of a prefix bug: inspect serialized content/settings and cache availability.

Retain a development corpus and an unseen holdout corpus. Several current fixtures name the intended tools; keep those for contract testing and add equivalent natural-language tasks that do not leak the desired tool path. No fixture is weakened or removed because the candidate fails it.

## 2. Metrics and provenance

Each trial report must contain:

- baseline/candidate commit, profile ID/digest, fixture version, route/dialect, model, settings, tool count and ordered schema digest;
- cold/warm designation and previous successful request identity, with redacted session IDs;
- stable prompt, schema, dynamic context, history, image and reasoning contributions, identifying estimates versus actual provider usage;
- all attempted/accepted/failed requests, model rounds, tool invocations, invalid/unknown arguments, repairs, blocked calls and retries;
- first-attempt validity: intended calls accepted without argument repair or corrective model round, with expected negative-input tests categorized separately;
- actual input, output/reasoning, cached-input and cache-write tokens when reported; unknown remains unknown, not zero;
- total task tokens including failed attempts, compaction and auxiliary/delegated work; do not count only the final successful response;
- provider cost only when pricing is known and versioned; never equate cached input with zero context or free input;
- time to first visible response token, total verified-task latency, provider/tool time, local assembly time, peak memory and artifact size;
- independent final-state/answer correctness, security evidence completeness, scope/permission decisions, and verification completion;
- stable wire prefix length/digest, first differing position and reason for any intentional route/profile transition.

A useful headline is `1 - candidate_first_input / baseline_first_input`, but publish the full-task ratio too. Keep numerator/denominator on the same route, fixture and measurement basis. Separate reduced token volume from a changed cache price or fewer verification steps.

## 3. Deterministic coverage matrix

| ID | Scenario | Assertions beyond “tool exited zero” |
| --- | --- | --- |
| D01 | Short coding/security/read-only first turns | Full component accounting; selected schema order/count stable; user request appears once. |
| D02 | Full/compact/native/text, MCP present/absent, vision capable/incapable | Existing route semantics preserved; no hidden switch to text or missing tools. |
| D03 | Environment hour/cwd, scope, plan, skill and project-rule updates | Only new tail entries change; prior wire prefix unchanged; latest authority and clear markers recognized. |
| D04 | Identical repeated context, clear and re-add | No new duplicate when already safely represented; changed state never suppressed. |
| D05 | Native tool calls/results across multiple turns | IDs, names, order, argument encoding and pair adjacency retained. |
| D06 | MCP discovery/paging/reconnect/login/selection and orchestration toggles | Fixed catalog retained; permissions still enforced; no unavailable tool executed. |
| D07 | Compaction, responder receipt, cancellation, continue and fallback | No completed work rerun; unread receipts/tasks preserved; reused prefix exactly the supported segment. |
| D08 | Fresh-process restart and old-history upgrade/downgrade | Same profile bytes restored; unknown/corrupt bindings stop safely, without discarded history. |
| D09 | Anthropic >20 blocks, signed reasoning, images; Gemini sanitizer/signatures | Correct provider-specific breakpoints and replay; no blind cross-route replay. |
| D10 | Schema boundary and alias validation | Required/enum/min/max/units reflect runtime; positive and invalid boundary cases; actual emitted schemas inspected. |
| D11 | Multi-file read: mixed success, missing file, large file, pattern/range, Unicode/CRLF | Per-file evidence survives partial failure; correct continuation cursor; no missing successful entries or retrying all files. |
| D12 | Build/embedding/package compatibility | Source and generated profiles match; legacy digests unchanged; Node/Bun paths include required artifacts. |
| D13 | Intentional fault controls | Changed early prompt, schema reorder, missing header, wrong code fix, extra round and weak verifier all cause the expected gate failure. |

Existing anchors include `test/token-overhead.test.ts`, `test/prompt-assembly-contract.test.ts`, `test/context/request-accounting.test.ts`, `test/agent/stable-catalog-cache-continuity.test.ts`, `test/llm/context-prefix-wire.test.ts`, `test/agent/compaction-cache-fidelity.test.ts`, `test/app/session-cache-continuity.test.ts`, `test/llm/session-cache-isolation.test.ts`, `test/llm/adapters/gemini-schema-sanitize.test.ts`, `test/fs-read-multiple.test.ts` and `test/tools/definitions.test.ts`. Extend coverage; passing them unchanged is necessary but insufficient.

## 4. Coding behavior matrix

| ID | Fixture | Independent outcome |
| --- | --- | --- |
| C01 | Focused regression repair with natural prompt | Original failure reproduced, minimal correct fix, hidden boundary tests pass, no test weakening. |
| C02 | Multi-file contract change | All callers/types/schema/config remain consistent; unrelated files unchanged. |
| C03 | Exact edit with CRLF/Unicode and stale/no-match input | Byte-sensitive content preserved; fresh evidence before retry; no identical failed edit loop. |
| C04 | Read-only question following a build request | Accurate answer with no write/install/server/plan side effects. |
| C05 | Existing project versus new app, error/empty states | No accidental re-scaffold; actual feature works, persistence/reload and failure paths verified. |
| C06 | Independent known-file reads and targeted search | Correct paths/filter placement; one batch/round when supported; no filler reads or invented unread content. |
| C07 | Finite foreground, finite background, persistent server and Responder | Correct lifecycle, sufficient timeout, no duplicate launches/poll loop; proper ready probe and receipt acknowledgment. |
| C08 | PTY/secret interaction and cancellation | No secret in arguments/logs; cursor-safe send/read, no input resend, verified cleanup. |
| C09 | Long roadmap with pause/continue/compaction | Correct phase boundary, all criteria retained, completed work not repeated, no premature completion. |
| C10 | Tools partially fail or provider retries/falls back | Root cause handled, partial successes retained, failed-attempt tokens counted, no hidden permission bypass. |

Do not require the model to use fewer verification steps to pass token gates. Freeze an expected evidence checklist for each fixture so an apparently fast but under-tested answer fails quality.

## 5. Security behavior matrix

Use local owned synthetic fixtures with known findings and negative controls. No real sensitive data or unrelated external targets are needed for these evaluations.

| ID | Fixture | Independent outcome |
| --- | --- | --- |
| S01 | Raw HTML with finding only in comment/hidden attribute/header | Required evidence is captured and identified; readable extraction alone fails. |
| S02 | Redirect chain with repeated cookies/headers and cross-origin hop | All relevant statuses/headers retained; credentials stripped by default; explicit forwarding tested separately. |
| S03 | 401/403/404/500 and transient status behavior | Real status/body not filtered into fake success; retries only when requested; no unearned vulnerability claim. |
| S04 | TLS/self-signed lab, private/loopback destinations, scope changes | Correct policy and ownership checks per hop; TLS bypass explicitly recorded; no broadening scope for convenience. |
| S05 | Large/compressed response with important early and late evidence | Capture versus displayed truncation explicit; body digest is of the correct captured bytes; complete evidence recoverable without unnecessary refetch. |
| S06 | Known authz/injection flaw plus patched/negative-control endpoint | Correct confirmed/not-reproduced distinction, minimal reproducible proof, meaningful impact/remediation; no claim from headers alone. |
| S07 | Recon/fuzz synthetic output and nonexistent-path baseline | Status and size retained with machine-readable evidence; noise filtered without hiding findings/errors; no duplicate scanners. |
| S08 | Security issue inside a codebase | Both exploitability reasoning and safe coding fix verified; relevant regression/negative tests pass. |
| S09 | Security work with terminal/job interruption | No duplicate active scan/session, cursor/ownership preserved, continuation reports real evidence and gaps. |
| S10 | Mixed coding/security task and adversarial retrieved content | Correct domain transition without swapping the established core; untrusted text does not override task/scope/tool policy. |

`test/http-policy.test.ts`, HTTP evidence tests, `test/web/fetch.unit.test.ts` and `test/web/property-03-fetch-input-validation.test.ts` provide starting contracts. Add model-level assertions; network helper unit tests alone do not establish security reasoning quality.

## 6. Provider/model breadth

Offline fixtures must cover every affected supported serializer: OpenAI-compatible chat, Responses, Anthropic messages, Gemini content and relevant gateway/local variants. Exercise native and text fallback; reasoned/non-reasoned, image and tool-result histories; compatible route changes and forbidden replay.

For live evidence choose the actual supported deployment routes and include at least a strong coding model, a smaller/tool-fragile model and a reasoning-capable route where available. Cover both coding and security scenarios on each declared-supported candidate route. Pin model identifiers/settings for the experiment; do not silently substitute a stronger model or make model migration part of token optimization.

Missing credentials, unavailable models, rate limits and provider outages are explicit coverage gaps. No global default rollout from one provider. Use existing authenticated provider integrations; never print, copy or commit API keys to evidence.

## 7. Staged evaluation and decision rule

1. **Deterministic stage:** all mandatory invariants and injected-negative controls pass before any paid A/B work.
2. **Pilot:** three paired repetitions of every mandatory applicable fixture per target route. Stop a candidate immediately on a confirmed material regression and diagnose it; do not burn a full run on known-bad behavior.
3. **Expanded run:** at least ten paired repetitions, counterbalanced; inspect failures and route-specific outliers, not just aggregate averages.
4. **Confirmation:** at least thirty paired repetitions for noisy or high-risk cells and an independent holdout set. These are starting sample sizes, not a statistical guarantee; increase them when uncertainty changes the decision.
5. **Decision:** report paired success/error/round differences and latency/token distributions with uncertainty (for example, reproducibly seeded paired bootstrap bounds). No tolerated regression margin is granted by this roadmap. An inconclusive critical metric blocks activation rather than becoming “close enough.”

Mandatory gates:

- All deterministic safety, cache, permission, evidence and task-state assertions pass.
- No candidate-only critical quality failure; no increase in first-attempt invalid/unknown/repair calls, execution failures or corrective rounds in comparable fixtures.
- No new unnecessary tool invocations/model rounds; dependency-safe batching must not reduce needed verification or evidence.
- Both initial request and full-task token accounting are honestly reported. The optimized target must improve; do not claim startup success for a purely warm-task improvement.
- No measured p50/p95 response/task latency or local CPU/memory regression attributable to the change. Resolve noisy inconclusive comparisons before approval; do not mask tail regressions with a mean.
- Established-profile byte continuity passes at the provider wire: no optimization-induced mutation of instructions, ordered tools or previously sent reusable history during agent execution.
- Warm-session cache-hit rate and eligible-prefix token reuse must be the same or better under matched provider/model/settings/workload conditions. Define a hit as a warm eligible request with provider-reported reused input tokens; report hit requests over all warm eligible requests with known cache usage. Also report reused tokens over the provider-eligible unchanged prefix tokens where that denominator can be established. Keep missing usage/unknown eligibility separate; never infer hits from hashes alone. Compare each route and relevant workload, not only a pooled average.
- Count cold-start/cache-write costs separately and compare cold with cold, warm with warm. A shorter optimized prefix may have fewer absolute cached tokens; that alone is not a regression. Account for external eviction/TTL/routing misses transparently and do not discard unfavorable samples. Unresolved material uncertainty blocks rollout, not evidence collection.
- A new release may change prompt/schema bytes without a separate prefix-change approval. Bind the selected profile once and preserve it across that session's turns/resume; no in-session “optimization” or rollback switches. New sessions can use the passing optimized default.

Finite testing cannot prove zero regressions for every future input/model. The operational rule is conservative: no known regression, required coverage complete, no material unresolved uncertainty, reversible new-session rollout and automatic stop on new evidence. Do not present that as a mathematical guarantee.

## 8. Commands and result handling

Use npm scripts already provided, without dependency upgrades:

```sh
npm run typecheck
npm run embed-prompts:check
npm run test:deterministic
npm run test:conformance
npm run build
```

Run applicable host/Bun/native suites when their surfaces are affected and record platform availability. The build regenerates embedded source and `dist`; inspect the tracked diff afterward. Do not reset user work. Focused cache/HTTP/filesystem suites are listed in the evidence record and roadmap; run them during development before the broader gate.

The existing live evaluator is a starting point, not a release-grade command until P1 is complete. Do not execute it on real engagements or blindly use stored credentials. Set an explicit paid-call budget, isolate trial configuration and place temporary artifacts under the active session scratch directory.

Every result must include command/configuration, exit/outcome, assertions/counts and an artifact reference or hash. Never mark a phase passed while a required test/job is still running or a report is unread. Clean up only owned fixture processes/workspaces.
