# Phase 7 — Repository-wide structural closure

Status: **planned**
Depends on: Phase 6 complete
Scope: every remaining production source module and unresolved structural/type/comment finding

## Objective

Finish the repository-wide work that is not naturally closed by Phases 1-6. Bring every ordinary production file and function under the structural thresholds, eliminate explicit `any` and unsafe type escapes, classify and close `unknown` misuse, remove obsolete architecture exceptions, and review comment debt without mechanical deletion.

This is not a bulk sweep. Work one module/debt class at a time with characterization and reversible commits.

## Entry criteria

- Phase 0's quality reports and comparators are stable and current.
- Phases 1-6 are complete with no baseline regression.
- Every frozen `>1,000` target addressed by earlier phases has had its remove-only entry updated.
- A fresh machine-readable inventory lists every remaining line, complexity, type, suppression, architecture, and comment-review finding.
- Full canonical suite/build and architecture checks pass before closure work starts.

## Scope

In scope:

- all remaining ordinary production TypeScript/TSX files at or above 500 physical lines;
- all remaining function-like units at or above cyclomatic/cognitive 22 or Halstead difficulty 80;
- all 40-audit-baseline explicit `any` sites that remain after earlier phases;
- all boundary/internal `unknown` classifications and unsafe uses;
- double assertions, broad unchecked casts, and suppression markers;
- remaining remove-only oversized/runtime-policy architecture debt;
- parser/token-discovered long, stale, duplicate, syntax-narrating, or commented-out implementation comments;
- uncategorized modules such as CLI entry/commands, MCP, OS adapters, session runtime, smaller LLM/tool/store/safety modules, and scripts when they contain production behavior.

Out of scope:

- arbitrary prompt Markdown reflow or generated output edits;
- broad formatting/rename sweeps;
- changing public APIs or behavior to make a metric easier;
- introducing generic abstractions solely to suppress duplication metrics;
- terminal coverage/mutation/dead/duplication closure, which completes in Phase 8 (though no regression is allowed here).

## Workstream 1 — remaining file-size inventory

1. Generate a sorted report of every ordinary production file `>=500` lines.
2. Assign each file to an owner, behavior contract, characterization suite, target folder, and rollback unit.
3. Extract cohesive domain/policy/adapter/pure-helper seams; do not split by arbitrary line ranges.
4. Keep new files below 400 lines where practical, always below 500.
5. Preserve stable facade exports until callers migrate.
6. Remove a legacy oversized entry in the same commit that makes it obsolete; never add an entry.

Behavior-bearing prompt Markdown, generated outputs, and contractual fixtures stay exempt from cosmetic splitting. Executable code embedded in an exempt category still requires explicit review.

## Workstream 2 — complexity and CRAP structure

For each remaining threshold violation:

- characterize branch combinations and failure paths;
- separate decoding, policy, side effects, and presentation;
- replace boolean/nullable state combinations with discriminated state where behavior already supports it;
- extract pure decision tables/predicates rather than hiding branches in callbacks;
- preserve short-circuit order and side effects;
- use coverage and mutation to prove extracted decisions, but do not claim final repository mutation closure until Phase 8.

At Phase 7 close every function-like unit must be below cyclomatic/cognitive 22 and Halstead difficulty 80 under the pinned analyzer.

## Workstream 3 — explicit `any` and unsafe casts

Reach zero explicit `any` in production scope by choosing the actual remedy:

- define a domain type for trusted internal data;
- accept `unknown` only at an untrusted boundary and decode it;
- use a generic constrained to the consumed shape;
- model optional/variant behavior with a union;
- fix an inaccurate third-party declaration with a narrow local adapter.

Do not replace `any` with `unknown as T`, double assertions, an index signature that erases structure, or a generic that is effectively `any`. Remove double assertions and broad unchecked casts. Narrow local assertions require a proven invariant and should disappear behind a validated constructor/decoder.

## Workstream 4 — `unknown` classification

Maintain a machine-readable ledger with three categories:

1. **Boundary-valid** — untrusted JSON/provider/MCP/tool/config/environment/error value, narrowed before domain use.
2. **Narrowing-required** — boundary value consumed, asserted, spread, indexed, or forwarded before proof.
3. **Internal-imprecision** — trusted internal APIs use `unknown` instead of a domain type.

The terminal gate is zero narrowing-required and zero internal-imprecision findings. Boundary-valid `unknown` is retained because it is safer than `any`; its decoder and failure tests are evidence. Report the raw count for transparency but do not ratchet it blindly.

## Workstream 5 — suppressions

Eliminate the five audit-baseline suppression sites and any added later. For each:

- reproduce the type/tool limitation;
- fix the local type/adapter or upgrade only in a separate approved dependency change;
- add a test for the invariant the suppression previously hid;
- remove the marker.

No `@ts-ignore`, unscoped `@ts-expect-error`, disabled checker block, blanket lint disable, or mutation/coverage ignore may remain unresolved. Narrow generated/third-party technical exclusions must follow Phase 0 governance and cannot hide production logic.

## Workstream 6 — comment review

Use TypeScript AST/token positions and a review report to find comments; never regex-delete comments. Review each candidate in context.

Preserve:

- licenses and generated markers;
- public API documentation;
- security invariants and threat-model notes;
- protocol references and wire-format rationale;
- compatibility/platform explanations;
- non-obvious performance or lifecycle constraints.

Delete only comments that narrate syntax, duplicate the implementation, are stale/contradicted, or contain commented-out code. Update rationale only in a separate cleanup commit after behavior movement is proven. A lower comment count is not itself a gate; zero unresolved reviewed findings is.

## Workstream 7 — architecture closure

- Empty `oversizedSourceFiles` once all listed files are below the existing threshold.
- Remove runtime-policy import exceptions as dependencies are inverted or moved behind ports.
- Keep lists sorted and remove-only until empty.
- Add focused architecture rules for the stable end-state only after proving they do not grandfather new debt.
- Detect import cycles and hidden barrel cycles with the Phase 0 toolchain.
- Preserve explicit `.js` ESM imports and renderer/runtime-policy direction.

## Required characterization

For each module, identify its existing targeted tests before moving it. The repository-level closure suite must include:

```sh
npm run test:arch -- --reporter=dot
npm run test:conformance -- --reporter=dot
npm run test:admission -- --reporter=dot
npx vitest run test/security test/mcp test/session-runtime --reporter=dot
```

Add module-specific tests for every previously uncovered branch. Do not rely only on the final full suite.

## Acceptance criteria

- [ ] Every ordinary production source file is `<500` physical lines; Classic files remain `<=400`.
- [ ] Every function-like unit has cyclomatic `<22`, cognitive `<22`, and Halstead difficulty `<80`.
- [ ] Explicit `any` count is zero.
- [ ] `unknown` ledger has zero narrowing-required and zero internal-imprecision findings; every retained boundary site has a validated narrowing path.
- [ ] Double assertions, unsafe broad casts, and unresolved suppressions are zero.
- [ ] Comment-review backlog is zero without deleting licenses/rationale/contracts.
- [ ] Oversized architecture baseline and obsolete runtime-policy exception debt are empty; no replacement exceptions were added.
- [ ] New dead/duplicate/mutation/coverage findings did not increase.
- [ ] Targeted suites, architecture, canonical full suite, build, and repository structural quality gates pass.

## Validation

The `test:deterministic` and `quality:*` scripts below are Phase 0 deliverables and must exist before this phase begins; use the final names recorded by Phase 0.

After each module/debt seam:

```sh
npm run typecheck
npx vitest run <targeted-test-files> --reporter=dot
npm run test:arch -- --reporter=dot
npm run quality:changed
```

At phase close:

```sh
npm run typecheck
npm run embed-prompts:check
npm run test:arch -- --reporter=dot
npm run test:conformance -- --reporter=dot
npm run test:admission -- --reporter=dot
npm run test:deterministic -- --reporter=dot
npm run build
npm run quality:report
npm run quality:ratchet
npm run quality:types
npm run quality:comments
git diff --check
```

Run Bun/PTTY/platform tests for modules touched in this phase; full matrix closure remains Phase 8.

## Commit and rollback plan

Use one module and one debt class per commit. Characterization precedes extraction; pure movement precedes naming/type/comment cleanup. Do not combine repository-wide cast or comment deletion. Revert any seam that changes behavior or requires a baseline increase. Phase 8 starts only when the machine reports zero unresolved structural/type/architecture/comment-review findings.
