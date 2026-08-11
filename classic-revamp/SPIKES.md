# W00 Spike Results

Every spike was run against the installed tree (`ink@7.1.1`, `react@19.2.8`) on
Node 22.23.2 unless stated otherwise. The spike sources lived in
`classic-revamp/spikes/` and were deleted once each finding became a recorded decision;
each is re-created as a real test in the package that depends on it.

---

## S1 — Ink 7.1.1 API surface and cross-runtime render

**Verdict: PASS on Node 22.23.2, Node 24.19.0, Node 26.4.0, and Bun 1.3.14.**

Identical results on all four runtimes: 13 stdout writes, no warning of any kind on
mount or unmount, `react` reported as 19.2.8.

| Assumption in the plan | Reality in Ink 7.1.1 |
|---|---|
| `<Static items>` exists with append semantics | yes — each item written exactly once, in order |
| `render(el, { stdout, stdin, exitOnCtrlC, patchConsole })` | all four accepted |
| `borderStyle="round"` | renders `╭ ╮ ╰ ╯` |
| `borderStyle="classic"` | renders `+ | -` |
| `useStdout`, `useApp`, `measureElement` exported | yes, plus `Transform`, `Spacer`, `Newline` |
| no deprecation warning on mount | confirmed, zero warnings |

### API surface Ink 7 adds that the plan did not know about

These are opportunities, not obligations. Where the plan already specifies an approach,
the plan wins; these are recorded so later packages can use them deliberately.

| API | Relevance |
|---|---|
| `useApp().suspendTerminal(cb)` returning a `TerminalSuspension` | a first-class terminal suspend for `$EDITOR` export. **Preferred implementation for `RendererSuspendPort` in W04**, with S4's unmount/remount proven as the fallback |
| `render` option `maxFps` (default 30) | a second, renderer-level guard alongside the trailing-edge scheduler in `app-wiring.ts`. Set explicitly rather than relying on the default |
| `render` option `incrementalRendering` | only changed lines are rewritten. Directly relevant to the SSH write budget in 03-RENDER-MODEL §9. Evaluate in W06 with a measurement, do not enable blind |
| `render` option `interactive` | explicit override of Ink's CI/TTY detection. Makes `test/classic` frame capture deterministic |
| `render` option `alternateScreen` (default `false`) | must stay `false`. The feed model forbids it |
| `render` option `concurrent` (default `false`) | must stay `false`. Concurrent timing would break the commit ledger's ordering guarantees |
| `Instance.cleanup()` | removes Ink's internal per-stdout instance. Use on teardown so a remount on the same stream is clean |
| `Instance.waitUntilRenderFlush()` | deterministic "frame is on the wire" await. Replaces sleeps in tests |
| `useCursor`, `useWindowSize`, `useBoxMetrics` | available. The caret stays the spec'd inverse-cell (04-UI-SPEC §4.1); resize stays the debounced `stdout` listener |
| `usePaste` | exists, but input still comes from our decoder only — see S5 |

---

## S2 — Streaming throughput

**Verdict: PASS, comfortably.**

10,000 synchronous deltas through a store with the production 16 ms coalescing window:

| Metric | Value |
|---|---|
| deltas pushed | 10,000 |
| store notifications emitted | 1 |
| Ink stdout writes | 6 |
| wall time | 404 ms (400 ms of which is the harness's own settle timer) |

The coalescing window is the entire mechanism. Confirms the 03-RENDER-MODEL §9 rule
"derive live blocks from the coalesced store notification, not per delta", and confirms
the performance gate of fewer than 400 frame writes is not close to binding.

---

## S3 — `<Static>` interleaving — historical scrollback-feed result

**Historical verdict: PASS only under the then-planned normal-scrollback feed.** This spike
was run before W17 chose a `TerminalSession`-owned alternate screen. Its measurements remain
important evidence about Ink 7, but its `rows - 1` conclusion is superseded by the current
full-height shell contract.

200 randomized cases: append static items *and* shrink the dynamic region in the same
commit, then assert every static line appears exactly once, in order, with no stale
dynamic row surviving below the committed output.

- First run, dynamic height allowed to reach the full terminal height: **25 failures.**
  Static items were re-emitted a second time.
- Second run, dynamic height constrained to `rows - 1`: **0 failures across 200 cases.**

### Historical root cause, read from `node_modules/ink/build/ink.js`

Ink 7 keeps a `fullStaticOutput` accumulator. `shouldClearTerminalForFrame` (ink.js:89)
returns true when the dynamic frame is *fullscreen or overflowing*:

```
wasOverflowing || (isOverflowing && hadPreviousFrame) || isLeavingFullscreen || …
    where isFullscreen  = nextOutputHeight >= viewportRows
          isOverflowing = nextOutputHeight >  viewportRows
```

and on that path `renderInteractiveFrame` writes
`ansiEscapes.clearTerminal + this.fullStaticOutput + outputToRender` (ink.js:768) — it
clears the screen and **replays the entire static history**. Additionally, on Windows
console the same clear-and-replay triggers whenever `wasFullscreen || isFullscreen`.

### Superseded consequence

For the historical normal-scrollback architecture, `ChromeLayout.total <= rows - 1` was a
design-level precondition for append-only `<Static>` output. The old record therefore required
the allocator to begin with `budget = max(rows - 1, 0)`, required `total < rows`, and treated
`commitLines` as unnecessary. Those conclusions are retained as historical spike context,
not as the current allocator or release contract.

### Current W17 interpretation

W17 owns the alternate screen, clear/home, and teardown in `TerminalSession`, with Ink's
`alternateScreen: false`. The active allocator begins with `budget = rows` and proves
`ChromeLayout.total <= rows`; the lower chrome is intentionally allowed to occupy the final
terminal row. The full-height frame-height tests and bounded shell-width tests cover this
current behavior. No claim is made here that the old normal-scrollback experiment is a valid
model for the current alternate-screen lifecycle.

---

## S4 — Unmount → child process → remount

**Verdict: PASS.**

Mount, render, `unmount()`, `await waitUntilExit()`, `spawnSync` a child that writes to
stdout, then mount a fresh tree: the child exits 0 and produces its output, the remount
renders, and no content from the pre-suspend tree leaks into the post-resume stream.

This is the fallback mechanism. S1 found `useApp().suspendTerminal()`, which is
purpose-built for this and is the preferred path for `PagerExportPort` in W04.

---

## S5 — Raw input decoding

**Verdict: the decoder is mandatory. Confirmed against Ink 7, not assumed from Ink 6.**

Measured through Ink 7's own `parseKeypress` and `createInputParser` — the two modules
that back `useInput` and `usePaste`.

| Input | Ink 7 reports | We need | OK? |
|---|---|---|---|
| `\x1b[13;2u` CSI-u | `name: "return", shift: true, isKittyProtocol: true` — **but also** `isPrintable: true, text: "\r"` | `shift+enter`, no text | partial |
| `\x1b[13;5u` CSI-u | `name: "return", ctrl: true`, same `text: "\r"` | `ctrl+enter`, no text | partial |
| `\x1b\r` Alt+Enter | `name: "return", meta: true`, one event | `alt+enter` | **yes** |
| `0x7F` | `name: "backspace"` | `backspace` | **yes** |
| `0x0A` Ctrl+J | `name: "enter"`, `ctrl: false` | `ctrl+j` | **no** |
| `0x08` Ctrl+H | `name: "backspace"`, `ctrl: false` | `ctrl+h` | **no** |
| `\x1b[<0;10;5M` SGR mouse | `name: ""` from `parseKeypress`; `createInputParser` **emits the raw sequence as a text event** | a mouse event or nothing | **no** |
| `\x1b[13;2u` through `createInputParser` | **emitted as raw text** | a key event | **no** |
| `\x1b[200~…\x1b[201~` | one `{ paste }` event | one `PasteEvent` | **yes** |
| the same paste split across three chunks | one `{ paste }` event, emitted on the chunk that completes it | chunk-safe | **yes** |

Changes from the Ink 6 measurements transcribed in 05-INPUT §1, corrected here:

- Ink 7 **does** decode CSI-u in `parseKeypress` (Ink 6 gave literal `[13;2u`), but
  `createInputParser` still leaks the raw sequence as text, and the parsed key carries
  `text: "\r"`, so routing it through Ink would both fire the chord and insert a CR.
- Alt+Enter is now **one** event with `meta: true`, not two.
- `0x7F` is now `backspace`, not `delete`.

Unchanged and decisive:

- Ctrl+J is indistinguishable from LF unless raw `0x0A` is claimed before text handling.
- Ctrl+H is indistinguishable from Backspace for the same reason.
- SGR mouse reports reach text consumers, which would put them in the composer and in the
  secret buffer.

`useInput` stays forbidden. `classic/input/raw-decoder.ts` is the only stdin consumer.
Ink's paste parser being chunk-safe is a useful confirmation of the contract our own
paste decoder must meet, not a reason to use it.

---

## S6 — Bun compile import graph

**Verdict: the Windows binary bundles OpenTUI native code today. W15 must decide.**

`bun build --compile` resolves dynamic imports at build time. Without the platform
tarballs present it fails outright:

```
7979 |       return (await import("@opentui/core-win32-x64")).default;
error: Could not resolve: "@opentui/core-win32-x64".
```

which is exactly why `scripts/install-opentui-platforms.mjs` exists and must keep all
eight entries.

Probing the produced `release/clai-bun-windows-x64.exe` (113,004,032 bytes, 883 modules):

```
// node_modules/@opentui/core-win32-x64/index.bun.js
// node_modules/@opentui/core-win32-x64/opentui.dll
module.exports = "B:/~BUN/root/opentui-ttvz57kd.dll";
```

`opentui.dll` (3,786,120 bytes on disk) is embedded in the executable and reachable
through a Bun-root virtual path. Bundling is not initialization, so this is not yet a
failure — but it means the W15 Windows probe in 07-PLATFORM-PACKAGING §5 is a real gate
with a real chance of tripping, and the split-entrypoint fallback should be treated as
likely rather than remote. It is also the only lever available for the Windows binary's
size budget.

---

## S7 — Frame height control — historical scrollback-feed result

**Historical verdict: PASS for the then-planned normal-scrollback feed.** The measurements
below are preserved because they established the old Ink frame-height behavior, but their
`rows - 1` and no-alternate-screen conclusions are superseded by W17's full-height
`TerminalSession`-owned alternate screen.

A chrome tree built from a computed budget, captured at four terminal heights:

| rows | budget (tail/composer/status) | expected total | rendered rows | `total < rows` |
|---|---|---|---|---|
| 8 | 3 / 3 / 1 | 7 | 7 | yes |
| 12 | 7 / 3 / 1 | 11 | 11 | yes |
| 24 | 19 / 3 / 1 | 23 | 23 | yes |
| 50 | 45 / 3 / 1 | 49 | 49 | yes |

Ink's frame height was exactly the allocated row count at every size. No adjustment to the
historical budget was needed. These values describe the old `rows - 1` scrollback-feed
experiment; they are not the current row-budget golden values.

### Historical width finding

The widest rendered row was **80 columns at `columns = 80`** — a bordered `<Box>` with no
explicit width stretched to the full terminal width and therefore wrote into the final
cell, which 04-UI-SPEC §1 then forbade. The old rule was to give every bordered box
`width={columns - 2}` or place it in a parent that reserved the gutter.

### Current W17 contract

`TerminalSession` now owns `?1049h`/`?1049l`, clear/home, and teardown. The active allocator
starts with `budget = rows`, and W06 records totals 8, 12, 24, and 50 at the corresponding
terminal heights. The current width rule is not a raw `columns - 2` formula: the shared
`horizontalPadding()` / `innerShellWidth()` geometry is passed to every bounded surface, and
invariant tests assert that wrapped content stays inside that shell. The historical
no-alternate-screen and unbounded-box conclusions are therefore superseded, while the
measurement that an unbounded box can overflow remains useful regression context.
