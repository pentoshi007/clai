# Token overhead changes

Branch: `perf/reduce-token-overhead`. Baseline: `dbc5bcf8` (`v4.12.1`).

The final implementation removes repeated information from the default native request. Larger reductions were rejected when live comparisons increased tool calls or model rounds. The original detailed execution guidance, tool descriptions, compaction instructions and plan-mode instructions are retained.

## Where the context goes

For the configured NVIDIA `openai/gpt-oss-20b` route, the original stable native instructions contain 37,120 characters. Its 40 OpenAI-format tool schemas contain another 33,829 characters. Fresh agent requests also repeat 5,431 characters of execution guidance and include the user task three times: the user message, outcome contract and task-state section.

The native instructions now contain 36,654 characters. The repeated mode directive is 448 characters when the full execution contract already exists in the constitution. The tool schemas remain byte-identical. The user task is sent once, verbatim, in its original message.

## Final measurements

These are controlled request-assembly estimates using `ceil(characters / 3.3)`, excluding provider framing. They are not provider-reported usage, and should not be interpreted as the exact billed token counts or as a conversion of the reported 17k baseline. The long-task example adds approximately 5,000 characters of requirements.

| Request | Before estimate | After estimate | Difference |
| --- | ---: | ---: | ---: |
| Default native, short task | 23,507 | 21,780 | 1,727 fewer (7.35%) |
| Default native, long task | 28,099 | 23,310 | 4,789 fewer (17.04%) |
| Compact native, short task | 12,924 | 13,587 | 663 more |
| Full text tools, short task | 17,173 | 15,747 | 1,426 fewer (8.30%) |
| Compact text tools, short task | 3,864 | 3,809 | 55 fewer (1.44%) |

Compact native previously omitted three permitted tools on this route. Their complete schemas add 2,441 characters; retaining them costs 663 estimated tokens after the duplicated task text is removed. Text routes now explicitly list all 40 permitted tools rather than leaving six runner tools out of the available-name list. The original manual argument guidance is unchanged. A proposed full argument-catalog expansion for compact text was rejected during the offline audit because it substantially increased context.

## Implementation

- `src/agent/turn/prompt-sections.ts` anchors the outcome contract to the actual user task and steering, removing the two repeated task copies and the repeated mode field.
- `src/prompts/index.ts` reuses the detailed execution contract already in the full constitution. Compact constitutions retain the original full mode directive. The native name list is removed because those same tools are already attached as complete API schemas.
- `src/tools/definitions/selection.ts` and `src/agent/turn/tool-routing.ts` keep the complete permitted tool catalog independently of input-budget changes. Permission, vision and MCP availability rules remain in place.
- `src/agent/session-policy.ts` pins the initial compact/full prompt choice per provider/model during the session. A smaller initial context limit still selects the compact constitution; later budget changes cannot replace the established constitution.
- Text routes receive a complete available-tool-name list alongside their original tool guidance. No discovery call or additional schema lookup is added. Routes without visual-input support keep the remaining tool names visible.
- `src/llm/tool-protocol.ts` resolves observed formatting suffixes such as `fs.editjson` and `fs_readanalysisjson` only when the remaining name is registered. Real registered names take precedence. Edit arguments and malformed-argument handling are unchanged.

No additional production model requests, discovery calls, search pagination, file reads or edit retries are introduced by the request-assembly code. Tool handlers, batching, tool-result limits, search/read limits and history retention are unchanged.

## Compaction, plans and cache checks

Compaction summaries, their budgets, durable work envelopes, accepted-plan detail, task acceptance criteria and plan-mode roadmap requirements are unchanged. Regression checks compare the complete tool definitions and the plan/compaction/handoff instruction strings with baseline SHA-256 hashes. A large-plan test verifies that full detail and acceptance criteria reach the model even with a small request-context budget.

The existing append-only message history is preserved. Tests check unchanged prior wire-message prefixes across revisions, stable native schemas, budget changes, recovery/delivery messages, skills and MCP selection. Prompt choice is pinned during the active session; normal explicit provider/model or capability changes continue to use their own route and cache identity. Compaction still replaces history through its existing protocol.

The new native-loop integration check executes parallel search/read calls followed by an edit and final response in three model rounds. Every tool succeeds, the file preserves CRLF and unrelated content, and the system/tool schemas stay unchanged between rounds.

## Live comparisons and limits

Twelve matched task pairs covered search/edit, multiple edits, debugging, independent reads, background waiting and continuation with CRLF. The broader experimental prompt/schema-description rewrites reduced measured input substantially, but some comparisons added calls or rounds. Those rewrites were reverted.

The configured NVIDIA Responses endpoint rejected requests before task execution on both variants. Successful comparisons used a test-only switch to the existing chat-completions transport. Production transport and user configuration were not changed. NVIDIA reported no cached tokens in those runs; cache preservation is checked structurally rather than inferred from those reports.

The final conservative implementation was measured offline and tested through the repository checks after the live-comparison budget was consumed. It has not received a separate live parity comparison. These checks establish the covered invariants and fixtures; they do not prove identical stochastic model behavior on every possible task.

## Validation

- `node scripts/run-tests.mjs`: 8,252 passed, 14 skipped, zero failures across 783 files (782 passed, one skipped).
- `npm run build`: passed, including TypeScript compilation and prompt embedding.
- New measurement/evaluation scripts: checked under the repository's strict TypeScript options.
- `node scripts/embed-prompts.mjs --check`: passed.
- `node dist/index.js --version`: `4.12.1`.
- Added code comments: zero.

## Reproduce

Offline measurement needs no API calls:

```sh
node --import tsx scripts/measure-token-overhead.ts /path/to/baseline-checkout
```

The optional live harness uses configured NVIDIA credentials, isolated disposable fixtures and at most twelve pairs per run:

```sh
node --import tsx scripts/evaluate-token-overhead.ts /path/to/baseline-checkout
```

`CLAI_EVAL_CHAT=1` selects the test-only chat transport. `CLAI_EVAL_PAIRS` lowers the pair count; `CLAI_EVAL_FIXTURES` selects comma-separated fixture names. Reports include verified outcomes, tool errors, tool calls, model rounds, token usage, prefix/schema stability and elapsed time. `comparisons.json` rejects candidates with additional calls/rounds, additional errors, edit/read/search errors or changed prefixes.
