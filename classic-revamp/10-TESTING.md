# Testing

Runner: `vitest` 4.1.9, already configured. Property tests: `fast-check` 4.8.0, already a
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
    performance.test.ts           write count + CPU budget
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
| `allocateChrome` | `total <= rows - 1` for rows 1–200 × every demand combination; `liveTail` is monotonic in `rows` |
| `raw-decoder` | never throws; never emits a `KeyEvent` whose `text` contains `\x1b`; consumes every accepted byte; chunk-split input equals whole input |
| `wrap` | every produced line's `stringWidth` is `<= width`; joining lines reproduces the input's visible text |
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

`scripts/pty-smoke.py` already exists. Extend it with a classic scenario and keep it callable
from CI:

1. Spawn `clai --classic` in a PTY at 100×30.
2. Wait for the composer frame.
3. Send a prompt, wait for a tool card.
4. Send Esc Esc, assert the abort notice.
5. Resize to 60×20, assert no row exceeds 60 and no stale row remains.
6. Send Ctrl+C Ctrl+C, assert exit within 3 seconds.
7. Assert the captured byte stream after exit contains the cursor-show and
   bracketed-paste-off sequences and no alternate-screen sequence at all.
8. Assert the terminal's final state has echo enabled.

Run the same script for `clai --mode agent "echo hi"` to cover the non-interactive path, and
on Windows with `winpty`/ConPTY in the W17 CI job.

## Performance test

`test/classic/performance.test.ts`, fake clock plus a counting writable stream:

- 8,000 `assistant-delta` events, 200 `tool-output` lines, 12 structural events over a
  simulated 60 seconds.
- Assert frame writes < 400.
- Assert no single frame exceeds `rows * columns * 4` bytes.
- Assert `buildFeedBlocks` is called fewer than 120 times (once per coalesced notification,
  not per delta).
- Separately, hydrate 10,000 transcript items and assert one frame renders in under 50 ms.

CPU percentage is measured manually during the W17 PTY run and recorded, since it is not
reliably assertable in CI.

## CI

`.github/workflows/ci.yml` gains a `windows-latest` job. Final matrix:

| Job | OS | Runs |
|---|---|---|
| gate | ubuntu | `npm run typecheck`, `npx vitest run`, `npm run embed-prompts:check` |
| audit | ubuntu | `npm audit`, `npm audit --omit=dev` — both must report zero advisories |
| bun | ubuntu | `npm run test:bun` |
| classic-posix | ubuntu, macos | `npx vitest run test/classic test/ui-core test/noninteractive`, PTY smoke |
| classic-windows | windows | the same vitest selection, PTY smoke via ConPTY |
| build | ubuntu | `npm run build`, `npm run compile`, `npm run release:verify` per artifact |

`node-version` moves from `20` to `[22, 24]`, matching the raised `engines.node` floor.
Node 20 is EOL and must not be in the matrix — see
[13-DEPENDENCIES.md](13-DEPENDENCIES.md) §2.

## Release gates

Every one, with recorded output, before the work is declared done:

1. `npm run typecheck` clean on Node 22 and Node 24.
2. `npx vitest run` fully green, no skips added by this migration.
3. `test/app` and `test/tui-v2` green and unmodified in content.
4. All architecture guards green, including the 400-line file-size guard.
4a. `npm audit` and `npm audit --omit=dev` report zero advisories.
4b. Deprecation sweep clean: no deprecated direct dependency, no Node runtime deprecation
    under `--throw-deprecation`, no Ink mount warning
    ([13-DEPENDENCIES.md](13-DEPENDENCIES.md) §7).
5. Golden fixture matrix green; every fixture diff reviewed.
6. Property and fuzz suites green.
7. Cross-renderer contract tests green.
8. PTY smoke green on Windows, macOS, and Linux.
9. Performance test green; measured CPU recorded.
10. `npm run build` and `npm run compile` succeed for all five targets.
11. `npm run release:verify` passes per artifact.
12. Windows binary probe from [07-PLATFORM-PACKAGING.md](07-PLATFORM-PACKAGING.md) §5 passed.
13. Manual Windows walkthrough in Windows Terminal, PowerShell, and cmd.exe: start, prompt,
    tool call, confirm, diff, pager, picker, plan panel, jobs panel, abort, exit.
14. Manual OpenTUI walkthrough on macOS proving no regression.
15. Size measurements recorded, npm package and POSIX binaries smaller than baseline.
16. [09-PARITY.md](09-PARITY.md) fully checked, deviations limited to the approved table.
17. [12-TASKS.md](12-TASKS.md) fully checked.
