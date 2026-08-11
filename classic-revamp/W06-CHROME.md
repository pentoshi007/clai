# W06 — Chrome skeleton (record)

One pure function decides every chrome height. Nothing else may compute a row count.

## Files

| File | Owns |
|---|---|
| `src/classic/chrome/row-budget.ts` | `allocateChrome`, the nine-step allocator and its constants |
| `src/classic/chrome/Chrome.tsx` | placeholder sections rendered at exactly the allocated heights |
| `src/classic/chrome/use-terminal-size.ts` | debounced (80 ms) `resize` subscription through Ink's `useStdout` |
| `src/classic/app/ClassicApp.tsx` | now composes `useTerminalSize` → `allocateChrome` → `Chrome` |
| `test/classic/chrome/row-budget.test.ts` | property, monotonicity, cap, priority and golden-table tests |
| `test/classic/chrome/frame-height.test.ts` | captured Ink frame height equals `ChromeLayout.total` |

`use-terminal-size.ts` is one addition to the roadmap's file list: the allocator needs
`rows`, and `capabilities` is a bootstrap-time snapshot. It reads `stdout` from Ink's
`useStdout` rather than touching `process.stdout`, so the architecture guard stays intact.
Constants come from `ui-core/layout/compute-layout.ts` (`COMPOSER_MAX_HEIGHT = 18`) rather
than being re-declared.

## Golden table for rows 1–10

`composerTextRows = 40` (the composer asks for everything), no overlay, no plan, no queue,
`statusRowsWanted = 1`. The alternate-screen shell uses every available terminal row:

| rows | composer | status | liveTail | total | degraded |
|---|---|---|---|---|---|
| 1 | 1 | 0 | 0 | 1 | yes |
| 2 | 2 | 0 | 0 | 2 | yes |
| 3 | 3 | 0 | 0 | 3 | yes |
| 4 | 4 | 0 | 0 | 4 | yes |
| 5 | 5 | 0 | 0 | 5 | yes |
| 6 | 5 | 1 | 0 | 6 | yes |
| 7 | 5 | 1 | 1 | 7 | no |
| 8 | 5 | 1 | 2 | 8 | no |
| 9 | 5 | 1 | 3 | 9 | no |
| 10 | 5 | 1 | 4 | 10 | no |

## Full-height contract

`allocateChrome` starts with `budget = rows`, because `TerminalSession` owns the alternate
screen and there is no host-scrollback row to reserve. The composer therefore equals the
entire terminal at rows 1–5; at row 6 it leaves one status row; and from row 7 onward the
live tail receives the remaining rows. The lower chrome is anchored at the terminal bottom,
`ChromeLayout.total <= rows` is the active property, and there is no phantom blank row.

The current contract supersedes the earlier W00 `rows - 1` experiment. The row-budget and
frame-height tests are the authority; the worked examples in any older scrollback-feed
record are historical only.

## Verification

| Check | Result |
|---|---|
| `allocateChrome` property | Current contract is `total <= rows` for rows 1–200 across demand combinations; live-tail monotonicity remains covered |
| `frame-height.test.ts` | Captured Ink frame height equals `ChromeLayout.total` at rows 8/12/24/50 and may occupy the final terminal row |
| shell width and wrapping | Shared shell geometry bounds surfaces to `innerShellWidth(columns)`; content reflows instead of truncating at the boundary |
| manual resize walkthrough | Manual screenshot/host walkthrough evidence is unavailable; provider-independent macOS PTY evidence is tracked in [10-TESTING.md](10-TESTING.md) |

Property coverage: 5,000 random demands crossed with `rows` 1–200 for `total <= rows`;
300 demands × `rows` 1–60 for live-tail monotonicity.

## Findings that change later packages

1. **Ink emits `\x1b[2J` when the terminal shrinks, and only then.** Measured across the
   four resizes above: 0 clears on startup, 0 on grow, **2 on shrink**, 0 on re-grow. When
   the previously drawn frame is taller than the new terminal, Ink cannot erase it with
   relative cursor motion and falls back to a full clear plus a `<Static>` replay. This is
   the W00 S3 hazard reached through resize instead of through allocation, so W07 must
   measure committed-scrollback survival across a shrink with a real `<Static>` feed, and
   W17's "resize during a running turn" check must look for duplicated committed rows. Our
   own `clearScreen()` remains reachable only from `/clear`, `/new`, `/clean`.
2. **The composer is capped by `floor(rows * 0.4)` before the 18-row text cap**, so a
   maximally hungry composer only reaches 20 rows at 50 rows of terminal. W08 must derive
   the visible draft rows from `ChromeLayout.composer - 2`, never from the editor model's
   own preferred height.
3. **`degraded` is true far more often than expected on short terminals** — every size below
   7 rows. W09's status bar must have a one-row form that still shows mode and model, since
   at `rows <= 6` the status gets one row or none.
4. **Ink's frame height is exactly the number of `<Text>` rows we render**, with no implicit
   trailing newline, confirmed at rows 8/12/24/50 across six chrome shapes. W07 can rely on
   `lines.length` being the true rendered height, which is what the exact-height block
   invariant depends on.
