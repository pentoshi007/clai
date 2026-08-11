# W08 — Composer (record)

Branch `fix/classic-revamp`. Baseline before the package: full suite green except the
known `test/tui-v2/app/command-parity.test.ts > /update checks the updates port without
throwing` load-dependent timeout recorded in [W07-FEED.md](W07-FEED.md) finding 9.

## File map

| File | Owns |
| --- | --- |
| `src/classic/chrome/editor-model.ts` | Grapheme-aware text + cursor state. Pure. |
| `src/classic/chrome/editor-view.ts` | Wrap-to-visual-rows, caret location, scroll window, inverse-cell caret row. Pure. |
| `src/classic/chrome/composer-keys.ts` | The chord → edit table for keys the router does not claim. |
| `src/classic/chrome/composer-frame.ts` | Width, text rows, border style, placeholder, mark. Pure. |
| `src/classic/chrome/Composer.tsx` | Ink box: border via Yoga, pre-measured ANSI inside. |
| `src/classic/chrome/composer-controller.ts` | The one stateful owner: draft, completion menu, prompt history, paste registry, arrow burst. |
| `src/classic/panels/panel-frame.ts` | Panel border rows with title and hints inside the border. Pure. |
| `src/classic/panels/PanelFrame.tsx` | Renders exactly the allocated row count. |
| `src/classic/panels/list-window.ts` | Active-row windowing with a one-row margin, and the `n/m` counter. Pure. |
| `src/classic/panels/completion-rows.ts` | Slash and mention row rendering, row-count policy, image and dir tags. Pure. |
| `src/classic/panels/completion-accept.ts` | Tab/Enter acceptance: command insert, dir drill vs attach, file reference. Pure. |
| `src/classic/panels/CompletionPanel.tsx` | `completionView` → `PanelFrame`. |

Edited: `src/classic/render/glyphs.ts` gained `tab` and `enter` glyphs for panel hint rows.

## Reuse from `ui-core/composer`

No new policy was written. `completion.ts` (`resolveCompletionMenu`, `sameCompletionMenu`),
`composer-height.ts` (`countComposerVisualLines`, `resolveComposerTextRows`),
`draft-actions.ts` (`cutDraft`, `cutDraftMessage`), `input-history.ts`,
`paste-placeholder.ts` (`PasteRegistry`, `isLargePaste`), `prompt-history.ts`,
`arrow-intent.ts`, and `rendering/picker-filter.ts` are consumed unchanged.
`ui/mentions.ts` supplies suggestions and `formatAttachmentReference`.

`composerActionPort` was deliberately not used: `ComposerController` is a constructed
owner with injected dependencies, which is the pattern 00-AI-EXECUTION asks for.

## Chord ownership

The router resolves first, so the composer only sees what `defaultKeymap` leaves free.

| Chord | Owner | Effect |
| --- | --- | --- |
| `enter` | keymap → `editor.submit` | accept completion if a menu is open and unaccepted, else submit |
| `shift+enter`, `alt+enter` | keymap → `editor.newline` | insert `\n` |
| `up`, `down` | keymap → `editor.history-*` | `resolveArrowIntent`: menu move, visual line move, history walk, or chat scroll |
| `ctrl+x` | keymap → `editor.clear` | clear draft, toast; no-op on an empty draft |
| `ctrl+shift+x` | keymap → `editor.cut-draft` | copy expanded draft, clear, toast |
| `tab` | router sends composer keys to the panel | complete common prefix, then accept |
| `escape` | panel first | dismiss the menu, draft untouched |
| `left`/`right`/`home`/`end`/`backspace`/`delete` | composer | caret and delete |
| `alt+left/right`, `ctrl+left/right`, `alt+b/f` | composer | word motion |
| `ctrl+a`/`ctrl+e`, `ctrl+home`/`ctrl+end` | composer | line and buffer anchors |
| `ctrl+w`, `alt+backspace`, `alt+d`, `alt+delete` | composer | word delete |
| `ctrl+u` | composer | delete to line start; on an empty draft, jump the transcript to the top |
| `ctrl+k` | composer | delete to line end |
| `shift+up`/`shift+down` | composer | move one wrapped row, keeping the column |
| `ctrl+c`, `ctrl+d`, `ctrl+h`, `ctrl+j`, `shift+tab` | keymap (global) | never reach the composer; `composer-keys.ts` deliberately omits them |

## Verification

| Command | Outcome |
| --- | --- |
| `npm run typecheck` | clean |
| `npx vitest run test/classic/composer` | 86 passed (4 files) |
| `npx vitest run test/classic` | 509 passed, 10 skipped (26 files) |
| `npx vitest run` | 3330 passed, 10 skipped, 1 failed — the known `/update` load-timeout; passes in isolation (19/19) |

## Findings for later packages

1. **The manual gate cannot run in W08.** Nothing routes decoded input into
   `ComposerController` until W11 wires `InputRouter` into `ClassicApp`. The composer,
   the completion panel, and the controller are unit-verified; the wrap / Shift+Enter /
   500-line paste / `@`-mention / history / Ctrl+X / Ctrl+Shift+X / resize walkthrough
   moves to the W11 manual gate. This is the only unchecked W08 box.

2. **W10 inherits three modules from this package.** `panel-frame.ts`, `PanelFrame.tsx`,
   and `list-window.ts` were written here because the completion menu needs them. Every
   W10 panel should consume them rather than re-deriving a border or a scroll window; the
   panel frame already guarantees `columns - 2` width and exactly `rows` rows.

3. **`formatAttachmentReference` always yields a `file://` URL.** Accepting a mention
   inserts an absolute URL, not the relative path shown in the menu — matching OpenTUI.
   `acceptCompletion` takes an explicit `baseDir` so the resolution does not depend on
   `process.cwd()`; W11 must pass the session's base directory.

4. **`acceptedSlash` gates the double-Enter.** The first Enter on an open slash menu
   accepts the command, the second submits. The controller invalidates `acceptedSlash` as
   soon as the draft stops starting with the accepted token, so editing after acceptance
   re-arms acceptance instead of submitting a stale command.

5. **Arrow bursts need a monotonic clock.** `ComposerController` takes an injectable
   `now`; without advancing it between presses, four deliberate history presses look like
   a trackpad burst and become a chat scroll. W11 should pass the same clock the tick
   loop uses so tests and runtime agree.

6. **`layoutEditor` is the only wrapper that tracks source offsets.**
   `render/wrap.ts` returns rows only, which is enough for the feed but not for caret
   placement. The two wrappers use the same greedy word-break rule; if one changes, both
   must. `test/classic/composer/editor-model.test.ts` pins the shared cases.

7. **The caret is drawn, not delivered.** The terminal cursor stays hidden; the caret is
   an inverse cell inside a pre-measured row, and a caret at end of line adds one column.
   Any surface that measures a composer row must measure the rendered row, not the draft.

## Deviations

None. D-09 through D-12 remain open from W05-W07 and are still unsigned.
