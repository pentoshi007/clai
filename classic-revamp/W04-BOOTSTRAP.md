# W04 — Ink bootstrap and lifecycle (record)

An empty but correctly-living Ink frontend: it takes the terminal, renders one status row,
and gives the terminal back exactly once on every exit path.

## Files

| File | Owns |
|---|---|
| `src/classic/bootstrap/terminal-session.ts` | the only control-byte writer: bracketed paste, cursor visibility, optional mouse, raw mode, `clearScreen`, scrollback writes |
| `src/classic/bootstrap/suspend-port.ts` | `RendererSuspendPort` over unmount → release terminal → write → re-enter → remount |
| `src/classic/bootstrap/osc52-renderer.ts` | `Osc52RendererPort`, with tmux/screen DCS passthrough |
| `src/classic/bootstrap/renderer-handle.ts` | `RendererHandle` (`start`/`destroy`) + the `done` promise, free of composition-root imports so lifecycle is testable with fakes |
| `src/classic/bootstrap/start-classic.tsx` | composition root, `attachCommandHandlers`, console guard, `RendererLifecycle` with the three disposers, Ink `render` options, exit-key reader |
| `src/classic/app/ClassicApp.tsx` | the minimal shell: one status row |
| `test/classic/architecture.test.ts` | boundary guards for the whole `src/classic` tree |
| `test/classic/lifecycle.test.ts` | the six exit paths with fake streams |
| `test/classic/terminal-session.test.ts` | sequence order, idempotency, suspend port, OSC 52 |
| `test/classic/classic-app.test.ts` | status row content and width, via `ink-testing-library` |

`renderer-handle.ts` is the one addition to the file list in
[02-ARCHITECTURE.md](02-ARCHITECTURE.md). Extracted because `test/classic/lifecycle.test.ts`
must drive the real handle with fake streams; importing `start-classic.tsx` would pull the
agent, store, and tool adapters into a lifecycle unit test. Ownership and dependency
direction are unchanged.

## Screen ownership, as emitted

Captured from a PTY running `node dist/index.js --classic --mode ask` at 100×30:

```
\x1b[?2004h \x1b[?25l                        enter
\x1b[?2026h \x1b[?25l …status row… \x1b[?2026l  Ink frame (synchronized output)
\x1b[?25h \x1b[?25h \x1b[?25h                 Ink teardown
\x1b[?2004l \x1b[?25h                        leave
```

No `\x1b[?1049`, no `\x1b[2J` anywhere in the session — `clearScreen()` exists but is
only reachable from `/clear`, `/new`, `/clean` in W11. `alternateScreen: false` and
`concurrent: false` are passed explicitly to `render` so a future Ink default cannot flip
them.

## Exit paths

| Path | Result | Evidence |
|---|---|---|
| Ctrl+D | exit 0 | PTY run: `EXIT=0`, cursor and paste restored |
| Ctrl+C once | keeps running, notice only | PTY run: still alive after 12 s |
| Ctrl+C twice | exit 130 | PTY run: `EXIT=130` |
| SIGINT ×1 / ×2 | cooperative, then 130 | `lifecycle.test.ts` |
| SIGTERM | 143 | `lifecycle.test.ts` |
| SIGHUP | 129 | `lifecycle.test.ts` |
| `uncaughtException` / `unhandledRejection` | 1 | `lifecycle.test.ts` |
| mount throws | rethrown after full teardown | `lifecycle.test.ts` |

Every path asserts: `CURSOR_SHOW` written exactly once, `BRACKETED_PASTE_OFF` exactly
once, one unmount, one `services.dispose()`, and disposers run in reverse order
(`close-sessions`, `restore-console`, `persist`).

## Verification

| Command | Result |
|---|---|
| `npx vitest run test/classic` | 7 files / 52 tests passed |
| `npx vitest run test/classic test/ui-core test/tui-v2 test/app` | 105 files / 830 tests passed |
| `npx vitest run` | 359 files / 2874 tests passed |
| `npm run typecheck` | clean |
| `npm run build` | clean |
| `npm run test:bun` | 38 files / 257 tests passed |
| `npm run compile` | 5 targets, 1353–1355 modules each |
| PTY manual walkthrough | status row shown, three exit paths above, terminal usable after |

## Findings that change later packages

1. **Ink does not keep the process alive.** A mounted Ink app with no `useInput` and no raw
   mode holds no libuv handle; Node exited in 81 ms in a spike. The process stays alive only
   because `terminal-session.attachInput()` resumes stdin. `start()` must therefore always
   attach input, and W05's `input-router` replaces the placeholder exit-key reader in
   `start-classic.tsx` rather than adding a second attachment point.
2. **`process.stdout.columns` can be 0** on a freshly forked PTY before `TIOCSWINSZ`. That
   flowed into `clipSegment` and collapsed the status row to `…`. `detectCapabilities` now
   treats a non-positive `columns`/`rows` as absent and falls back to 80×24. W06's row
   budget can assume `rows >= 1`, and both renderers benefit.
3. **`ui-core/react/providers.tsx` no longer pins `@jsxImportSource @opentui/react`.** It
   only renders a React context provider, so the workspace `react-jsx` runtime is correct
   and both renderers can consume it. This was the last blocker to sharing the providers;
   `test/tui-v2` is unchanged and green.
4. **The Bun bundle grows from 837 to ~1354 modules** now that Ink, React, and Yoga are in
   the graph of `src/index.ts`'s dynamic import. Binaries are 75–127 MB. W15 records the
   size delta and decides whether the Windows split entrypoint is still needed.
5. **`Instance.cleanup()` is required before remounting on the same stdout.** Ink 7 refuses
   to reuse a stdout across `render()` calls otherwise, so `suspend-port.ts` calls
   `unmount()` then `cleanup()`; W10's pager export depends on this.
