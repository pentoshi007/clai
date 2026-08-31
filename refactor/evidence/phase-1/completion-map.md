# Phase 1 completion map — `src/agent/runner.ts`

Current state: **5,223 physical lines**. Target: **< 500**. Public exports and
`runAgentLoop` / `runAgentTurn` / `shouldYieldForDeclaredResponderDependency`
signatures must stay byte-identical; `quality:contracts` enforces this.

## Structure at this point

| Lines | Region | Disposition |
|---:|---|---|
| 1–458 | imports | shrinks automatically as bodies move |
| 459–479 | compatibility re-exports | stays in the facade |
| 480–525 | `shouldYieldForDeclaredResponderDependency` | move to `turn/responder-dependency.ts`, re-export |
| 526–604 | `AgentRunOptions` and turn types | move to `turn/run-options.ts`, re-export |
| 605–656 | `runAgentTurn` entry, mode/plan flags, event port | stays (facade composition) |
| 657–1447 | turn setup: outcome state, `finishTurn`, orientation, instructions, skills, prompts, counters, persistence helpers, salvage | 8 modules below |
| 1448–2834 | `executeSingleTool` | 6 modules below |
| 2835–2875 | compaction coordinator wiring | stays (composition) |
| 2876–5211 | iteration loop | 9 modules below |
| 5212–5217 | turn cleanup | stays |
| 5218+ | `runAgentLoop` | move to `turn/run-loop.ts`, re-export |

## Remaining modules, in dependency-safe order

Each row is one commit: characterize what is not already covered, move
mechanically, wire, then run the per-seam gate set. Estimates are the lines
removed from the facade.

### Turn setup

| # | Module | Content | ~Lines |
|---:|---|---|---:|
| 1 | `turn/finalizer.ts` | `finishTurn`: terminal outcome, render, `responderClaims.release()`, `turn-end` exactly once | 90 |
| 2 | `turn/workspace-orientation.ts` | destination hint, project discovery, sticky root pinning | 120 |
| 3 | `turn/instructions-and-skills.ts` | instruction scan, skill selection, active-skill block, refresh | 90 |
| 4 | `turn/request-context.ts` | system prompt composition, request-context message, injected-block refresh | 110 |
| 5 | `turn/turn-counters.ts` | recovery budgets, `saw*` evidence flags as one owned record, retry counters | 150 |
| 6 | `turn/plan-persistence.ts` | `persistProjectRootOnPlan`, `persistTaskEvidence`, `rehydrateSessionFlagsFromPlan`, `refreshSessionState` | 140 |
| 7 | `turn/salvaged-write.ts` | `applySalvagedWrite` through the normal tool path | 60 |
| 8 | `turn/tool-call-inspection.ts` | `invalidToolCall`, `probeStateKey`, `promptMutex` | 70 |

### `executeSingleTool`

| # | Module | Content | ~Lines |
|---:|---|---|---:|
| 9 | `turn/tool-execution/prelude.ts` | normalization, synthetic receipts, OCR/nmap/batch guards, loop-guard check, `loop.reset` | 220 |
| 10 | `turn/tool-execution/meta-tools.ts` | remaining `RUNNER_META_TOOL_NAMES` path and plan-tool result application | 180 |
| 11 | `turn/tool-execution/authorization.ts` | classification audit, scope/engagement decision, confirmation, authorization receipts | 260 |
| 12 | `turn/tool-execution/dispatch.ts` | dispatch task, declared parent, responder delegation, turn-state move | 150 |
| 13 | `turn/tool-execution/supervision.ts` | abort wiring, live output, ephemeral job registration, watchdog run, abort/error mapping | 190 |
| 14 | `turn/tool-execution/result-framing.ts` | suppressed repeat, delegation settlement, artifact save, context format, audit, engagement checkpoints, governor/turn-state accounting | 380 |

### Iteration loop

| # | Module | Content | ~Lines |
|---:|---|---|---:|
| 15 | `turn/loop/request-assembly.ts` | context breakdown, budgets, protocol repair, final-fit accounting, audit | 260 |
| 16 | `turn/loop/stream-dispatch.ts` | `streamWithProvider` invocation, heartbeat, delta parser wiring | 200 |
| 17 | `turn/loop/stream-tokens.ts` | token consumption, streamed text tool cards, thinking transitions | 150 |
| 18 | `turn/loop/stream-failure.ts` | recovery ladder: backoff, compaction, thinking-off, provider fallback | 240 |
| 19 | `turn/loop/native-calls.ts` | native tool-call binding, argument repair, duplicate occurrence replay | 300 |
| 20 | `turn/loop/text-calls.ts` | fence/bare-JSON recovery, truncation retries, salvage | 280 |
| 21 | `turn/loop/round-execution.ts` | per-round tool execution, batch guard application, recorder invocation | 320 |
| 22 | `turn/loop/continuation.ts` | must-continue, evidence gates, plan-approval pause, low-yield resumption | 300 |
| 23 | `turn/loop/final-answer.ts` | final answer gating, rich stop summary, empty-response retries | 200 |

Total accounted: ≈ 4,780 lines, leaving the facade near 440 lines once the
imports that belong to moved code follow their bodies.

## Rules that must hold for each of these commits

1. `quality:contracts` unchanged; no new export from `runner.ts`.
2. New file `< 500` lines and every new function `< 22` cognitive, `< 22`
   cyclomatic, `< 80` Halstead difficulty.
3. **Never nest more than one non-trivial closure inside a factory.** The
   analyzer attributes nested function bodies to the enclosing function, which
   is what produced the 57/28/25/24 cognitive failures already fixed this
   session. Hoist helpers to module scope and pass `(ports, …)`.
4. **No `unknown` in a parameter or `Record<string, unknown>` port type.** The
   type-syntax gate classifies both as narrowing-required. Narrow at the runner
   boundary, or import the predicate directly instead of injecting it.
5. Never run a formatter over `runner.ts` in a move commit.
6. Verify with `set -e -o pipefail`; a piped `npm run …` alone hides failures.
7. Remove `src/agent/runner.ts` from `test/architecture/legacy-baseline.json`
   in the same commit where it first reaches ≤ 1,000 lines.

## Per-seam gate set

```sh
npm run typecheck
npx vitest run <focused> --reporter=dot
npx vitest run test/agent test/admission --reporter=dot
npm run test:arch -- --reporter=dot
npm run quality:contracts
npm run quality:changed
npm run quality:ratchet
npm run build
git diff --check
```

## Phase close

```sh
npm run typecheck
npm run embed-prompts:check
npm run test:arch -- --reporter=dot
npx vitest run test/agent test/admission test/context --reporter=dot
npm run test:deterministic -- --reporter=dot
npm run build
npm run quality:ratchet
npm run quality:mutation -- --scope agent-turn
git diff --check
```
