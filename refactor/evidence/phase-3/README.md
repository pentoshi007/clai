# Phase 3 evidence — tools, jobs, files, shell

Branch `refactor/codebase`. Environment: Linux x64, Node 24, canonical locale/TZ via
`scripts/run-tests.mjs`.

## Entry

Plan characterization suites green before movement: tools, registry, normalize,
batch, batch-fail-policy, jobs (durable/hygiene/session-scope/poll-bounding/tail),
fs (append/edit-delete/read-directory/read-smart/write-many), shell
(bounded/interactive/launch-retry/no-match-exit), pkg-install, process-tree and
security — 53 files, 399 passed, exit 0.

## Result

| Module | Entry | Now |
|---|---:|---:|
| `src/tools/definitions.ts` | 1,649 | 67 |
| `src/tools/registry.ts` | 2,126 | 246 |
| `src/tools/fs.ts` | 1,471 | 337 |
| `src/tools/shell.ts` | 1,042 | 285 |
| `src/tools/jobs.ts` | 2,590 | 2,033 |

New families: `tools/definitions/` (11 family modules + `define`, `aggregate`,
`selection`), `tools/handlers/` (14 dispatch families + `args`, `nmap-preparation`,
`responder-job-options`), `tools/batch/` (`run-batch`, `limits`), `tools/fs/`
(`read`, `read-window`, `search`, `mutations`, internals), `tools/shell/`
(`capture`, `spawn-argv`, `exec-attempt`, `artifact-name`, internals),
`tools/jobs/` (`types`, `limits`, `helpers`, `polling-policy`, `process-identity`,
`redacted-writer`), plus `tools/call-normalization.ts` and `tools/shell-quoting.ts`.

`definitions.ts`, `registry.ts`, `fs.ts` and `shell.ts` were removed from
`test/architecture/legacy-baseline.json` in the commits that took them under 1,000
lines. Remaining oversized entries: 13.

## Aggregate equivalence evidence

Both aggregates were dumped from a pristine `git worktree` at the phase-entry commit
and from the refactored tree, then compared:

* **Tool definitions** — 60 tools; `TOOL_DEFINITIONS` order, every schema, and the
  `agent`/`ask`/`plan` projections are **byte-for-byte identical**.
* **Registry** — `Object.keys(toolRegistry)` order, `availableToolNames("agent")`,
  `availableToolNames("ask")`, `knownToolNames()` and `BATCH_SAFE_TOOLS` are
  **byte-for-byte identical**.

The literal splitter guarantees order by construction: it emits *contiguous
segments* in original order and rebuilds the aggregate as spreads, so a family that
appears twice in the source produces two ordered segments rather than a reordered
bucket.

`quality:contracts` reports public contracts unchanged. Where a move required
widening a helper that stayed behind, `scripts/refactor/restore-surface.mjs`
relocated it into an internal module so no new public export remained.

## Close matrix

| Command | Result |
|---|---|
| `npm run typecheck` | clean |
| `npm run embed-prompts:check` | 2 prompts match |
| `npm run test:arch` | 5 passed |
| tools/jobs/fs/shell/security suites | 272 passed |
| `npm run test:deterministic` | 599 files, 6,002 passed, 12 skipped |
| `npm run build` | dist emitted |
| `npm run quality:contracts` | unchanged |
| `npm run quality:changed` | 0 failures |
| `npm run quality:ratchet` | 553 held, 98 improvements, 0 regressions |
| `git diff --check` | clean |

Not run on this host: `npm run test:classic:pty` requires an interactive POSIX PTY,
and Windows/macOS process and privilege behavior needs those hosts. Recorded as out
of local scope, never claimed as passed.

## Deviation recorded

`JobManager` (2,006 of the 2,033 remaining lines in `jobs.ts`) was **not**
decomposed. Its large members (`startJob` 462, `stopJob` 187,
`ensureCompletionNotification` 148, `tailJob` 123, `cancelAll` 117) touch private
fields, so extracting them requires either widening `JobManager`'s public type —
a real contract change the phase forbids — or introducing per-method dependency
records as Phase 1 did for the runner. The latter is the correct approach and is
deferred to Phase 7 closure. Everything around the class was extracted, and the
class remains the single owner of job state, which is what the plan requires.

A process deviation was found and corrected mid-phase: files touched early in the
phase were run through Prettier, which this repository does not use (no config, no
format script, and `prettier --check` fails at the anchor). That inflated
`jobs.ts` by 343 lines. The jobs split was redone from the pristine revision so the
moved code is verbatim, and Prettier was dropped for the remainder of the program.
