# Phase 1 completion map — `src/agent/runner.ts`

State: **3,271 physical lines** (Phase 1 entry: 6,769). 47 modules under
`src/agent/turn/`. Public exports and the `runAgentLoop` / `runAgentTurn` /
`shouldYieldForDeclaredResponderDependency` signatures are unchanged, enforced
by `quality:contracts` and `test/contracts/public-contracts.test.ts`.

## Measured composition

| Region | Lines |
|---|---:|
| imports | 512 |
| compatibility re-exports, `AgentRunOptions`, dependency predicate, entry | 105 |
| turn setup (services, ports, state, prompts) | 655 |
| `executeSingleTool` | 834 |
| iteration loop | 1,189 |
| `runAgentLoop` | 7 |

## Hard constraint discovered while attempting a wholesale move

`scripts/quality/config.mjs` sets `fileLines: 500`, `cyclomatic: 22`,
`cognitive: 22`, `halsteadDifficulty: 80`, and `crap: 25`. `quality:changed`
applies those limits to every **new** file, while
`test/architecture/legacy-baseline.json` holds only the pre-existing violations
of the files already listed there.

Consequence: `executeSingleTool` and the iteration loop **cannot be moved into a
module verbatim**, even behind a single dependency object. A 834-line file with
one 834-line function fails `fileLines`, `cognitive`, and `cyclomatic` at once,
and the ratchet counts those as new regressions. The only compliant path is the
one used for the 47 modules so far: decompose a coherent stage into small
functions first, then delete the inline block.

A free-variable analysis of the current `executeSingleTool` (script in the
session log) found ~45 closure dependencies, of which all pure helpers
(`saveToolOutput`, `formatToolContext`, `auditLog`, `loadScopeForSession`,
`toolStallBudgetMs`, `toolHardBudgetMs`, `recordEngagementOutcome`, `safeCwd`,
`runToolCall`, `isCanonicalToolName`, project-root helpers,
`stdioSecretRequester`) are module-level imports a new module can import
directly. The genuinely turn-local set is ~30 members: `session`, `options`
subset, `emit`, `provider`/`model`/`step` (getters), `prompt`, `messages`,
`isPlanMode`, `maxSteps`, `pentestSession`, `imageOcrEnabled`,
`narrowNmapOperation`, `scratchDir`, `loopGuard`, `jobManager`, `mcpRuntime`,
`workLedger`, `confirmPort`, `promptMutex`, `engagementPolicy`,
`responderClaims`, `outcomeState`, `codingSession`, `toolState`,
`alreadyPrintedIds`, `sessionLooseWork`, `deferredPostToolMessages`,
`deferredResponderLedgerNotifications`, the six writers, `probeStateKey`,
`moveTurn`, `persistTaskEvidence`, `persistProjectRootOnPlan`,
`completionGateForTask`, `matchesWakeRevision`, `executeMcpAgentCall`, and the
four `responderWake*` values. That set is the contract for
`turn/tool-execution/deps.ts` when the stages below are thin enough to move.

## Remaining seams, in order

### `executeSingleTool` (834 → target ~120 of wiring)

| Seam | Target module | Est. lines out |
|---|---|---:|
| prelude: normalization, synthetic receipt, OCR guard, loop-guard verdict, `loop.reset`, MCP agent dispatch | `tool-execution/prelude.ts` | 150 |
| scope classification + audit + live plan read | `tool-execution/classification.ts` | 60 |
| destination hint, scaffold preflight, autostart, task pick | `tool-execution/preflight.ts` | 120 |
| confirmation, elevation, secret prompt, abort controller, live printer | `tool-execution/confirmation.ts` | 160 |
| watchdog + supervision + cleanup ordering | `tool-execution/run.ts` | 120 |
| responder job settlement and delegation linkage | `tool-execution/job-settlement.ts` | 90 |
| outcome accounting call, loop-guard attempt record, probe state | `tool-execution/accounting.ts` | 70 |

### iteration loop (1,189 → target ~150 of wiring)

| Seam | Target module | Est. lines out |
|---|---|---:|
| request preparation: compaction hook, responder inbox, system refresh, assembly, dispatch | `loop/round-request.ts` | 220 |
| stream failure ladder and retry bookkeeping | `loop/round-failure.ts` | 150 |
| completion interpretation, native/text extraction, salvage, output-limit continuation | `loop/round-completion.ts` | 200 |
| empty/no-call answer path: recovery ladder → assessment → finalize → outcome | `loop/round-answer.ts` | 200 |
| execution round: suppression, batch guard, group run, closeout | `loop/round-execution.ts` | 180 |

### turn setup (655 → target ~150 of wiring)

| Seam | Target module | Est. lines out |
|---|---|---:|
| session/plan/orientation/instructions/skills/prompt composition | `setup/turn-services.ts` | 260 |
| emitters, recorders, ledgers, state records, `moveTurn`, `probeStateKey` | `setup/turn-ports.ts` | 220 |

Imports shrink as bodies leave; expected final shell 350–450 lines. Remove the
`src/agent/runner.ts` entry from `test/architecture/legacy-baseline.json` in the
same commit it first reaches ≤ 1,000 lines.

## Gate rules that cost time when ignored

1. Never nest more than one non-trivial closure inside a factory — the analyzer
   attributes nested bodies to the enclosing function.
2. No `unknown` in a parameter or port type; narrow at the runner boundary or
   reuse the callee's exported payload type (`CompactionAuditPayload`).
3. Regex-based identifier migration must skip `X:` keys, `X?:` optional keys,
   `"X"` string literals, and comments, and must fix `{ X }` shorthand. Three
   separate breakages in this session came from those cases; one changed a
   user-visible cancellation string.
4. Declare a migrated state record **above its first textual use** — closures
   created earlier in setup run before later declarations (`Cannot access
   'toolState' before initialization`).
5. `test/noninteractive/stream-renderer.test.ts` only passes under
   `node scripts/run-tests.mjs` (deterministic env); a bare `npx vitest` run of
   it fails for locale reasons unrelated to the change.
6. Never run a formatter over `runner.ts` in a move commit.

## Per-seam gate set

```sh
npm run typecheck
npx vitest run <focused> --reporter=dot
npx vitest run test/agent test/admission test/context --reporter=dot
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
