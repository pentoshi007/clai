# Program evidence index

| Phase | Evidence | Outcome |
|---|---|---|
| 0 | [phase-0](phase-0/README.md) | Closed. Deterministic runner, pinned analyzers, baselines, ratchets. |
| 1 | [phase-1](phase-1/completion-map.md), [seams](phase-1/seam-ledger.md) | Closed. `runner.ts` 6,769 -> 836. |
| 2 | [phase-2](phase-2/README.md) | Closed. `http.ts` 2,646 -> 91, `router.ts` 1,868 -> 418. |
| 3 | [phase-3](phase-3/README.md) | Closed with a recorded deferral (`JobManager`). |
| 4 | [phase-4](phase-4/README.md) | Closed. `history.ts` 1,931 -> 362, `plan.ts` 1,187 -> 242. |
| 5 | [phase-5](phase-5/README.md) | Closed with recorded deferrals (two manager classes). |
| 6 | [phase-6](phase-6/README.md) | Closed with recorded deferrals (three React components). |
| 7 | [phase-7](phase-7/README.md) | Partial: sizes and comments closed; type debt open. |
| 8 | [phase-8](phase-8/README.md) | Partial: local matrix green; coverage/mutation gates not met. |

## Final measured state

| Metric | Anchor | Final |
|---|---:|---:|
| `src` physical lines | 162,417 | 152,900 |
| Modules measured | 630 | 883 |
| Files over their line limit (500, or 400 under `src/classic/`) | 81 | 47 |
| Files >= 500 lines, flat count | 78 | 44 |
| Functions cognitive >= 22 | 322 | 319 |
| Functions Halstead >= 80 | 15 | 11 |
| Explicit `any` | 40 | 40 |
| Architecture legacy oversized entries | 19 | 3 |
| Tests | 5,758 | 6,002 |
| Coverage (statements) | unmeasured | 70.58% |

## Final verification (all exit 0)

`typecheck` · `embed-prompts:check` · `test:arch` (5) ·
`test:deterministic` (599 files / 6,002 passed / 12 skipped) · `build` ·
`release:verify` · `quality:contracts` (405 exports, unchanged) ·
`quality:changed` · `quality:ratchet` (532 held, 247 improvements, 0 regressions) ·
`git diff --check`.

## Refactor tooling added

`scripts/refactor/` holds the tools this program was executed with, so the
remaining work is reproducible:

| Script | Purpose |
|---|---|
| `move-symbols.mjs` | `analyze` a module's declarations and intra-module dependencies; `move` declarations verbatim into a new module, deriving imports, pulling transitive helpers (`--pull-deps`), generating setters for moved mutable bindings, and refusing a move that introduces an evaluation-time import cycle |
| `split-literal.mjs` | Split a large array/object literal into family modules as ordered contiguous segments, so the rebuilt aggregate is order-identical by construction |
| `register-relocation.mjs` | Declare a module as holding relocated legacy code with its origin, so `quality:changed` reports it as relocated and the ratchet keeps holding it |
| `restore-surface.mjs` | Move exports that a mechanical move widened back out of a frozen module, keeping its public surface identical |
| `break-cycles.mjs`, `fix-cycles.mjs` | Resolve facade/child cycles by relocating back-imported declarations |
| `strip-comments.mjs` | Token-aware comment removal with a leaf-token equivalence proof and a behavior-bearing keep list |
