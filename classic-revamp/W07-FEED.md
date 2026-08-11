# W07 — Feed

Model B is now real: committed blocks go to the terminal's own scrollback through a single
`<Static>`, and a bounded live tail is the only feed content Ink repaints.

## File map

### `src/classic/render` — presentation primitives

| File | Responsibility |
|---|---|
| `glyphs.ts` | Frozen Unicode and ASCII glyph records plus `toAsciiGlyphs`, which downgrades glyphs that shared `ui-core` presenters always emit in Unicode. |
| `ink-theme.ts` | `createInkTheme` → a pinned `Chalk` instance at the level implied by `colorMode`, token accessors, `inkColor` for Ink props, and `withColorMode` for shared renderers that colour through the ambient chalk singleton. |
| `measure.ts` | `layoutWidth` (conservative, reuses `ui-core`'s `renderColumns`), `displayWidth` (what a terminal paints), `contentWidth = columns - 2`. |
| `ansi-text.ts` | `tokenize`, `sealStyle`, `clipToWidth`, `padToWidth`, `padStartToWidth`, `alignEnds`, `trimTrailingSpaces`, grapheme segmentation. Every clip is ANSI-aware and grapheme-aligned. |
| `wrap.ts` | `wrapAnsiLine` (word break, hard-break fallback, style re-opened on continuations), `wrapWithPrefixes`, `reflowRows`. Yoga never wraps feed text. |

### `src/classic/blocks` — one builder plus one component per kind

`<kind>-lines.ts` is pure and returns exact-height ANSI rows; `<Kind>Block.tsx` renders
those rows and gives W11 a per-kind seam for expand/collapse and prompt actions. All
styling lives in the strings, so the golden fixtures cover appearance completely and
§12.4 (no severed SGR) is enforced on exactly the bytes that reach the terminal.

`block-context.ts` carries `{ width, ink, glyphs, now, state, spool, markdownCache }`.
`now` is injected, so no builder reads a clock.

### `src/classic/feed`

| File | Responsibility |
|---|---|
| `feed-blocks.ts` | `buildFeedBlocks(state, view)`, `toolBlockKind`, `MAX_BLOCK_ROWS = 400` bounding, quiet-meta-tool hiding, generation-prefixed keys. |
| `block-height.ts` | `blockHeight`, `totalHeight`, `trailingBlocksWithin`, `BLOCK_GAP_ROWS = 1`. |
| `commit-ledger.ts` | `decideCommit` — the four rules. |
| `live-tail-policy.ts` | `boundOpenBlock` — per-kind bounded form for an open block that does not fit. |
| `Feed.tsx` | `BlockRows` (the single row primitive, `wrap="truncate-end"`) and the `BlockKind → component` dispatch. |
| `FeedStatic.tsx` | The only `<Static>` in the product. One trailing blank row per item supplies the inter-block gap. |
| `LiveTail.tsx` | `planLiveTail` (pure) and the bottom-anchored fixed-height region. |

### Integration

`src/classic/app/use-feed.ts` holds the ledger's monotonic cursor in a ref and resets it
when the generation changes. `ClassicApp.tsx` composes `FeedStatic` above `Chrome`, and
`Chrome.tsx` gained a slot mechanism so a real component can replace a placeholder section.

## Golden matrix

`test/classic/feed/feed-blocks.test.ts` snapshots the scripted turn (intro, user prompt,
thinking, assistant markdown, three tools — ok / failed exit 127 / blocked — a file diff, a
running batch, a compaction) across 7 widths × 2 colour modes × 2 glyph tables = 28
fixtures.

Widths 40 / 48 / 68 / 80 / 96 / 120 / 200. Colour modes `truecolor` and `none`.

## Verification

| Gate | Command | Result |
|---|---|---|
| Golden fixtures | `npx vitest run test/classic/feed/feed-blocks.test.ts` | 28 snapshots + 13 assertions green |
| Commit ledger, four rules isolated | `npx vitest run test/classic/feed/commit-ledger.test.ts` | 12 green |
| §12 invariants 1–6 | `npx vitest run test/classic/feed/invariants.test.ts` | 8 green, incl. a 2,000-run `fast-check` property for §12.1 |
| Scripted turn through Ink at 80 and 44 columns | `npx vitest run test/classic/feed/frame-render.test.ts` | 12 green |
| Render primitives | `npx vitest run test/classic/render` | 24 green |
| Boundaries | `npx vitest run test/classic/architecture.test.ts` | 12 green (4 new rules) |
| Whole classic surface | `npx vitest run test/classic` | 411 passed, 10 skipped |
| Types | `npm run typecheck` | clean |
| Full suite | `npx vitest run` | 3244 passed, 10 skipped |

The manual gate ("no duplicated, missing, or overflowing row") is enforced mechanically in
`frame-render.test.ts`: committed rows are matched against the captured Ink frame in order
and by occurrence count, so a duplicate or a dropped row fails the build. That is strictly
stronger than an eyeball check, and it runs on every commit.

### Structural notes

- `FeedViewInput` carries `{ columns, ink, now, spool, generation, intro, markdownCaches }`
  rather than 03-RENDER-MODEL §4's `{ …, expandThinking, expandOutput, expandFileDiffs,
  itemOverrides, fileDiffOverrides }`. Those five already live on `TranscriptState`, and
  `isItemExpanded` / `isFileDiffExpanded` are the shared predicates that resolve them.
  Duplicating them into the view input would have created a second source of truth for
  expansion, which 04-UI-SPEC forbids elsewhere ("reuse; do not re-derive").
- The nine block components are thin because all styling is in `FeedBlock.lines`. That is
  the direct consequence of §4's exact-height contract: the ledger, the allocator, and the
  invariant tests all measure `lines`, so anything expressed only as an Ink prop would be
  invisible to them.

### Two deviations, logged as D-11 and D-12

Both are in [12-TASKS.md](12-TASKS.md); neither invents behaviour.

## Findings that change later packages

1. **`presentTool().statusLabel` already contains the non-zero exit code**, formatted as
   `failed · 127 · not found`. W09's activity row must not append the exit code a second
   time — the first draft of the tool header did and produced
   `failed · 127 · not found · 127 · 0.8s`.
2. **Shared `ui-core` renderers colour through the ambient chalk singleton.** `markdown.ts`,
   `code-block.ts`, `wordmark.ts`, and `intro-header.ts` all read `chalk.level`, which is
   detected from the host process and is therefore `0` under vitest and `3` on a real
   terminal. Any classic surface that calls one of them must wrap the call in
   `withColorMode(ink.colorMode, …)` or its output will differ between test and runtime.
   W08 (composer paste chips), W09 (status segments), and W10 (pager markdown, plan view)
   all touch such renderers.
3. **`renderIntroHeaderLines` forces truecolor internally** and does not honour
   `colorMode`. Classic strips ANSI from its output at `colorMode: "none"`. W10's pager and
   W09's status bar should assume the same is true of any other `ui-core` renderer that
   saves and restores `chalk.level`.
4. **A row's layout width can exceed its display width.** `layoutWidth` reserves
   `max(wcwidth, UTF-16 length)` for complex scripts, so a Devanagari or ZWJ-emoji row wraps
   a column or two early. W08's composer must budget with `layoutWidth` and assert with
   `displayWidth`, in that order, or the caret column will drift on such rows.
5. **The wash must be dropped below 256 colours.** `diff-lines.ts` pads a row to the code
   budget only when a background wash is actually painted; at `16` and `none` the marker
   column is the only differentiator. W10's pager diff bodies need the same rule.
6. **`Chrome.tsx` now takes slots.** W08–W10 replace the `composer`, `status`, `toast`,
   `queue`, `responder`, `plan`, and `overlay` placeholders through `slots`, and each
   component is responsible for rendering exactly `layout[section]` rows — the allocator's
   number is the contract, not a suggestion.
7. **`decideCommit` commits everything when the newest closed block does not fit.** That is
   deliberate: the terminal, not the renderer, scrolls oversized content. W11's turn-end
   handler should therefore expect `live` to be empty immediately after a very tall tool
   result closes, and must not treat that as an error state.
8. **The intro card is a synthetic block with `itemId: "intro"` and `sequence: -1`.** W11's
   `/clean` handler re-emits it by bumping the generation, which resets the ledger cursor in
   `use-feed.ts`. Any code that maps blocks back to transcript items must skip it.
9. **`test/tui-v2/app/command-parity.test.ts > /update …` and
   `test/classic/input/raw-decoder.fuzz.test.ts` are both load-sensitive.** Each passes
   comfortably in isolation and can exceed vitest's 5 s default when the whole suite
   competes for cores. The fuzz test now carries an explicit 60 s budget; the tui-v2 one is
   untouched and should be given the same treatment if it flakes again.
