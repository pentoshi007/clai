# Phase 1 runner ownership map

Anchor: `d4d35fe` on `refactor/codebase`

Primary facade: `src/agent/runner.ts`

Public entry points:

- `runAgentTurn(prompt, options)` owns one complete agent turn and returns `TurnOutcome`.
- `runAgentLoop(prompt, options)` delegates once to `runAgentTurn` and returns `outcome.answer`.
- `shouldYieldForDeclaredResponderDependency(...)` is an exported pure policy predicate.
- Existing runner re-exports remain compatibility contracts.

Known facade callers:

- `src/modes/agent.ts`
- `src/app/adapters/current-agent-adapter.ts`
- tests importing `src/agent/runner.js`

## Immutable turn input

| Value | Source | Consumers |
|---|---|---|
| `prompt` | `runAgentTurn` argument | task analysis, prompt composition, evidence gates, continuation policy |
| `options` | `runAgentTurn` argument | session, history, provider/model, event sink, callbacks, cancellation, limits |
| resolved mode flags | options/config | plan and agent policy branches |
| provider/model selection | options/config | request construction, usage and event payloads |
| initial history | options | `liveMessages`, compaction and final transcript |
| tool definitions and routed names | registry/MCP capabilities | request schema and dispatch admission |
| composed system sections | prompt/config/session inputs | request history |

## Mutable turn state with one owner

`runAgentTurn` is the sole owner at the anchor. Extraction may transfer ownership once, but must not copy these values into competing contexts.

| State | Current owner and mutation boundary |
|---|---|
| `visibleCommitted` | reset per iteration; set when a visible assistant message is committed |
| `interruptedVisible`, `interruptedReasoning`, `lowYieldResumptions` | continuation and interrupted-stream recovery |
| `liveMessages` | authoritative turn transcript passed to compaction, persistence and finalization |
| `suppressOutcomeDiagnostics` | terminal outcome rendering policy |
| `mcpLease` | acquired once and released during terminal cleanup |
| `unreadResponderNotificationIds` | responder claim lifecycle; released by turn finalization/error cleanup |
| fallback and retry flags | stream recovery and provider/model fallback paths |
| malformed/truncated/empty response counters | bounded retry and must-continue decisions |
| output-budget counters | continuation ceiling and emergency stop behavior |
| server/scaffold/probe/material-work flags | evidence and completion gates |
| `taskWorkLedger`, `sessionLooseWork` | task evidence ownership and persistence |
| `activePlan` and approval holders | plan transitions and responder parent linkage |
| pending tool calls and suppressed results | deterministic grouped tool execution order |

Stateful objects created once per turn and mutated in place:

- `LoopGuard`
- `EngagementPolicyEngine`
- stream recovery state
- recovery budgets
- `OutcomeEnvelope`
- `WorkLedger`
- governor state
- `TurnStateSnapshot`
- `CompactionAttemptLedger`
- per-compaction `OperationLedger`
- session policy holders

## Injected ports and services

| Concern | Current dependency boundary |
|---|---|
| output | `options.onEvent` through the local `emit` and `write*` adapters |
| transcript persistence | `options.onMessages` |
| outcome persistence | `options.onOutcome`, outcome store APIs |
| cancellation | `options.signal`, abort listeners and `isAbortError` |
| LLM transport | `streamWithProvider`, `completeWithProvider` |
| tool dispatch | registry `runToolCall` and special runner-owned tool paths |
| safety | classifier, confirmation port and engagement policy |
| compaction | context manager, compaction executor and operation accounting |
| responders | `jobManager`, responder claim/context/parent APIs |
| plans and tasks | plan store, plan tool and task evidence APIs |
| usage | operation usage recorder, token accounting and usage events |
| audit | audit log and durable outcome/evidence stores |
| workspace | session workspace and active project-root APIs |
| MCP | runtime readiness, lease, tool catalog and execution |

## Event and output boundary

The runner must not write directly to terminal streams. Observable output crosses `options.onEvent` in this order-sensitive family:

- status and notice events
- thinking start/delta/end events
- assistant delta and committed assistant message events
- tool call/start/output/result/blocked events
- plan update events
- compaction start/delta/completed/failed events
- usage events
- abort/error events
- exactly one terminal `turn-end` event

`finishTurn` currently owns terminal outcome construction, final transcript callback, outcome callback, responder-claim release and `turn-end` emission. No extracted service may invoke those terminal effects independently.

## Persistent stores and singleton references

Identity must remain unchanged for:

- `jobManager`
- active project-root state
- active session workspace state
- config and key/provider stores
- session plan and scope stores
- MCP runtime ownership

These are references passed through narrow ports, not state to recreate in a turn module.

## Derived values suitable for pure results

The first mechanical extraction group contains values that capture no turn state:

- exact continuation overlap trimming
- inserted-text prefix removal
- safe scope target derivation
- safe engagement action derivation
- MCP agent target derivation
- MCP agent output formatting
- responder-dependency yield policy

The continuation overlap function is first because it depends only on two strings and a minimum overlap length. At the anchor it has two call sites in interrupted visible-output recovery.

## Side-effect order constraints

1. Request admission and accounting happen before provider dispatch.
2. Stream deltas are emitted before committed assistant output.
3. Tool calls are recorded before corresponding tool results.
4. Safety and scope checks occur before unchanged registry/session dispatch.
5. Tool results enter history before the next model request.
6. Compaction admission occurs once at its current pre-request or post-tool boundary.
7. Responder claims retain notification and parent identity until delivery or terminal release.
8. Final transcript and outcome callbacks occur through one finalizer path.
9. `turn-end` occurs exactly once after terminal state is known.
10. Queue continuation remains outside the runner facade in the app/session controller boundary.

## Intended dependency direction

`runner.ts` composes narrow coordinators. Coordinators depend on explicit ports and pure/domain helpers. Extracted modules never import back from `runner.ts`. Compatibility exports remain at the facade until caller migration is validated.

## Extraction order

1. Freeze facade and continuation behavior with executable characterization.
2. Move pure continuation helpers mechanically.
3. Introduce narrow state and dependency interfaces without moving ownership.
4. Extract typed event emission and tool-result recording separately.
5. Extract compaction coordination one path at a time.
6. Extract responder claim, wake and polling ownership.
7. Decompose tool execution while retaining registry/safety/session implementations.
8. Extract exactly-once finalization after all terminal paths are characterized.
9. Reduce the facade and remove its oversized baseline entry in the qualifying structural change.

## Entry evidence

- Clean install succeeded with exact `jscpd@5.0.16`.
- Typecheck and embedded-prompt synchronization passed.
- Architecture tests passed: 1 file, 5 tests.
- Quality tests passed: 2 files, 39 tests.
- Public contracts were unchanged and the ratchet held 572 findings with zero regressions.
- Canonical deterministic suite passed: 561 files, 5,758 tests, 12 skipped.
- Phase 1 required characterization matrix passed: 50 files, 446 tests.
- Build and release verification passed.
- Platform contracts that cannot run on this host are not claimed by this map.
