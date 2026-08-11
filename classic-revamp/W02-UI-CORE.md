# W02 — `src/ui-core` extraction record

Base commit: `4e5cd74` · Branch: `fix/classic-revamp`

## Result

`src/ui-core/` now holds every renderer-neutral piece of the interactive frontend.
`src/tui-v2/` retains only OpenTUI-coupled JSX, OpenTUI input adaptation, and
OpenTUI-specific styling wrappers. `src/tui/` no longer exists.

Guard: `test/ui-core/architecture.test.ts` fails the build if `src/ui-core`
imports `@opentui/*`, imports the `tui-v2`/`classic`/`noninteractive` trees,
imports `src/repl`, writes to the terminal directly, uses `react` outside
`src/ui-core/react/`, or introduces barrel `index.ts` files.

## Directory map

| Path | Contents |
| --- | --- |
| `ui-core/actions/` | action ids, router, keymap, mode cycle, shortcut formatting, chord primitives |
| `ui-core/controllers/` | focus, overlay, selection, toast |
| `ui-core/state/` | transcript store/reducer/hydrate/search/struct/compaction, pager search, semantic document, classic transcript |
| `ui-core/react/` | hooks (`use-*`) and `providers.tsx` |
| `ui-core/rendering/` | markdown, syntax highlight, code block, theme, tool presenter, status segments, context limit, pager source, `render-markdown-lines` |
| `ui-core/composer/` | draft actions, completion, history, paste placeholder, secret buffer, height/meta math |
| `ui-core/layout/`, `ui-core/motion/` | `compute-layout`, easing |
| `ui-core/bootstrap/` | capabilities, `can-use-tui`, lifecycle, console guard/suppress, composition root, overlay ports, ui selection |
| `ui-core/ports/` | `clipboard-osc52`, `pager-export-port` |
| `ui-core/commands/`, `ui-core/plan/` | command handlers, startup update, config/key/picker/session commands, plan lifecycle |

Files that left the UI tree entirely: `src/tui/runtime.ts` → `src/os/bun-runtime.ts`
(Bun executable discovery and re-exec are platform concerns, not UI concerns).

## `AnsiLine[]` seam

`ui-core/rendering/render-markdown-lines.ts` returns `AnsiLine[]` — plain strings
carrying SGR escapes. `StyledText` is an OpenTUI type and no longer crosses the
seam. `src/tui-v2/rendering/styled-markdown.ts` is the OpenTUI adapter: it owns
`styleAnsiLine`, `styleAnsiLines`, `renderStyledMarkdownLines`, and
`renderStyledStreamingMarkdown` (with the frame cache). Its four consumers are
`assistant-message.tsx`, `compacted-row.tsx`, `tool-card.tsx`, `pager-markdown.ts`.

### Before/after frame comparison

Rendered a fixture exercising headings, inline bold/code/link, bullets, a fenced
`ts` block, a GFM table, and a blockquote at width 80 through both sides of the
seam and compared the plain-text projections:

```
{ "lines": 18, "plainTextIdentical": true }

  Heading

  Some bold and code and a link(https://example.com).

  • item one
  • item two

  ╭─ typescript ─────────╮
  │ const x: number = 1; │
  ╰──────────────────────╯

  ┌───┬───┐
  │ a │ b │
  ├───┼───┤
  │ 1 │ 2 │
  └───┴───┘

  │ quoted line
```

`styleAnsiLines(renderMarkdownLines(...))` reproduces the neutral ANSI frame
chunk-for-chunk. Box drawing, table alignment, and wrap points are unchanged.

## Re-export shims

All temporary shims introduced during the moves are deleted. Consumers import
from the owning module directly:

- `status-line.tsx` no longer re-exports `status-segments` or `context-limit`;
  `jobs-panel.tsx` and the status tests import `ui-core/rendering/*` directly.
- `context-limit-chip.tsx` no longer re-exports chip formatting helpers.
- `pager-markdown.ts` no longer re-exports `pager-source` helpers;
  `pager.tsx` and `tool-card.tsx` import them from `ui-core/rendering/pager-source.js`.
- `toast-anim.ts` no longer re-exports easing from `ui-core/motion/ease.js`.

## Verification

| Check | Result |
| --- | --- |
| `npm run typecheck` | clean |
| `npx vitest run` (full) | 354 files / 2805 tests passed |
| `npx vitest run test/tui-v2 test/app test/ui-core test/os` | 100 files / 761 tests passed |
| `npm run test:bun` | 38 files / 256 tests passed |
| `npm run build` | clean |
| `npm run compile` | all four Bun targets bundled (835 modules each) |

The `/update` command-parity case recorded as flaky in `BASELINE.md` (real
network call) passed on both the Node and Bun runs.

### OpenTUI walkthrough

Driven headlessly through the W00 spike harness against the refactored tree:

- `shell-render` — 41/31/17 lines at wide/single/compact; no raw ESC byte leaked
  into any frame; renderer teardown clean.
- `streaming-markdown` — 8 chunks, avg 1.82 ms / max 8.38 ms per frame; table
  cells rendered; ANSI-looking payload shown literally rather than injected.
- `viewport-culling` — 1920 cells on first render, avg 6.17 ms / max 32.60 ms
  scroll frames, 25.7 MB heap; mid-scroll frame non-empty.

All three match their W00 baseline in `SPIKES.md`.

## Findings that change later packages

1. **`pager-export` is split, not moved.** The alt-screen exit write
   (`\x1b[?1049l`) is renderer-specific, so the policy lives in
   `ui-core/ports/pager-export-port.ts` (`RendererSuspendPort` now includes
   `writeScrollback`) and the OpenTUI adapter stays at
   `tui-v2/bootstrap/pager-export.ts`. W04 must supply an Ink adapter built on
   `useApp().suspendTerminal()` rather than writing the sequence itself.
2. **Chord normalization is split from key decoding.** `ui-core/actions/chord.ts`
   holds `normalizeChord`/`chordFrom`; the OpenTUI `KeyEvent` shape stays in
   `tui-v2/input/chord-from-opentui-key.ts`. W05 writes a sibling
   `classic/input/chord-from-key.ts` over the same primitives — the mapping table
   must be validated against both adapters.
3. **The seam is ANSI strings, not styled objects.** W06 onward must convert
   `AnsiLine[]` at the Ink boundary; Ink renders ANSI in `Text` children directly,
   so no equivalent of `styled-markdown.ts` is expected on the classic side.
4. **`can-use-tui` is now frontend-neutral.** W03 can reuse `evaluateTui` for the
   classic gate without duplicating the min-size constants.
