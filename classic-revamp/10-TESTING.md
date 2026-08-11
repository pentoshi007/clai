# Testing

Runner: `vitest` 4.1.10, already configured. Property tests: `fast-check` 4.9.0, already a
dev dependency. Frame capture: `ink-testing-library` 4.0.0, added in W00.

## Principles

1. Tests prove **state and effects**, not only rendered strings. A snapshot that passes while
   the controller was never called is worthless.
2. Golden fixtures for visuals, at a fixed matrix of sizes and capability combinations.
   Regenerate deliberately, review the diff, never blanket-update.
3. Table-driven tests for adapters, enumerated from the source of truth so a new binding or
   command cannot be added without a test path.
4. Property and fuzz tests for anything parsing bytes or computing layout.
5. Fake clocks, fake streams, isolated config and data directories. No real provider calls.
6. Every existing test in `test/app` and `test/tui-v2` keeps passing, unchanged in content,
   at every work-package boundary.

## Layout

```
test/
  ui-core/
    architecture.test.ts          no ink, no @opentui, no stdout writes
    ui-selection.test.ts          precedence + defaultUiForPlatform
    status-segments.test.ts       extracted status model
    context-limit.test.ts         parse + format
    markdown-ansi.test.ts         AnsiLine[] seam, both renderers
  classic/
    architecture.test.ts          no @opentui, no src/tui-v2, no useInput, no stray stdout
    startup.test.ts               mount with fake streams
    lifecycle.test.ts             every exit path, once each
    session.test.ts               persistence, no-history, privacy, resume
    cross-renderer-history.test.ts
    commands.test.ts              every catalogue command → service state
    performance.test.ts           coalescing, feed bounds, semantic budget
    input/
      raw-decoder.test.ts
      raw-decoder.fuzz.test.ts
      chord-table.test.ts         enumerates defaultKeymap
      paste.test.ts
      sgr-mouse.test.ts
      focus-routing.test.ts
      double-press.test.ts
      fixtures/windows/*.json
    chrome/
      row-budget.test.ts
      frame-height.test.ts
      status-density.test.ts
      toast.test.ts
    composer/
      editor-model.test.ts
      completion.test.ts
      paste.test.ts
      history.test.ts
    feed/
      feed-blocks.test.ts
      commit-ledger.test.ts
      live-tail-policy.test.ts
      invariants.test.ts
      __fixtures__/*.txt
    panels/
      picker.test.ts  pager.test.ts  jobs.test.ts  plan.test.ts
      confirm.test.ts  secret.test.ts  scope.test.ts  keys.test.ts
      prompt-actions.test.ts  search.test.ts  overlay-stacking.test.ts
    app/
      actions.test.ts             enumerates ACTION_IDS
      feed-behaviour.test.ts      the action remapping table
  noninteractive/
    stream-blocks.test.ts  stream-renderer.test.ts  stream-split.test.ts
    nontty.test.ts  spinner.test.ts  confirm.test.ts  exit-codes.test.ts
  agent/
    runner-no-direct-writes.test.ts
```

## Architecture guards

Written **before** the code they guard, in W02 and W04. Each walks a directory tree and
asserts on import specifiers and raw source patterns, the same technique
`test/app/architecture-guard.test.ts` already uses.

| Guard | Forbidden |
|---|---|
| `test/app/architecture-guard.test.ts` (extend) | React, Ink, OpenTUI, inquirer, `process.stdout.write`, and now `src/repl` |
| `test/ui-core/architecture.test.ts` | `ink`, `ink-*`, `@opentui/*`, `process.stdout.write`; `react` allowed only under `ui-core/react/` |
| `test/classic/architecture.test.ts` | `@opentui/*`, `../tui-v2/`, `useInput`, `process.stdout.write` outside `bootstrap/terminal-session.ts`, direct imports of `agent/runner`, `tools/registry`, `llm/router`, `store/*`, `safety/*` |
| `test/tui-v2/architecture.test.ts` (extend) | `../classic/`, `../noninteractive/` |

Add a file-size guard in `test/classic/architecture.test.ts`: no file under `src/classic`
exceeds 400 lines. It will fail loudly the moment a component starts absorbing logic.

## Golden fixture matrix

`test/classic/feed/__fixtures__/` and `test/classic/chrome/`:

- Widths: 40, 48, 68, 80, 96, 120, 200.
- Rows: 8, 12, 24, 50.
- `colorMode`: `truecolor`, `none`.
- `unicode`: true, false.

Not the full cross product. Required combinations:

| Fixture | Width × rows | colorMode | unicode |
|---|---|---|---|
| full feed, all nine block kinds | 80 × 24 | truecolor | true |
| full feed | 120 × 50 | truecolor | true |
| full feed | 44 × 12 | truecolor | true |
| full feed | 80 × 24 | none | true |
| full feed | 80 × 24 | 16 | false |
| degraded chrome | 80 × 8 | truecolor | true |
| every panel | 80 × 24 | truecolor | true |
| every panel | 48 × 14 | truecolor | true |
| status ladder | 40/48/68/96/120 × 24 | truecolor | true |
| CJK + emoji + combining + ANSI tool output | 80 × 24 | truecolor | true |

`invariants.test.ts` runs the six mechanical assertions from
[03-RENDER-MODEL.md](03-RENDER-MODEL.md) §12 over **every** fixture, so adding a fixture
automatically extends the coverage.

## Property and fuzz tests

| Target | Property |
|---|---|
| `allocateChrome` | `total <= rows` for rows 1–200 × every demand combination; `liveTail` is monotonic in `rows` |
| shared shell geometry | `horizontalPadding()` is symmetric; bounded rows stay within `innerShellWidth(columns)` and never write beyond either shell boundary |
| `raw-decoder` | never throws; never emits a `KeyEvent` whose `text` contains `\x1b`; consumes every accepted byte; chunk-split input equals whole input |
| `wrap` | every produced line's `stringWidth` is `<= width`; joining lines reproduces the input's visible text; prose, transcript, composer, and pager content reflows instead of truncating at the boundary |
| `commit-ledger` | `committedCount` never decreases across a random event sequence; no block appears in both `committed` and `live` |
| `sanitizeDisplayText` | output contains no C0 control except `\n` and `\t`, and no CSI introducer |
| `editor-model` | cursor stays within bounds under any operation sequence; grapheme count is preserved by move operations |

## Contract tests across renderers

The strongest anti-drift mechanism. `test/classic/cross-renderer-history.test.ts` and a new
shared fixture set:

1. A single scripted `AgentEvent[]` fixture in `test/fixtures/turn-events.json` covering
   assistant text, thinking, three tools, a failure, a blocked tool, a file diff, a batch, a
   compaction, and an abort.
2. Feed it to a `TranscriptStore` and assert the resulting `TranscriptState` — one assertion
   shared by both renderers.
3. Render that state through the classic feed and through the OpenTUI presenters, and assert
   both contain the same **semantic** content: the same tool names, the same statuses, the
   same diff counts, the same token labels. Not the same bytes.
4. Persist through the classic harness, resume in the OpenTUI harness, and vice versa;
   assert equal hydrated state.

## PTY tests

The automated smoke is intentionally provider-independent. It does not submit a model prompt,
assert a tool card, or imply provider-backed abort coverage; doing so would require credentials
and network/host-specific behavior that this checkout cannot guarantee.

`scripts/pty-smoke.py` launches `node bin/clai.mjs --classic --no-history` in a POSIX PTY with
isolated config/data/history directories and offline/update checks disabled. It:

1. waits for the exact `Ask anything` readiness marker;
2. opens `/help` (including the two-Enter slash-completion path), closes the pager, and types a
   draft without submitting it;
3. resizes the PTY from 100×30 to 60×20;
4. sends Ctrl+C twice; and
5. asserts exit code 0, startup alternate-screen-on plus clear-screen/home, teardown
   cursor-show, bracketed-paste-off, and alternate-screen-off, restored `ECHO` and `ICANON`,
   and a modeled post-resize row width no greater than 60.

Run it with:

```sh
npm run test:classic:pty
```

The local macOS result is recorded after the current full-height alternate-screen smoke is
run. A Windows ConPTY job is deliberately not claimed: no Windows host, `winpty`/ConPTY
implementation, or Windows CI-green result was available for this work package. Provider-backed
turn/turn-abort coverage, Windows Terminal/PowerShell/cmd.exe/VS Code walkthroughs, Linux
local-host evidence, and manual OpenTUI walkthrough evidence remain separate open gates.

## Performance test

`test/classic/performance.test.ts` covers only deterministic Node-side guarantees available
without a live terminal:

- 8,000 `assistant-delta` events through `TranscriptStore` produce one coalesced subscriber
  notification after the 16 ms batching window;
- 200 tool-output lines stay bounded in a classic feed block;
- pathological feed blocks stay within `MAX_BLOCK_ROWS`; and
- a 10,000-item semantic transcript is folded within a generous 2,000 ms budget.

This suite does **not** claim a live frame-write count, CPU percentage, or native terminal
frame timing. Those measurements require a provider-backed/live terminal run and remain
unavailable here.

## CI

`.github/workflows/ci.yml` contains a genuine `classic-posix` matrix job:

| Job | OS | Runs |
|---|---|---|
| gate | ubuntu | `npm run typecheck`, `npx vitest run`, `npm run embed-prompts:check` |
| audit | ubuntu | `npm audit`, `npm audit --omit=dev` |
| bun | ubuntu | `npm run test:bun` |
| classic-posix | ubuntu, macos | `npx vitest run test/classic test/ui-core test/noninteractive`, `npm run test:classic:pty` |
| build | ubuntu | `npm run build`, `npm run compile`, `npm run release:verify` per artifact |

There is no `classic-windows` job in this record. Adding a Windows ConPTY job without a
verified implementation and meaningful assertions would create a false release signal.
The CI Node matrix is `[22, 24]`, matching the `>=22` engine floor.

## Release gates

Only a gate with evidence available in this checkout is marked `[x]`. A green local test does
not close a gate that also requires a target host, manual walkthrough, provider, live terminal
measurement, or a size reduction. The complete narrative and measurements are in
[W18-RELEASE.md](W18-RELEASE.md).

1. [ ] **Node 22 and Node 24 typecheck.** `npm run typecheck` passed on the local Node
   v26.4.0 host; Node 22/24 local runs and CI results are not available here.
2. [x] **Full Vitest suite.** `npx vitest run` passed: 403 files, 3,769 tests, 10 skipped.
   The skips are the intentionally unrecorded Windows fixture cases; no new skip was added
   for this migration.
3. [ ] **`test/app` and `test/tui-v2` green and unchanged in content.** The suites are green
   as part of the full run, but the migration includes import/path updates in those trees, so
   the stronger unchanged-content condition is not claimed.
4. [x] **Architecture guards.** Full-suite architecture tests passed, including the classic
   `src/classic` 400-line file-size guard.
4a. [x] **Dependency audits.** Both `npm audit` and `npm audit --omit=dev` returned
   `found 0 vulnerabilities`.
4b. [x] **Deprecation sweep.** The W00 records remain clean for direct dependency
   deprecations, Node runtime deprecations under `--throw-deprecation`, and Ink mount
   warnings; no contrary warning appeared in the final commands.
5. [ ] **Golden fixture matrix.** Automated classic fixture and invariant tests passed in the
   full suite, but a complete visual diff review across the specified matrix is not recorded.
6. [x] **Property and fuzz suites.** The full suite passed the raw-input fuzz/property and
   layout/feed property coverage.
7. [x] **Cross-renderer contract tests.** `test/classic/cross-renderer-history.test.ts`
   passed in the full suite in both directions.
8. [ ] **PTY smoke on Windows, macOS, and Linux.** The provider-independent smoke passed
   locally on macOS with the exact output `PTY smoke passed: exit=0, bytes=25842,
   max_visible_row=59, echo=on, initial_echo=on`; Windows and Linux-host results are not
   available. The CI matrix configuration is not a hosted result.
9. [ ] **Performance with measured CPU.** Deterministic coalescing, feed bounds, row caps,
   and semantic-transcript budget tests passed; CPU percentage and live frame-write counts
   require unavailable provider-backed/live-terminal evidence.
10. [x] **Build and five-target compile.** `npm run build` passed after cleaning `dist`, and
    `npm run compile` produced all five configured targets: Darwin arm64/x64, Linux
    arm64/x64, and Windows x64.
11. [x] **Release verification.** `npm run release:verify` passed with
    `Release inputs verified for 3.17.0: exact dependencies and synchronized lockfile`.
12. [ ] **Windows binary runtime probe.** Cross-compilation passed, but no Windows host or
    Process Monitor/runtime probe was available.
13. [ ] **Manual Windows walkthrough.** Windows Terminal, PowerShell, cmd.exe/conhost, and
    VS Code terminal evidence is unavailable.
14. [ ] **Manual OpenTUI walkthrough on macOS.** No manual walkthrough evidence is recorded.
15. [ ] **Size requirement.** Final measurements are recorded, but package, dist, and all
    POSIX binaries are larger than the W00 baseline; the "smaller than baseline" condition
    is not met.
16. [ ] **Full parity checklist.** Automated parity-related tests passed, but the target-host,
    provider-backed, and manual rows in [09-PARITY.md](09-PARITY.md) remain open.
17. [ ] **Task tracker fully checked.** [12-TASKS.md](12-TASKS.md) intentionally retains
    unavailable W17/W18 gates as unchecked.
