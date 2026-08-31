# Phase 1 completion map — `src/agent/runner.ts`

State: **3,519 physical lines** (Phase 1 entry: 6,769). Public exports and the
`runAgentLoop` / `runAgentTurn` / `shouldYieldForDeclaredResponderDependency`
signatures are unchanged and enforced by `quality:contracts`.

## What the file is now

| Region | Size |
|---|---:|
| imports | ~500 |
| compatibility re-exports and the delegating dependency predicate | 40 |
| `AgentRunOptions`, turn types, entry, event ports, finalizer wiring | 100 |
| turn setup: session, plan, orientation, prompts, counters, ports, services | ~600 |
| `executeSingleTool` (now mostly port wiring for eight extracted stages) | ~830 |
| compaction coordinator wiring | 40 |
| iteration loop (port wiring for twelve extracted stages) | ~1,350 |
| ceiling stop, error handling, `runAgentLoop` | 50 |

Everything that could be extracted with a narrow per-service port interface has
been extracted — 32 modules under `src/agent/turn/`. The three remaining regions
are single functions whose bodies close over the turn's mutable state, so they
cannot move without first making that state explicit.

## Remaining work: make turn state explicit, then move the three regions

### Step 1 — `turn/tool-execution/context.ts`

Define a `ToolExecutionContext` with **named, typed, readonly** members: the
services (`jobManager`, `mcpRuntime`, `session`, `confirmPort`, `loopGuard`,
`workLedger`, `engagementPolicy`, `promptMutex`), the emitters, the accessors
(`provider()`, `model()`, `scratchDir()`), and a small `ToolExecutionMutations`
object for the four values the stage writes back (`taskWorkLedger`,
`pendingSessionStatePlan`, `narrowNmapDispatchCount`, retry-change flags).
This is not a closure blob: every member is declared and typed, matching the
`refactor/plan/phase-1.md` rule "narrow interfaces per extracted service".

### Step 2 — split `executeSingleTool` (960 → facade call)

| Module | Content | ~Lines |
|---|---|---:|
| `turn/tool-execution/prelude.ts` | normalization, synthetic receipt, OCR/meta guards, loop-guard verdict, `loop.reset`, MCP agent dispatch | 300 |
| `turn/tool-execution/meta-tools.ts` | responder read, `task.update` gate, plan-tool handling and emission | 250 |
| `turn/tool-execution/execute.ts` | gates → authorization → dispatch → watchdog run → supervision | 300 |
| `turn/tool-execution/record.ts` | suppressed repeat, artifact save, context format, audit, engagement, accounting, crediting, final return | 300 |

### Step 3 — `turn/loop/runtime.ts`

Define `TurnRuntime`: the round-local mutable state that the loop owns
(`step`, `productiveSteps`, `pendingCalls`, `lastAnswer`, `interruptedVisible`,
`interruptedReasoning`, `lowYieldResumptions`, retry counters, `recovery`,
`evidenceFlags`, `governorState`, `turnState`, `codingSession`,
`consecutiveModelOnlyRounds`, `consecutiveSynthesizedRounds`). Each field is
declared; the stage modules receive `(runtime, ports, input)`.

### Step 4 — split the iteration loop (1,360 → facade call)

| Module | Content | ~Lines |
|---|---|---:|
| `turn/loop/round-request.ts` | compaction hook, responder inbox refresh, system-prompt refresh, assembly, stream dispatch, failure recovery | 350 |
| `turn/loop/round-parse.ts` | completion interpretation, native/text call binding, salvage, guards, recovery ladder | 350 |
| `turn/loop/round-answer.ts` | completion assessment, model-only rounds, finalize recovery, final outcome | 300 |
| `turn/loop/round-execute.ts` | binding, deferral, suppression, group execution, recording, closeout | 350 |

### Step 5 — split turn setup (610 → facade call)

| Module | Content | ~Lines |
|---|---|---:|
| `turn/setup/services.ts` | session policy, workspace, MCP, plan load, tool routing, prompt composition | 320 |
| `turn/setup/state.ts` | counters, ledgers, ports, turn-state, outcome envelope, recorder wiring | 290 |

### Step 6 — facade

`runner.ts` keeps: imports for the composed modules, the compatibility
re-exports, `AgentRunOptions`, the delegating dependency predicate, and a
`runAgentTurn` that builds the context/runtime and calls the loop. Expected
final size ≈ 300–400 lines, at which point the
`test/architecture/legacy-baseline.json` entry is removed in the same commit.

## Invariants that must hold for every one of those commits

1. `quality:contracts` unchanged; no new export from `runner.ts`.
2. New file `< 500` lines; every new function `< 22` cognitive, `< 22`
   cyclomatic, `< 80` Halstead difficulty.
3. **Never nest more than one non-trivial closure inside a factory.** The
   analyzer attributes nested function bodies to the enclosing function; this
   produced the 57/29/28/25/24 cognitive failures already fixed this session.
   Hoist helpers to module scope and pass `(ports, …)`.
4. **No `unknown` in a parameter, in `Record<string, unknown>` port types, or in
   an `as { … unknown }` assertion.** Narrow at the runner boundary — pass
   `kind`/`alreadyEmitted`/`attemptUsage` instead of the raw error, as
   `turn/loop/stream-failure.ts` does.
5. Never run a formatter over `runner.ts` in a move commit.
6. Verify with `set -e -o pipefail`; a bare piped `npm run …` hides failures.
7. Emission order is a contract: keep `writeToolCall` → `markPrinted` →
   `tool-start` → `writeToolOutput` → `emitToolResult` exactly as the runner
   had it, and keep notices before/after their sibling writes unchanged.

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
