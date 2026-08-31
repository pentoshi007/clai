# Pre-refactor baseline

Captured: `2026-08-31T05:21:26Z`
Git anchor: `35e4b3529433a3419f11d2b5f35ce740f8d94826`
Branch: `refactor/codebase`
Environment: Linux `6.17.0-1020-oracle` aarch64, Node `v24.19.0`, npm `11.17.0`
Host locale: `LANG=en_IN.UTF-8`, no `LC_ALL` override

This document separates directly measured facts, audit proxies, and unmeasured goals. It does not claim that the repository currently meets the requested terminal gates.

## 1. Repository inventory

The code-intelligence inventory indexed:

- 1,262 repository files;
- approximately 262,410 total indexed lines;
- approximately 6,425 indexed functions;
- approximately 150 classes, structs, and enums.

The production AST audit found 632 TypeScript/TSX production files and 156,800 physical lines. Excluding the two generated TypeScript outputs, it found 630 files and 156,786 lines.

Principal layers are `src/agent`, `src/llm`, `src/tools`, `src/safety`, `src/store`, `src/app`, `src/ui-core`, `src/classic`, `src/tui-v2`, `src/noninteractive`, `src/session-runtime`, `src/interactive-session`, and `src/mcp`. The test repository includes architecture, admission, conformance, property, security, renderer, PTY, persistence, MCP, session-runtime, and platform suites.

## 2. Existing repository gates

`test/architecture/boundaries.ts` and `test/architecture/layer-boundaries.test.ts` enforce:

- no new TypeScript source file over 1,000 lines;
- a frozen, sorted, remove-only list of 20 legacy oversized files;
- renderer/runtime-policy import boundaries;
- a frozen, remove-only four-edge `uiCoreRuntimePolicyImports` list in `legacy-baseline.json` that is checked for exact equality;
- a separate code-level `RUNTIME_POLICY_EXCEPTIONS` classification set in `boundaries.ts`, governed by architecture tests but not stored as a remove-only JSON baseline.

When a listed oversized file reaches 1,000 lines or fewer, its entry must be removed in the same change. `CONTRIBUTING.md` additionally directs Classic source files to remain at or below 400 lines. The refactor program's terminal target is stricter for ordinary production files: fewer than 500 physical lines.

The 20 frozen oversized files at the anchor are:

| File | Audit LOC |
|---|---:|
| `src/agent/runner.ts` | 6,769 |
| `src/llm/http.ts` | 2,646 |
| `src/tools/jobs.ts` | 2,589 |
| `src/agent/tool-call-parser.ts` | 2,235 |
| `src/tools/registry.ts` | 2,125 |
| `src/store/history.ts` | 1,931 |
| `src/llm/router.ts` | 1,868 |
| `src/agent/plan-tool.ts` | 1,682 |
| `src/tools/definitions.ts` | 1,648 |
| `src/tools/web/fetch-core.ts` | 1,620 |
| `src/interactive-session/manager.ts` | 1,497 |
| `src/tools/fs.ts` | 1,471 |
| `src/ui-core/rendering/syntax-highlight.ts` | 1,368 |
| `src/ui-core/commands/picker-commands.ts` | 1,342 |
| `src/store/plan.ts` | 1,187 |
| `src/agent/task-evidence.ts` | 1,153 |
| `src/ui-core/rendering/markdown.ts` | 1,138 |
| `src/tools/http.ts` | 1,086 |
| `src/agent/loop-guard.ts` | 1,081 |
| `src/tools/shell.ts` | 1,042 |

The audit found 77 production files over 500 lines. Neither generated TypeScript output exceeds 500 lines, so the count is unchanged when those two outputs are excluded. Phase 0 must replace the temporary audit with a reproducible, checked-in command and machine-readable inventory before line count becomes a blocking program gate.

## 3. Validation baseline

Dependencies were installed with lifecycle scripts disabled:

```sh
npm ci --ignore-scripts --no-audit --no-fund
```

Result: 178 packages installed; only ignored `node_modules` was created.

These checks passed at the anchor:

| Command | Result |
|---|---|
| `npm run typecheck` | passed |
| `npm run embed-prompts:check` | passed |
| `npm run test:arch -- --reporter=dot` | 1 file, 5 tests passed |
| `LC_ALL=C LANG=C npx vitest run test/app/frontend-semantic-parity.test.ts test/noninteractive/stream-renderer.test.ts --reporter=dot` | 2 files, 10 tests passed |
| `LC_ALL=C LANG=C npm test -- --reporter=dot` | 557 files passed; 5,695 tests passed; 12 skipped; 5,707 total |
| `npm run build` | passed; prompt embedding regenerated identical tracked content |

After the test and build hooks, `git status --short --branch` showed a clean `refactor/codebase` worktree.

### Locale-sensitive default run

The unqualified host-locale command was also run:

```sh
npm test -- --reporter=dot
```

It produced 555 passing and 2 failing test files; 5,693 passing, 2 failing, and 12 skipped tests. Both failures expected `120,000` but the `en_IN` host rendered `1,20,000`:

- `test/app/frontend-semantic-parity.test.ts`;
- `test/noninteractive/stream-renderer.test.ts`.

The targeted tests and then the entire suite passed with `LC_ALL=C LANG=C`. This confirms an environment-sensitive baseline, not a change introduced by this program. No product formatting was changed during planning. Phase 0 must set a canonical locale/timezone before Node starts and separately characterize supported locale-sensitive formatting and ordering so canonicalization does not hide regressions.

### Observed non-failing warnings

- OS keychain fallback to a restricted-permission file in the test environment;
- expected warnings when unsupported model temperature settings are dropped;
- Vitest warnings about nested `vi.mock` calls in `test/context/request-accounting.test.ts` that will become errors in a future Vitest release.

Warnings are not ignored debt. Phase 0 should classify them as expected, actionable, or environment-only and add an owner/removal condition for actionable warnings.

## 4. AST maintainability audit

A TypeScript-compiler AST script inspected production TypeScript/TSX. Its complexity and Halstead calculations are ranking proxies, not validated Sonar, ESLint, or standard Halstead gate results. The temporary report existed as `/tmp/clai-refactor-metrics.json` (68,839 bytes) during planning; it is not a durable program artifact.

| Measure | Audit result |
|---|---:|
| Production files | 632 |
| Production files excluding generated outputs | 630 |
| Production LOC | 156,800 |
| Production LOC excluding generated outputs | 156,786 |
| Files over 500 LOC | 77 |
| Files over 1,000 LOC | 20 |
| Function-like nodes analyzed | 9,033 |
| Cyclomatic proxy `>=22` | 154 |
| Cognitive proxy `>=22` | 250 |
| Halstead-difficulty proxy `>=80` | 18 |
| Explicit `any` syntax nodes | 40 |
| `unknown` syntax nodes | 943 |
| Double assertions | 28 |
| Suppression markers | 5 |
| Comment runs at least 5 lines | 547 |
| Comment runs at least 10 lines | 96 |

### Highest-ranked functions

| File and function | Approximate size | Cyclomatic proxy | Cognitive proxy | Halstead proxy |
|---|---:|---:|---:|---:|
| `src/agent/runner.ts::runAgentTurn` | 6,129 lines | 456 | 1,255 | 166.19 |
| `src/agent/runner.ts::executeSingleTool` | 1,753 lines | 408 | 731 | 85.50 |
| `src/agent/plan-tool.ts::handlePlanTool` | 1,073 lines | 185 | 333 | 92.30 |
| `src/llm/http.ts::openAiCompatibleStream` | 889 lines | 139 | 335 | — |
| `src/llm/custom-provider-profile.ts::validateCustomProviderProfile` | — | 118 | 238 | — |
| `src/tui-v2/components/transcript/tool-card.tsx::ToolCard` | — | 106 | 116 | — |
| `src/tools/http.ts::httpFetch` | — | 94 | 180 | — |
| `src/agent/runner.ts::recordResult` | 257 lines | 93 | 107 | — |
| `src/safety/classifier.ts::classifyToolCall` | — | 85 | 117 | — |
| `src/tools/pdf.ts::pdfRead` | — | 82 | 131 | — |
| `src/llm/http.ts::buildReasoningPayload` | 226 lines | 74 | 106 | — |

Other high Halstead proxies include:

- `src/tools/file-diff.ts::computeLineOps` — 136.45;
- `src/agent/tool-history.ts::repairToolProtocol` — 123.51;
- `src/ui-core/state/transcript-store.ts::flushPendingEvents` — 112.47;
- `src/ui-core/rendering/markdown.ts::renderInlineMarkdown` — 103.77.

These values prioritize characterization and extraction. Phase 0 must remeasure with a pinned analyzer and stable definitions before enforcing the requested thresholds.

## 5. Type-safety audit

Highest explicit-`any` concentrations:

| File | Nodes |
|---|---:|
| `src/store/history.ts` | 7 |
| `src/store/plan.ts` | 5 |
| `src/store/scope.ts` | 4 |
| `src/index.ts` | 3 |
| `src/llm/http.ts` | 3 |
| `src/os/permissions.ts` | 3 |
| `src/store/config.ts` | 3 |
| `src/tools/fs.ts` | 3 |

Highest raw `unknown` concentrations:

| File | Nodes |
|---|---:|
| `src/llm/merge-gateway.ts` | 38 |
| `src/llm/responses-stream-events.ts` | 38 |
| `src/llm/http.ts` | 37 |
| `src/tools/registry.ts` | 31 |
| `src/agent/tool-call-parser.ts` | 28 |
| `src/llm/router.ts` | 26 |
| `src/llm/responses-parse.ts` | 24 |
| `src/agent/loop-guard.ts` | 23 |
| `src/mcp/results.ts` | 20 |
| `src/llm/catalog-facts.ts` | 19 |

Raw `unknown` is not automatically a defect. These modules decode untrusted provider, tool, MCP, JSON, and error data. The program must retain safe boundary `unknown`, prove narrowing, and eliminate internal imprecision and unsafe casts rather than gaming a raw count.

Suppression markers were observed at:

- `src/tui-v2/components/modal/keys-modal.tsx:114`;
- `src/tui-v2/components/modal/scope-modal.tsx:82`;
- `src/tui-v2/composer/composer-editor.tsx:209`;
- `src/tui-v2/composer/composer-editor.tsx:781`;
- `src/ui-core/commands/config-commands.ts:350`.

## 6. Comment audit

Leading long-comment locations include:

- `src/tools/web/readable.ts:376-406` — 31 lines;
- `src/tools/web/providers/exa.ts:1-29` — 29 lines;
- `src/tools/web/providers/tavily.ts:1-27` — 27 lines;
- `src/tools/web/redact.ts:79-104` — 26 lines;
- `src/ui-core/rendering/text-width.ts:1-25` — 25 lines;
- `src/tools/sudo-session.ts:5-28` — 24 lines;
- `src/tools/web/fetch.ts:1-23` — 23 lines.

Many are likely protocol, security, compatibility, or module rationale. The count is discovery data only. Removal requires parser/token-aware identification and manual review; regex-only deletion is prohibited.

## 7. Generated and behavior-bearing assets

Do not hand-edit:

- `src/prompts/embedded.ts`, generated from `src/prompts/system.agent.md` and `src/prompts/system.ask.md` by `scripts/embed-prompts.mjs`;
- `src/version.generated.ts` and synchronized manifest/lock version fields, generated from `package.json` by `scripts/sync-version.mjs`.

The two prompt Markdown sources and contractual snapshots/fixtures are behavior-bearing. Ordinary source line targets do not justify splitting or reflowing them.

## 8. Currently unmeasured gates

No configured, repository-wide evidence exists yet for:

- statement/branch/function/line coverage percentages;
- CRAP scores;
- mutation survivors or no-coverage mutants;
- dead exports/files/dependencies;
- duplicate/redundant code;
- standard-tool cyclomatic, cognitive, or Halstead values.

Their baseline state is **unmeasured**, not zero and not passing. Phase 0 introduces exact-pinned tooling in report-only mode, defines scope and exclusions, records machine-readable reports, and then creates monotonic ratchets. Phase 8 closes the terminal gates.

## 9. Risk-ranked starting seams

1. `src/agent/runner.ts`: first extract pure helpers, output/event emission, compaction emission, responder claims, continuation overlap, and finalization; make captured mutable dependencies explicit before moving stateful blocks.
2. `src/llm/http.ts` and `src/llm/router.ts`: separate payload construction, stream decoding, error mapping, retries, rotation, and routing behind unchanged public facades.
3. `src/tools/definitions.ts`, `registry.ts`, `jobs.ts`, `fs.ts`, and `shell.ts`: preserve aggregate order, schemas, singleton identity, and process lifecycle.
4. `src/store/history.ts` and `plan.ts`: separate codecs, backends, recovery, retention, transactions, and redaction.
5. Parser, safety, HTTP/web, interactive-session, UI-core, and renderer hotspots follow only after their contracts are characterized.

The numbered plans define the complete execution order and phase-specific evidence.
