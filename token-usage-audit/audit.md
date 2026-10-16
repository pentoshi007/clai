# Token-usage audit

## Method and evidence labels

Baseline: `ada38924a499a568e69984b35f99b75c375ecb98`, package 4.15.2, Linux arm64, Node 24.20.0, installed npm dependencies. Initial worktree was clean. No dependencies were installed and no live model requests were made.

- **Measured:** local deterministic rendering, serialized lengths/hashes, validation results or observed test results.
- **Code-supported:** behavior traced through named source symbols; not necessarily exercised against a live provider.
- **Hypothesis:** proposed improvement requiring controlled evaluation.
- **Unknown:** no supporting measurement; cannot be used to approve rollout.

Numbers use `ceil(JS string length / 3.3)` unless stated otherwise. JSON punctuation counts, provider framing does not. Bytes, characters and tokenizer tokens are not interchangeable, especially for Unicode. The runtime accounting path also estimates canonical tool definitions, whereas the measurement script serializes OpenAI wire tools. These totals need not match exactly.

## 1. Reproduced startup overhead

The existing `scripts/measure-token-overhead.ts` was run with this checkout as both inputs. This is a baseline capture, **not a before/after optimization**. Savings are zero by construction.

| Synthetic scenario | Stable prompt chars | Mode chars | Wire tools chars | Tools | Fresh estimated tokens | Continuation estimate |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Native full, short request | 37,781 | 448 | 34,665 | 37 | 22,374 | 22,537 |
| Native full, long request | 37,781 | 448 | 34,665 | 37 | 23,905 | 24,068 |
| Native compact, short request | 4,926 | 5,431 | 34,665 | 37 | 13,928 | 14,091 |
| Text full, short request | 54,395 | 448 | 0 | 37 named | 16,904 | 17,067 |
| Text compact, short request | 6,761 | 5,431 | 0 | 37 named | 3,980 | 4,143 |

The short native full total is 73,834 characters: 37,781 stable prompt + 34,665 wire schemas + 1,388 remaining message content. Thus approximately 51.2% is the stable prompt, 46.9% schemas and 1.9% fixture request/context. A short user message does not eliminate the fixed overhead.

Additional inventory fixtures use the same short request:

| Route fixture | MCP runtime present | Vision tool | Tools | Full estimate | Compact estimate |
| --- | --- | --- | ---: | ---: | ---: |
| NVIDIA / openai/gpt-oss-20b | no | no | 37 | 22,374 | 13,928 |
| NVIDIA / openai/gpt-oss-20b | yes | no | 44 | 23,579 | 15,133 |
| OpenAI / gpt-4o | no | yes | 38 | 22,579 | 14,133 |
| OpenAI / gpt-4o | yes | yes | 45 | 23,784 | 15,337 |

These are offline route labels, not model recommendations or live calls. MCP presence means the seven fixed control/call schemas are available, not that a remote catalog is injected natively. Real workspace orientation, instructions, skills, orchestration, plans, scope and attachments are omitted from these fixtures. The measured range supports the reported symptom, but does not establish the user's exact 17k–23k reading or its billing cost.

### Feasibility of halving

- Half of 22,374 is 11,187. Its unchanged wire tool catalog alone estimates 10,505 tokens, leaving only about 682 for every instruction and other message.
- Half of the 45-tool full fixture is 11,892. Its unchanged 39,315-character tool catalog alone estimates 11,914 tokens.
- The existing native compact fixture is about 37.8% smaller than full, not 50%, and it restores a much longer mode directive. Its shorter prompt is not a free or quality-proven switch.
- All 47 definitions together have 40,131 summed per-tool wire characters. Description fields and their JSON keys account for 25,225 (62.9%). This is an inventory, **not permission to delete descriptions**; some encode critical runtime contracts.

Reaching half of the rich native fixture likely requires both a smaller instruction profile and leaner descriptions, not eliminating one small tool or changing an estimator. Neither belongs in an established prefix. A candidate allocation such as 4k instruction + 7k schema + 0.9k fixture/context is only an experiment budget; real user/project/skill content remains uncapped by that target.

## 2. Request and accounting flow

| Stage | Source / symbols | Audit conclusion |
| --- | --- | --- |
| Prompt source and embedding | `src/prompts/system.agent.md`, `src/prompts/system.ask.md`, `src/prompts/index.ts`, `src/prompts/embedded.ts`; `scripts/embed-prompts.mjs` | Rendering loads embedded content first; editing Markdown alone can leave runtime stale. Generated source must stay synchronized. |
| Route/profile choice | `src/agent/runner.ts` at `createToolRouting`; `src/agent/turn/tool-routing.ts` | Compact mode is selected from input budget/context limit and remembered per provider/model in `SessionPolicy.compactPromptModes`. |
| Full native rendering | `renderAgentSystemPrompt`, `agentPromptNativeSlim` | Native slim already avoids the large text-protocol tool catalog. Do not propose that existing optimization again. |
| Dynamic sections | `src/agent/turn/system-sections.ts`, `src/agent/turn/prompt-sections.ts`, `src/agent/prompt-composer.ts` | Environment, work classification, skill catalog, scope and mode are composed separately. Some sections are mandatory; a budget is not license to discard them. |
| Message assembly | `src/agent/turn/setup/turn-messages.ts`, `src/agent/turn/message-assembly.ts` | Stable leading message precedes history/current user message; current context is appended. Exact section reuse is already suppressed where allowed. |
| Project/skill/state updates | `src/agent/injected-blocks.ts`, `src/agent/session-state.ts`, `src/llm/system-messages.ts` | Identical latest blocks are no-ops; changed/cleared states append rather than rewriting earlier messages. |
| Tool selection | `src/tools/definitions/selection.ts`, `src/tools/definitions/aggregate.ts`, `src/agent/turn/tool-routing.ts` | 47 definitions exist; compact tool selection intentionally retains full contracts. Route filtering excludes internal-only tools and unsupported vision. |
| Compiled request | `src/llm/request-plan.ts`, provider adapters | Logical fingerprints hash instructions, tools, history, artifacts and relevant settings. Request-context exclusions in the logical hash do not exclude those bytes from provider input. |
| Accounting | `src/agent/request-accounting.ts`, `src/llm/token-estimate-calibration.ts`, `src/llm/context-snapshot.ts` | Estimates/calibration are distinct from provider-exact usage. Tool schemas, images and replay artifacts contribute. |
| UI usage | `src/app/controllers/session-context-usage.ts`, `src/app/controllers/session-usage-ledger.ts` | Context, accumulated session tokens and cache reads/writes are separate concepts. Do not subtract cached tokens from context occupancy. |

A set of tool calls emitted in one assistant response can be executed within one model round. Multiple tool invocations do **not** necessarily mean multiple requests containing the whole history. Optimize dependency-safe batches and model rounds, not just the raw invocation count.

## 3. Findings and decisions

### A1 — Fixed prompt plus schemas dominate (measured)

The largest full native sections are execution/planning guidance (10,569 characters), background work (5,953), operating guidance (3,593), software work (3,043), style (2,262) and planning mode (2,070). There is room to investigate duplicated semantic responsibilities. Deleting an entire section without a rule-to-test map risks losing recovery, scope or security behavior.

**Decision:** consolidate responsibilities only in an isolated candidate profile, after a coverage map and equivalence gates. Do not copy hidden runtime instructions into reports; use source references and tests.

### A2 — Existing compact behavior is not an acceptance result (measured/code-supported)

`runner.ts` and the measurement script infer whether detailed mode guidance is needed using a substring in the rendered prompt. Compact rendering lacks that marker, so the mode directive grows from 448 to 5,431 characters. A textual rewrite could accidentally trigger this fallback and erase expected savings.

**Decision:** introduce explicit internal profile capabilities only with legacy byte-equivalence tests; do not rely on a heading as executable configuration. Count the entire assembled request, not the prompt file alone.

### A3 — Stable catalog and append-only state are existing assets (verified locally)

Focused cache suites cover native/text turns, MCP discovery/reconnect/catalog updates, provider wire prefixes, Anthropic breakpoints and repeated compaction. All selected tests passed.

**Decision:** preserve those guarantees. No turn-by-turn tool pruning, resorting, permission-based schema removal, or rewriting old context to save tokens. MCP discovery already uses fixed control tools; do not recreate that architecture.

### A4 — Cross-version/restart profile retention needs a gate (code-supported gap)

`SessionPolicy` retains compact choices in an in-memory map. `SessionController.restoreHistory` recreates that policy. `HistoryRecord` has no explicit immutable prompt/tool profile descriptor. `buildTurnHistory` removes the leading system message; future turns rebuild it from current source. Existing session-continuity tests are valuable but do not prove arbitrary application-version migration preserves old prompt/schema bytes.

**Decision:** before shipping a changed profile, add persisted route-profile identity plus recoverable immutable content and restart/upgrade tests. Treat this as a release-safety gap, not a claim that the current deployment has a reproduced cache outage.

### A5 — Existing live evaluation is too narrow for this quality bar (code-supported)

`scripts/evaluate-token-overhead.ts` has useful paired coding fixtures, immutable test-file checks, tool/round counts and prefix hashes. However it:

- uses the NVIDIA provider path, six fixtures and up to two repetitions, not a multi-provider/security matrix;
- directs several prompts to particular tools, which can conceal selection regressions;
- records elapsed time but does not reject on latency regression;
- reports token deltas but does not require a positive reduction;
- compares only successful-request prefix hashes and can miss failed attempt wire changes;
- does not prove first-attempt argument validity or warm-cache effectiveness;
- has a background fixture whose verifier accepts `/42/` in the answer, without proving the correct job execution/wait sequence;
- writes raw request evidence; it is not safe for arbitrary credential-bearing real engagements.

**Decision:** strengthen and isolate this harness before judging any candidate. Keep the existing fixtures as regression coverage, not as the entire release standard.

### A6 — A real schema/validator gap can cause avoidable retries (measured)

`src/tools/definitions/web-2.ts` advertises `web.fetch.maxBytes` as an integer without bounds. `src/tools/web/validate-args.ts` rejects values outside 1,024–1,048,576, using constants from `src/tools/web/types.ts`. An audit fetch of 1,800,000 failed with that validation error; 1,048,576 succeeded. A direct local validator probe reproduced the mismatch without network access.

**Decision:** prioritize machine-readable bounds in any approved new schema profile, even if it costs a few tokens. Keep legacy bytes intact under the strict lane; do not quietly alter them while fixing a token budget. Add structural schema/runtime boundary tests. No implementation fix is included in this audit.

### A7 — HTTP evidence tooling should remain (code-supported)

`src/tools/http/fetch.ts` snapshots each redirect, checks each destination, strips authorization/proxy-authorization/cookies on cross-origin redirects by default, handles method changes and records captured-body SHA-256. Evidence formatting distinguishes raw/readable output and TLS verification choices. `test/http-policy.test.ts` covers network policy and aliases.

**Decision:** retain `http.fetch` separately from readable web research. Recreating equivalent evidence with curl requires reliable quoting, redirect handling, capture, hashing and artifact delivery across shells. No multi-model evidence establishes that removal is first-attempt equivalent. Its entire schema is only about 815 estimated tokens in this inventory.

### A8 — Result handling already has savings mechanisms (code-supported)

`src/agent/reliability-policy.ts` includes result deduplication; `src/agent/turn/tool-result-recorder.ts` uses it before appending new tool messages. `fs.read` supports one or several files with per-entry filters and budgets. State upserts already avoid exact repetition.

**Decision:** measure remaining repetition first. Do not invent another generic batch tool, add universal summarization, lower evidence caps blindly, or remove earlier messages. A failed second read can consume more tokens than an overly terse first result saved.

## 4. Residual uncertainty

Not measured here: the user's exact initial provider request, all supported model tokenizers, live cache hit rates, first-token latency, real-task quality under a shortened prompt, security task coverage under compact rendering, cross-version migration, full deterministic/host suites, cost savings, or throughput improvements.

The audit establishes a root-cause model and an executable proof plan, not a completed optimization. A new profile must remain disabled if quality, performance or cache evidence is inconclusive.

## External cache reference

Official OpenAI documentation, fetched 2026-10-16: [Prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching). It confirms that rendered prefix content includes tools, that relevant setting/content changes affect reuse, and that a session alone does not guarantee a cache hit. This audit does not generalize provider-specific minimums or new API options to all clai routes; use existing route capabilities and provider-specific tests.
