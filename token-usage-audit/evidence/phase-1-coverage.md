# P1 coverage ownership

This maps gates to executable assertions, not to claims of universal model obedience. All model cells still require their own trial receipts. Legacy startup bytes remain owned by the P0 locks.

| Matrix | Executable ownership |
| --- | --- |
| D01–D02 | `test/context/token-assembly-baseline.test.ts`: 64 actual assembly combinations, accounting, exact ordered tools and legacy digests. |
| D03–D04 | `test/context/token-prefix-state-gates.test.ts`: environment, scope, plan, skill, project, MCP and orchestration keyed revisions/no-change/clear/re-add with old history retained and injected historical rewrite rejected. Actual runner catalog/context transitions additionally use `test/agent/stable-catalog-cache-continuity.test.ts` and `test/agent/compatible-cache-revisions.test.ts`. |
| D05 | `test/agent/tool-history.test.ts`, `test/agent/native-tool-calls.test.ts`, `test/agent/native-tool-loop.test.ts`, `test/conformance`: IDs/order/tool-result/native/text serialization. |
| D06 | `test/agent/stable-catalog-cache-continuity.test.ts`: actual MCP discovery/paging/calls/reconnect/sign-in/catalog refresh and fixed native/text catalog across changes. |
| D07 | `test/agent/compaction-cache-fidelity.test.ts`, `test/agent/compaction-durable-envelope.test.ts`, `test/agent/responder-inbox.test.ts`, `test/app/cancel-coordinator.test.ts`, `test/agent/continue-orient.test.ts`: supported reuse segments, instructions/criteria, unread receipts, cancellation and continuation. |
| D08 | Existing baseline storage/replay in `test/conformance/persistence-replay.test.ts`, `test/app/session-cache-continuity.test.ts`, `test/agent/plan-persistence.test.ts`. New immutable-profile/version/corrupt-manifest transitions belong to P3 and are not claimed implemented by these baseline tests. |
| D09 | `test/llm/adapters/anthropic-cache-breakpoints.test.ts`, `test/llm/adapters/gemini-schema-sanitize.test.ts`, `test/llm/reasoning-history-compatibility.test.ts`, `test/llm/responses-replay.test.ts`, conformance reasoning/image/tool-result histories. |
| D10 | Existing definition and HTTP/web validator tests plus `test/context/token-contract-ledger.test.ts`. The known web maxBytes schema mismatch is deliberately locked in legacy and remains TE-029 candidate work. |
| D11 | `test/fs-read-multiple.test.ts`, `test/ui-core/rendering/fs-read-multiple.test.ts`, `test/context/token-coding-fixtures.test.ts`: partial success/missing file, Unicode/CRLF, per-entry windows and continuation. |
| D12 | Embedded-source check/P0 source locks; complete build/package/Node/Bun validation is repeated at P3/P6 when profiles change. |
| D13 | `test/context/token-evaluation-metrics.test.ts`, `token-evaluation-config.test.ts`, `token-prefix-state-gates.test.ts`, `token-fixture-verification.test.ts`, `token-security-fixtures.test.ts`, `token-evaluation-cache.test.ts`: early prompt/schema/description/history mutation, wrong fix, missing evidence, extra rounds/calls, budget exhaustion, false background success, unknown usage/cache and adversarial scope failures. |

## Coding corpus

Six original tool-directed fixtures remain unchanged in intent. Their natural equivalents add no prescribed editing/search tool names. `.clai/INSTRUCTIONS.md` discloses the immutable supplied-tests/package policy, with separate added tests/inline checks allowed. All original test bytes and independent hidden assertions remain protected.

| IDs | Natural fixtures |
| --- | --- |
| C01 | `search-edit-natural`, `debug-regression-natural` |
| C02 | `multiple-edits-natural` |
| C03 | `continuation-crlf-natural`, `unicode-stale-edit-natural` |
| C04 | `question-after-build` |
| C05 | `persistent-feature-natural` |
| C06 | `independent-reads-natural`, `partial-read-natural` |
| C07 | `finite-foreground-natural`, `background-wait-natural`, `persistent-server-natural`, `responder-lifecycle-natural` |
| C08 | `pty-secret-cancel-natural` |
| C09 | `roadmap-continuation-natural` plus baseline compaction/continuation controls |
| C10 | `partial-read-natural`, `debug-regression-natural`; actual failed provider admissions and attempt-budget/retry controls |

`test/context/token-coding-fixtures.test.ts` independently tests wrong fixes, invalid persistence/error behavior, partial reads, phase boundaries, Unicode/CRLF and immutable inputs. `token-lifecycle-fixtures.test.ts` uses actual foreground/background jobs and a real owned PTY; it verifies masked delivery, prompt/cursor handling and process cleanup instead of treating tool exit zero as sufficient evidence. Model fixture definitions are not all-model pass certificates.

## Security corpus

`security-s01-natural` through `security-s10-natural` are model-invocable tasks with hidden evidence assertions. `token-security-evidence.test.ts` tests HTTP evidence primitives; `token-security-fixtures.test.ts` tests the corresponding model verifier's accept/reject behavior against real loopback HTTP/TLS/source/scanner data. S09 actual scan continuation and C08 cancellation run through `token-lifecycle-fixtures.test.ts`.

Synthetic secrets and lab certificates have no real authorization value. Servers close on normal/error paths; trial cleanup stops owned background jobs and PTYs. Retrieved text is not a new source of task/scope authority. No external security target or real sensitive document is used.

## Evidence interpretation

- Deterministic control pass: the specified defect is detected and the known-good synthetic path is accepted.
- Baseline model pass: a particular route/settings/fixture revision satisfied its independent assertions on that trial.
- Candidate comparison: requires paired matched provenance, complete accounting, no reliability/performance regressions, supported byte continuity and comparable warm cache denominators. None follows merely from the first two categories.
- D08 new profile persistence, D10 candidate schema parity, D12 package changes and P6 staged uncertainty are explicit downstream obligations, not excuses to label them already complete.
