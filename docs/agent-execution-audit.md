# Agent execution audit

## Scope and findings

The full agent constitution already uses acceptance criteria, evidence-driven diagnosis, attack-surface coverage, negative controls, verification, and explicit residual risk. The runtime also has bounded tool output, loop guards, context admission, compaction, and durable background-job receipts. Adding more repeated instructions to those paths would increase input cost without establishing better task success.

The compact native and text prompts did not retain several important parts of that contract. They now share a concise execution contract covering current-request intent, bounded evidence reuse, independent batching, installed-version preservation, reproduction and regression verification, security finding confidence, and honest completion limits. The full prompt also explicitly preserves existing dependency versions and distinguishes assessment limits from security assurance.

Regression tests cover both tool protocols and plain-answer, one-tool, two-tool, and longer native-provider follow-ups. Permission and environment fixtures must model the intended conditions rather than depend on the test runner being unprivileged or having a login shell.

## Cache contract

Stable instructions and tool definitions belong in the reusable prefix. Request environment, plan state, and other mutable context belong in appended conversation content. Existing history must not be rewritten merely to refresh those values. The existing prompt assembly and cross-turn tests exercise this separation.

Anthropic's cache-control annotations are not conversation content: moving a breakpoint is supported. Tests compare reusable content separately from breakpoint placement, while lookback tests cover breakpoint reachability. Replacing working breakpoint logic merely to make serialized metadata identical would not prove better cache reuse.

Cache hits cannot be guaranteed. Provider TTLs, eviction, minimum prefix sizes, routing/model changes, tool-schema changes, and deliberate compaction can create cache boundaries. Tests establish application-side invariants, not provider cache-hit rates.

## Verification limits

Prompt contract tests prevent accidental removal of instructions; they do not measure model obedience or prove comparative performance against other agents. A meaningful performance comparison needs fixed tasks, model/provider configurations, repeated trials, outcome checks, latency, tool counts, token usage, and cache-read/write telemetry. Security evaluation additionally needs known-ground-truth targets and finding precision/recall, not a claim that an assessment found every vulnerability.

Reference: [Anthropic prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching).

## Local CI parity

Use Node 22 or 24 and Bun 1.3.14, matching the workflow. An older Bun can be discovered by the session-runtime integration tests even when Vitest itself runs under Node. Bun 1.3.1 does not provide `Bun.Terminal`; in the sandbox its node-pty fallback exited with SIGHUP before the fixture handshake. The same tests passed with Bun 1.3.14 without assertion or timeout changes.

To provision the pinned Bun without replacing a host installation:

```sh
npm ci
npm install --prefix .hoplite/runtime/ci-bun --no-save --package-lock=false bun@1.3.14
export BUN_INSTALL="$PWD/.hoplite/runtime/ci-bun/node_modules/bun"
export PATH="$BUN_INSTALL/bin:$PATH"
npm run test:deterministic -- --reporter=dot
npm run test:bun
```
