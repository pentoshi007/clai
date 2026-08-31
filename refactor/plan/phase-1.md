# Phase 1 — Agent turn orchestration

Status: **planned**
Depends on: Phase 0 complete
Primary hotspot: `src/agent/runner.ts` (audit: 6,769 lines)

## Objective

Turn `runner.ts` into a small, stable facade over cohesive turn-orchestration modules while preserving every agent-loop behavior. Keep the public signatures of `runAgentLoop` and `runAgentTurn`. Make turn-local state ownership explicit before moving closure-heavy code.

The audit ranked `runAgentTurn` at approximately 6,129 lines with cyclomatic/cognitive proxies of 456/1,255 and `executeSingleTool` at approximately 1,753 lines with proxies of 408/731. These values prioritize the work; Phase 0's pinned analyzer supplies the actual gates.

## Scope

In scope:

- `src/agent/runner.ts`;
- new cohesive modules under an explicit `src/agent/turn/` or equivalent folder;
- runner-specific types and pure helpers currently embedded in the file;
- focused tests in `test/agent`, `test/admission`, `test/context`, and root runner/responder/compaction/finalization suites;
- caller import migrations that preserve facade exports.

Out of scope:

- LLM HTTP/router internals (Phase 2);
- registry/job/fs/shell implementation internals (Phase 3);
- parser, plan-tool, evidence, and loop-policy decomposition (Phase 5);
- renderer cleanup (Phase 6);
- changing prompts, tool schemas, safety policy, retry policy, or user-visible wording.

## Protected contracts

Characterization must prove:

- unchanged `runAgentLoop` and `runAgentTurn` exports/signatures;
- no direct terminal writes from the runner; events remain the output boundary;
- event type, ID, payload, order, and exactly-once behavior;
- streaming text/thinking/tool ordering and partial-result handling;
- native and text tool-call sequencing, protocol repair, result recording, and artifact references;
- cancellation/abort/error/loop-guard/partial/completed outcomes and exit semantics;
- compaction admission, thresholds, token accounting, summary placement, fallback/retry, and context continuity;
- responder claim identity, parent/child relationship, wake/poll, persistence, completion, and recovery;
- evidence gates, plan/task state, must-continue decisions, and final-answer gating;
- usage/cache accounting, failed-attempt usage, elapsed/working-time events, persistence, and finalization exactly once;
- queued prompt continuation and pause rules after cancel/error/loop guard;
- safety and scope calls occur at the same point with the same arguments;
- no duplicated mutable singleton or turn owner.

## Required characterization

Before extraction, run and strengthen at least:

```sh
npx vitest run \
  test/agent \
  test/admission/turn-admissions.test.ts \
  test/admission/request-fingerprint.test.ts \
  test/admission/operation-ledger.test.ts \
  test/context \
  test/turn-state.test.ts \
  test/compaction-summary.test.ts \
  test/finalize-gate.test.ts \
  test/must-continue.test.ts \
  test/responder-domain.test.ts \
  test/responder-inband.test.ts \
  test/responder-parent.test.ts \
  test/responder-persistence.test.ts \
  test/responder-polling-policy.test.ts \
  test/responder-wake.test.ts \
  --reporter=dot
```

Add tests for any unprotected branch before moving it. Use deterministic clocks/IDs and fake transports; do not widen mocks until they no longer exercise the real orchestration contract.

## Dependency and ownership map

Create a reviewed map before code movement. For each captured value in `runAgentTurn` and `executeSingleTool`, classify it as:

- immutable turn input;
- mutable turn state with exactly one owner;
- injected port/service;
- event/output sink;
- cancellation/clock/ID dependency;
- persistent store or singleton reference;
- derived value that should become a pure function result.

Do not pass a single untyped “runner context” containing the whole closure. Define narrow interfaces per extracted service, use readonly inputs where possible, and return explicit state transitions/results.

## Intended module seams

Final names may follow existing conventions, but responsibilities must remain separate:

1. **Continuation overlap utilities** — pure text overlap/collapse helpers and existing top-level pure functions.
2. **Turn event/output emitter** — constructs and emits typed events without owning orchestration policy.
3. **Tool-result recorder** — normalizes the already-executed result into history/events/artifacts; does not reclassify safety.
4. **Compaction coordinator** — admission, progress events, execution, fallback, summary insertion, and accounting through explicit ports.
5. **Responder claims/coordinator** — identity, ownership, wake/poll, parent linkage, and terminal state.
6. **Turn finalizer** — maps terminal state to persistence/events/queue continuation exactly once.
7. **Tool-execution coordinator** — decomposes `executeSingleTool` by orchestration concern while calling unchanged registry/safety/session APIs.
8. **Turn state/types** — discriminated state and transition/result types shared narrowly, not a dumping ground.
9. **Runner facade** — validates inputs and composes services; retains public exports and minimal orchestration.

Avoid barrels that hide circular dependencies. The dependency direction should point from the facade/coordinator to pure/domain helpers and explicit ports, never back into `runner.ts`.

## Work sequence

### 1. Freeze the facade

- Add compile-time/runtime export and signature tests.
- Capture representative event transcripts and request fingerprints.
- Confirm `test/agent/runner-no-direct-writes.test.ts` fails on a synthetic direct write.

### 2. Extract pure helpers

Move referentially transparent utilities first with no renaming/reformatting. Keep re-exports where any external import exists. Run focused tests and changed-code metrics after each group.

### 3. Introduce narrow ports and turn state

Model clock, cancellation, output, persistence, compaction, responder, registry, safety, and usage dependencies explicitly. This commit should change structure/types, not outcomes or user text.

### 4. Extract output and recording

Move event construction/emission, output accumulation, and result recording in separate commits. Compare exact transcript/event sequences before and after.

### 5. Extract compaction

Move one path at a time: admission/progress, executor, fallback/retry, summary application, accounting. Preserve single-admission behavior and context sizing.

### 6. Extract responder ownership

Move claims and polling/wake behavior without changing identity or persistence. Prove parent/child and recovery paths.

### 7. Extract tool execution

Split by orchestration stages: argument/result framing, confirmation/safety handoff, execution dispatch, terminal session handling, batch handling, result recording. Do not duplicate registry handlers or move their internal behavior forward from Phase 3.

### 8. Extract finalization

Centralize terminal transitions only after all outcomes are characterized. Use a state/result shape that makes double-finalization impossible or test-detectable.

### 9. Reduce the facade

Migrate internal callers mechanically, retain compatibility exports, remove dead local copies, and then perform a separate naming/comment/type cleanup. Remove `src/agent/runner.ts` from the frozen oversized baseline as soon as it reaches 1,000 lines or fewer in the same structural commit.

## Acceptance criteria

- [ ] Public exports/signatures and request fingerprints are unchanged.
- [ ] All protected event/transcript/order/outcome contracts have executable characterization.
- [ ] `runner.ts` is an ordinary facade under 500 physical lines; every new/scoped ordinary file is under 500.
- [ ] Every changed function is below cyclomatic/cognitive 22 and Halstead difficulty 80 under the Phase 0 analyzer.
- [ ] No new explicit `any`, unsafe `unknown`, double assertion, broad cast, suppression, dead export, or duplicate implementation exists.
- [ ] `src/agent/runner.ts` is removed from `legacy-baseline.json`; no baseline entry/exception is added.
- [ ] No direct writes, singleton duplication, prompt change, tool schema change, or user-visible behavior change occurred.
- [ ] Targeted, architecture, canonical full-suite, build, and quality ratchet checks pass.

## Validation

The `test:deterministic` and `quality:*` scripts below are Phase 0 deliverables and must exist before this phase begins; use the final names recorded by Phase 0.

After each seam:

```sh
npm run typecheck
npx vitest run test/agent test/admission/turn-admissions.test.ts test/admission/request-fingerprint.test.ts --reporter=dot
npm run test:arch -- --reporter=dot
npm run quality:changed
```

At phase close:

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

Use the stable script names established by Phase 0. Any event or snapshot difference requires explanation and explicit review; do not auto-update.

## Commit and rollback plan

Each intended seam is a separate `refactor(agent): ...` commit preceded by missing characterization. Keep the old facade/re-export until the new module is proven. The rollback unit is one seam, not the entire phase. If state ownership becomes ambiguous, revert the extraction, retain valid tests, and redesign the port rather than adding casts or shared mutable context.
