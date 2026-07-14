# ADR-007 — Bun runtime validated; Phase 1 spike results

Status: accepted (with two items requiring interactive/OS validation)
Date: 2026-07-13
Relates to: ROADMAP V2-011..V2-016, RESEARCH.md mandatory spikes, ADR-001,
ADR-005.

## Context

Phase 1 requires technology and interaction spikes to prove OpenTUI can meet the
v2 requirements before feature work begins. The spikes must be measured and
recorded, and disposable spike code either promoted or deleted.

## Environment

- macOS 26.5.1, arm64 (Apple Silicon).
- Bun 1.3.14, Node 26.4.0.
- `@opentui/core` / `@opentui/react` / `@opentui/keymap` 0.4.3.
- Terminal: non-interactive (agent shell). No real TTY, mouse, or multi-emulator
  access; single OS/arch.

## Spike harness

OpenTUI ships a headless testing toolkit (`@opentui/core/testing`:
`createTestRenderer`, `mockMouse`, `mockKeys`, `ManualClock`, `captureCharFrame`,
`getNativeStats`). Spikes live in `scripts/v2-spikes/` and run under Bun via
`npm run spike`. They are intentionally excluded from the Node vitest suite
because OpenTUI's native FFI renderer loads under Bun, not Node's product
baseline. Native `getNativeStats` frame times are in microseconds.

## Results

### Runtime load (ADR-001 validation) — PASS

`import("@opentui/core")` under Bun succeeds and exposes the native renderer and
renderables (`CliRenderer`, `BoxRenderable`, `ScrollBoxRenderable`,
`MarkdownRenderable`, `CodeRenderable`, `DiffRenderable`, `EditBuffer`, ...). The
Zig renderer's prebuilt binary loads even though npm blocked native postinstall
scripts, i.e. OpenTUI ships prebuilt platform binaries rather than building on
install. A headless `TextRenderable` renders and is captured via
`captureCharFrame()`.

### V2-013 — 10,000-row viewport culling — PASS

- 10,000 rows attached; only the viewport renders.
- `cellsUpdated` on first render: 1920 vs 800,000 for full content (~0.24%),
  and far rows are absent from the frame → culling confirmed.
- Build (attach 10k rows): ~110 ms. First render (one-time yoga layout): ~167 ms.
- Steady-state scroll frame time: avg ~7.3 ms, max ~33 ms (the scroll-to-end
  jump forces one heavier rebuild). heapUsed ~36 MB, rss ~289 MB.
- Conclusion: viewport culling keeps per-frame work bounded to the viewport, not
  the content size.

### V2-014 — streaming Markdown / partial fences / tables — PASS

- Feeding markdown chunk-by-chunk with `streaming: true` never throws on
  unterminated code fences and never blanks the frame after content appears.
- Tables render progressively; headings, fenced code, and Unicode
  (café / 日本語 / ✅) all render.
- Text that merely looks like an ANSI escape (`\x1b[31m...`) renders literally;
  no raw `0x1b` byte reaches the buffer (control-byte sanitization holds).
- Frame time: avg ~1.4 ms, max ~5.8 ms across 8 chunks.

### V2-011 / V2-012 — pane-scoped selection + drag-edge autoscroll — BLOCKED (finding)

Under the headless test renderer, neither `mockMouse.drag` nor the direct
`renderer.startSelection`/`updateSelection` API produced any selected text
(length 0), and `ScrollBox.startAutoScroll`/`updateAutoScroll` driven by
`ManualClock` + `renderOnce` did not change `scrollTop`.

Interpretation: selection and drag-edge autoscroll are driven by OpenTUI's live
render/event loop, which the manual headless `renderOnce` path does not
reproduce with the wiring tried here. This does NOT prove the behavior is
impossible; it proves it cannot be validated with the current headless harness.

Consequences for ADR-005: pane-scoped selection and autoscroll must be validated
with an interactive or live-loop harness. The inability to trivially drive them
headlessly increases the likelihood that a custom clai selection coordinator
(pane-local selectable buffers + owned mouse capture) is required, as ADR-005
anticipated. Do not assume built-in selection satisfies SEL-002/003/006 until an
interactive spike shows a chat-scoped copy across the plan boundary.

### V2-015 — compiled binaries + terminal-emulator matrix — BLOCKED (needs dev machines)

`scripts/build.ts` already targets `bun build --compile` for macOS arm64/x64,
Linux arm64/x64, and Windows x64. Producing and running those binaries on each
OS, and validating the emulator matrix (Apple Terminal, iTerm2, Ghostty, Kitty,
WezTerm, Windows Terminal, VS Code terminal, tmux), cannot be done in this
single-OS, non-interactive environment. This must run on real developer/CI
machines.

## Decision

- ADR-001 (OpenTUI on Bun) is validated on macOS arm64 for load, culling, and
  streaming. Proceed with OpenTUI + the React adapter (ADR-006).
- Treat pane-scoped selection/autoscroll as an open risk requiring an
  interactive spike before Phase 6; plan for a custom selection coordinator.

## Disposable spike code

Per V2-016, `scripts/v2-spikes/` is disposable. It is retained for now because
it doubles as the seed of the v2 performance/interaction test harness (V2-013
and V2-014 assertions should be promoted into the Phase 5 transcript/perf tests).
Delete or promote before Phase 9 hardening; do not ship it in `dist`.

## Follow-ups

- Interactive/live-loop spike for pane-scoped selection + autoscroll (blocks the
  ADR-005 final decision and Phase 6).
- OS-matrix compiled-binary run and terminal-emulator matrix (V2-015) on real
  machines/CI.
