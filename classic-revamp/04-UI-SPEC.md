# UI Specification

Normative for layout and visuals. Where this file and any other disagree about appearance,
this file wins. Where it disagrees about data flow, [02-ARCHITECTURE.md](02-ARCHITECTURE.md)
and [03-RENDER-MODEL.md](03-RENDER-MODEL.md) win.

Reference points: Claude Code and Codex CLI for the feed and chrome shape; clai's own
OpenTUI frontend for identity, glyphs, and information content.

## 1. Design tokens

Colours come from `ui-core/rendering/theme.ts`. Never write a raw hex in a component.
`themeFor(hint)` already resolves dark/light from `capabilities.themeHint`.

Tokens used by classic, with their dark values:

| Token | Hex | Used for |
|---|---|---|
| `inputBorder` | `#2EEBFF` | composer frame, panel frames, intro card frame, `❯` mark |
| `border` | `#22D3EE` | completion menu frame, secondary rules |
| `magenta` | `#FF55FF` | assistant bullet `◆`, wordmark accent |
| `response` | `#4ADE80` | assistant body text |
| `thinking` | `#A78BFA` | reasoning text and its gutter |
| `prompt` | `#B45309` | ` YOU ` plate background |
| `userBorder` | `#f5b351` | user rail `▌` |
| `cyan` | `#67E8F9` | tool names, command labels |
| `toolOutput` | `#7DD3FC` | tool output body |
| `muted` | `#94A3B8` | args, previews, gutters, hints, rules |
| `activity` | `#FACC15` | running labels, warn text |
| `spinner` | `#E879F9` | spinner glyph |
| `success` / `diffAdd` | `#4ADE80` | ✓, `+` diff rows |
| `diffDel` | `#F87171` | ✗, `−` diff rows |
| `diffAddBg` / `diffDelBg` | `#12261a` / `#2a1414` | diff row wash |
| `diffGutter` | `#64748B` | diff line numbers |
| `selection` | `#2563EB` | active picker row |
| `rowA` / `rowB` | `#1E293B` / `#0F172A` | picker zebra |
| `chip` | `#334155` | neutral badge plate |
| `mode` | `#B45309` | mode badge plate |
| `statusBackground` | `#11151c` | panel fill |
| `syn*` | see theme | diff and pager syntax colours |

`background` is **not** applied to the frame. The feed model leaves the terminal's own
background alone; only panel fills and badge plates paint a background. This keeps native
selection legible and avoids a mismatched wash at the right edge.

### Colour degradation

`classic/render/ink-theme.ts` maps a token to an Ink colour prop given
`capabilities.colorMode`:

| `colorMode` | Behaviour |
|---|---|
| `truecolor` | hex passed through |
| `256` | nearest xterm-256 index from a static table |
| `16` | nearest basic name (`cyan`, `green`, `red`, `yellow`, `magenta`, `gray`, `white`) |
| `none` | no colour at all; differentiation falls to glyphs and `bold`/`dim` |

`NO_COLOR` already forces `none` in `capabilities.ts`. Every golden fixture is captured at
`truecolor` and at `none`.

### Glyphs

`classic/render/glyphs.ts` exports one frozen record per mode, selected by
`capabilities.unicode`:

| Meaning | Unicode | ASCII |
|---|---|---|
| prompt mark | `❯` | `>` |
| user rail | `▌` | `|` |
| assistant bullet | `◆` | `*` |
| thinking gutter | `│` | `:` |
| tool queued / running | `○` / `●` | `o` / `*` |
| tool ok / failed / blocked | `✓` / `✗` / `⊘` | `v` / `x` / `#` |
| body branch | `└` | `\` |
| ellipsis | `…` | `...` |
| rule | `─` | `-` |
| round box | `╭ ╮ ╰ ╯ │` | `+ + + + |` |
| task pending / active / done / failed / skipped | `○` `◉` `✓` `✗` `–` | `o` `*` `v` `x` `-` |
| progress filled / empty | `█` / `░` | `#` / `.` |
| warning | `⚠` | `!` |
| scroll up / down badge | `▲` / `▼` | `^` / `v` |
| spinner | `⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏` | `- \ | /` |
| separator | `·` | `-` |

Tool glyphs and task glyphs are already defined in `ui-core/rendering/tool-presenter.ts`
(`STATUS_GLYPH`) and `ui-core/rendering/plan-view.ts` (`TASK_GLYPH`). Classic reads them
from there and substitutes ASCII through `glyphs.ts` when `unicode` is false — it does not
redefine them.

Unicode detection: `capabilities.unicode` is false on Windows unless `WT_SESSION`,
`ConEmuANSI=ON`, or `TERM_PROGRAM` is present. That is the legacy-conhost path and it must
stay readable.

### Spacing

- Exactly one blank row between committed blocks. Zero blank rows inside a block.
- Zero blank rows anywhere in the chrome block.
- Body indent is 2 columns. Nested (batch sub-card, diff hunk) indent is 4.
- The terminal-wide root computes `shellPadding = horizontalPadding(terminalColumns)` and
  `shellWidth = innerShellWidth(terminalColumns)`. Every feed, chrome, composer, panel,
  status, directory, and branch surface receives `shellWidth`; no child subtracts an
  additional raw-terminal gutter. Every content row is wrapped or otherwise bounded before
  it reaches Ink.

## 2. Region map

```
┌ owned alternate-screen shell ───────────────────────────────────────┐
│  intro card                                                          │
│                                                                      │
│  ▌ YOU  add pagination to the users endpoint                         │
│                                                                      │
│  ◆ I'll read the route handler first.                                │
│                                                                      │
│  ✓ read_files(src/routes/users.ts)                                   │
│    └ 142 lines                                                       │
└──────────────────────────────────────────────────────────────────────┘
├ re-rendered live/chrome regions ────────────────────────────────────┤
│  ● shell.exec(npm test -- --run)                      running · 7s   │  live tail
│    └ PASS src/routes/users.test.ts                                   │
│    … +18 lines · ^O                                                  │
│                                                                      │
│ ╭ Tasks ─────────────────────────────────────────────────────────╮   │  plan panel
│ │ ▓▓▓▓▓░░░  3/8                                                  │   │
│ │ ✓ Read the route handler                                       │   │
│ │ ◉ Add limit/offset to the query layer                          │   │
│ ╰────────────────────────────────────────────────────────────────╯   │
│                                                                      │
│  ⚠ 2 prompts queued · ^⌥↑↓ select · ^⌥⏎ send now · ^⌥E edit          │  queue
│  ⠋ generating response · 12s · esc to cancel                         │  toast/activity
│ ╭──────────────────────────────────────────────────────────────────╮ │  composer
│ │ ❯ Ask anything...                                                │ │
│ ╰──────────────────────────────────────────────────────────────────╯ │
│  AGENT · groq/kimi-k2 · ctx 24.1k/128k · ~/dev/clai (main)            │  status 1
│  ^G help · ^T thinking · ^O output · ^H tasks · ⇧⇥ mode              │  status 2
└──────────────────────────────────────────────────────────────────────┘
```

Vertical order inside the owned shell is fixed and nothing inserts between regions:
live tail → plan → overlay panel → queue → responder → toast → composer/directory → status.
Row counts come from `allocateChrome`, which may use every terminal row.

Horizontal rule: all surfaces share the same left and right shell margins and wrap to
`shellWidth`. The only right-aligned elements are tool/status suffixes, panel counters,
and context/scroll badges. Centering is used only inside the intro card.

## 3. Committed blocks

### 3.1 Intro card

Reuse `renderIntroHeaderLines({ width, version, mode, provider, model, permissions,
workdir, variant })` from `ui-core/rendering/intro-header.ts` verbatim. It already produces
the two-partition aqua card with the gradient CLAI wordmark, the workdir/model/provider/
version chips, the `MODE` plate, the permission plate, the tagline, and the welcome line,
and it already reflows to a stacked compact card below its side-by-side threshold.

Placement: the first `<Static>` item of the session. Emitted again by `/clean`. Rendered as
one `<Text>` per returned line — the strings are already ANSI, so nothing else is needed.

This is where clai's identity lives. Do not restyle it.

### 3.2 User block

```
▌ YOU  add pagination to the users endpoint and return metadata
▌      in the response body
```

- Rail `▌` in `userBorder`, column 1.
- ` YOU ` plate: `prompt` background, white bold, one leading and trailing space.
- Two spaces after the plate, then the prompt in `foreground`.
- Wrap with `wrapUserPrompt` from `ui-core/rendering/user-message-wrap.ts`
  (`USER_MESSAGE_CHROME_COLS = 10`). Continuation rows repeat the rail and pad to the text
  column.
- Collapse past 6 rows to the first 5 plus `… +N lines` in `muted`; `Enter` while it is
  still live, or the `/output`-style prompt-actions panel, shows the rest.
- No bordered bubble. A rail cannot bow, a border can.

### 3.3 Assistant block

```
◆ I'll read the route handler first, then add the query parameters.

  The change touches three files:

  1. `src/db/users.ts` — add limit and offset
```

- `◆ ` in `magenta` on the first row only. Continuation rows indent 2.
- Body in `response`. Markdown comes from
  `renderStreamingMarkdown` / `renderMarkdownLines` (`AnsiLine[]` after the W02 seam
  change) at the bounded block width supplied by the classic shell. Prefixes and gutters are
  included in each block's local wrapping budget; no renderer clips prose at the terminal
  edge.
- While streaming, the first row reads `◆ ` plus the text; a dim `…` is appended to the
  final visible row. No label text, no "Response" header — Claude Code does not have one and
  the bullet already identifies the speaker.
- Inline code renders green through the existing markdown pipeline. Fenced blocks get a
  `│ ` gutter in `muted` and syntax colours from `ui-core/rendering/syntax-highlight.ts`.

### 3.4 Thinking block

Collapsed (default, `expandThinkingGlobal === false`):

```
│ thinking · 240 tokens · ^T
```

Streaming (always visible regardless of the toggle):

```
│ considering the pagination contract
│ the route currently returns a bare array, so adding
```

Expanded and closed:

```
│ thinking · 240 tokens
│ considering the pagination contract …
```

- Gutter `│ ` and body both in `thinking`, dim, italic when `capabilities` allows italic.
- Live tail bounded by `liveThinkingDisplay` from `ui-core/rendering/thinking-tail.ts`.
- Token count from the item content length, not a re-tokenization.

### 3.5 Tool block

```
● shell.exec(npm test -- --run)                             running · 7s
  └ PASS src/routes/users.test.ts
    PASS src/db/users.test.ts
  … +18 lines · ^O
```

Completed:

```
✓ shell.exec(npm test -- --run)                                done · 2.4s
  └ Tests: 42 passed, 42 total
```

Failed:

```
✗ shell.exec(npm run build)                                failed · 127 · 1.1s
  └ sh: tsc: command not found
```

Blocked:

```
⊘ fs.delete(/etc/hosts)                                            blocked
  └ path outside the authorized workspace
```

- Glyph from `STATUS_GLYPH` in `tool-presenter.ts`, coloured: queued `muted`, running
  `activity`, ok `success`, failed `diffDel`, blocked `activity`.
- Tool name in `cyan` bold. Args in `muted`, inside `(…)`. `clampArgsDisplay` limits the
  preview to three logical rows / 200 characters per row; each resulting row is then wrapped
  to the remaining shell width. That preview cap is intentional, but a line that reaches a
  boundary is wrapped rather than discarded.
- Right-aligned suffix: `statusLabel` from `STATUS_LABEL`, then exit code when non-zero,
  then elapsed. Dropped entirely below 68 columns.
- Body: `└ ` on the first row, 4-space indent after, `toolOutput` colour. Collapsed preview
  is 3 rows; expanded is up to 40; full output is always in the pager and on disk.
- Trailer `… +N lines · ^O` in `muted`. When an artifact path exists, append
  ` · saved` and put the path in the pager header rather than the card.
- No border. Borders on a per-tool card are the single largest source of width bugs and
  Claude Code does not use them.

### 3.6 Batch block

```
● tool.batch(4 tools)                                       running · 3s
  ✓ fs.read(src/a.ts)
  ● shell.exec(npm ls)                                        running
  ○ fs.read(src/b.ts)
  ○ fs.read(src/c.ts)
```

Sub-rows come from `parseBatchSections` / `presentBatchSection` /
`buildBatchCardsFromSpool` in `ui-core/rendering/batch-sections.ts`. One row per sub-tool
at indent 2, glyph plus name plus a bounded preview of args. Expanded state adds each
completed sub-tool's 1-row summary at indent 4. `batchSummaryLine` supplies the footer;
content inside a selected preview wraps to the shell width.

### 3.7 Diff block

```
✓ Edited src/routes/users.ts                                  +22 −20
   18   export async function listUsers(req, res) {
   19 −   const rows = await db.users.findMany();
   19 +   const { limit = 25, offset = 0 } = req.query;
   20 +   const rows = await db.users.findMany({ limit, offset });
   21     res.json(rows);
  … +14 lines · ^O
```

- Title from `fileToolTitle` (`Edited`, `Wrote`, `Deleted`, `Appended`, `Wrote N files`),
  glyph from tool status.
- Right-aligned `+N` in `diffAdd` and `−N` in `diffDel`. Below 68 columns they move to
  their own row under the title.
- Gutter: line number right-aligned in 4 columns in `diffGutter`, one space, marker column
  (`+`, `−`, or space), two spaces, then code.
- Added rows: `diffAdd` text on `diffAddBg`. Removed: `diffDel` on `diffDelBg`. Context:
  `foreground`, no wash. When `colorMode` is `16` or `none`, drop the wash and keep the
  marker column — the marker is the fallback, never colour alone.
- Code colours from `highlightLineForPath`, clipped by `clipSpans` to the code column.
- Preview caps: `SINGLE_FILE_PREVIEW_ROWS = 40`, `WRITE_MANY_PREVIEW_ROWS = 8`, already
  defined in `file-diff-view.ts`. Reuse; do not re-derive.
- Collapsed form (`expandFileDiffsGlobal === false`) is the title row only, using
  `collapsedFileChangeLabel`.
- Wrap code, never truncate mid-token; continuation rows align under the code column with
  an empty gutter.

### 3.8 Compacted block

```
✦ Compacted context · ~48,200 → ~9,100 tokens
  └ Session goal: add pagination. Files touched: src/db/users.ts …
  … full memory · ^O
```

`✦` in `cyan`. Summary preview 4 rows (`PREVIEW_LINES = 4`). Token label from
`compactionTokenLabel`. Failure state shows the error in `activity` and the
`original context retained` label the helper already produces.

### 3.9 Notice block

Notices are toasts, never feed rows — `composition-root.ts` already routes `notice` events
to `toast.show` only. `NoticeBlock` exists solely for hydrated history, where a stored
notice must render:

```
 WARN  provider fell back to groq
```

Fixed-width plate: ` WARN ` on `#D97706`, ` ERR  ` on `#B91C1C`, ` INFO ` on `chip`, white
bold. Body follows after one space, wrapped at indent 7.

## 4. Chrome

### 4.1 Composer

```
╭──────────────────────────────────────────────────────────────────────╮
│ ❯ Ask anything...                                                    │
╰──────────────────────────────────────────────────────────────────────╯
```

Multi-line, with a paste chip and a meta row:

```
╭──────────────────────────────────────────────────────────────────────╮
│ ❯ review this and tell me what breaks                                │
│   [pasted 214 lines]                                                 │
│   then write the fix                                                  │
╰──────────────────────────────────────────────────────────────────────╯
```

- The composer receives the already-bounded `shellWidth` from `innerShellWidth()`. Its
  frame and directory row are allocated together by `allocateChrome`; the frame consumes
  its own border columns internally, but no component derives width from raw terminal
  `columns - 2`. When `capabilities.unicode` is false use `borderStyle="classic"`.
- `❯ ` in `inputBorder`. Continuation rows indent 2 with no mark.
- Placeholder in `muted`, mode-aware: `Ask anything...` / `Describe the task...` /
  `What should I plan?`.
- Caret: reverse-video single cell on the character at the cursor, or a `▏`-style block at
  end of line. Implemented in `editor-view.ts` by splitting the row into
  before / at / after and applying `inverse` to the middle. Ink's own cursor stays hidden.
- Height = the text rows returned by `composerFrame`, after reserving the optional directory
  row and two border rows from `allocateChrome().composer`. When the draft is taller than
  the allowance, scroll internally and keep the caret row visible; show `↕` in `muted` at
  the right edge of the top or bottom row to indicate clipping.
- Paste placeholders render as `[pasted N lines]` in `cyan` via
  `ui-core/composer/paste-placeholder.ts`. Expansion happens at submit, unchanged.
- Attachment indicator for images: `[image 1]` in `magenta` inline where the mention was.
- While a turn runs the composer stays open and editable; submitting enqueues. The
  placeholder switches to `Queue a follow-up...`.
- Suspended (a secret or confirm panel is open): border drops to `muted`, mark drops to
  `muted`, placeholder becomes `input locked`.

### 4.2 Status bar

The status model in `ui-core/rendering/status-segments.ts` is shared by both frontends.
Classic keeps the status surface to one bounded row (`statusRowsWanted() === 1`):

```
AGENT · / commands · ^T thinking · ^O output · ⇧⇥ mode              ctx 24.1k/128k
```

The mode badge and idle/activity hints occupy the left side. The context chip is flush
right and uses `contextChipForDensity`, with `muted`, `activity`, and `diffDel` severity
colours. Provider/model/permission metadata lives on the composer's top border; the cwd
and cached git branch live on the directory row immediately above the composer.

While a turn runs, the left side becomes the activity row:

```
AGENT · ⠋ generating response · 12s · esc to cancel                  ctx 24.1k/128k
```

At narrow widths the shared density ladder drops hints and shortens the context chip, but
it never allows a row to cross the shell boundary. Scroll badges `▲ N` / `▼ N` appear only
when the live tail is internally clipped.

`Ctrl+L` opens the inline context-limit editor in this same status row:

```
ctx limit 253k▎  ⏎ save · esc cancel · empty reset
```

Enter parses and persists a token count through `SessionController`; Escape cancels;
backspace/delete and paste edit the draft; an empty draft resets the configured limit. The
editor replaces the normal context chip and has no percentage fallback.

`allocateChrome` may grant no status row on a severely degraded terminal, but it never
allocates an extra status stack merely to show metadata. The full width contract remains
`shellWidth`, not a raw `columns - 1` or `columns - 2` calculation.

### 4.3 Toasts

Zero to two rows directly above the composer, no border:

```
 Copied transcript selection
 switching to backup API key
```

One leading space, then the message on a plate: `success` → `successBg`, `warn` →
`activityBg`, `error` → `failedBg`, `info` → `chip`; white bold text. The fixed one-line
notice is bounded to `shellWidth` and may use an ellipsis only when the notice itself cannot
fit; transcript and pager content never uses this fixed-row shortcut. `ToastController`
already owns lifetimes (200 ms enter, 5000 ms hold, 200 ms exit, `MAX_VISIBLE_TOASTS = 3`)
and already replaces same-`key` toasts, so API-key rotation never stacks. Classic shows at
most `MAX_TOAST_ROWS = 2` of the three and appends ` (+1)` to the last row when one is
hidden.

No slide animation. `capabilities.reducedMotion` is irrelevant because there is nothing to
reduce; the enter/exit phases simply gate visibility.

### 4.4 Queue panel

```
⚠ 2 queued · ^⌥↑↓ select · ^⌥⏎ send now · ^⌥E edit · ^⌥⌫ drop
  1 ❯ run the migration afterwards
  2   and update the changelog
```

Header in `activity`. Selected row marked `❯` in `inputBorder`; others two spaces. Queue
entries are compact one-line control rows bounded to `shellWidth`; the intentional preview
ellipsis is used only for an entry that cannot fit in its allocated row. Max
`QUEUE_MAX_ROWS = 5`, header plus four items, then `… +N more` on the last row.

### 4.5 Responder strip

One row, from `responderStatusText` (already exported by `jobs-panel.tsx`; move it to
`ui-core/rendering/responder-status.ts` in W02):

```
◉ responder · 1 running · 2 delivered · ^J jobs
```

`◉` in `spinner` while any job runs, `muted` otherwise.

## 5. Panels

Every overlay is a bounded panel inside the owned alternate-screen shell. There is no
full-screen wash, no absolute positioning, and no `zIndex` — the row allocator guarantees
the panel fits its granted rows. Panel content receives `shellWidth`; the shared frame
consumes its border/cell columns and exposes `shellWidth - 4` for body text.

### 5.1 Shared frame

`classic/panels/PanelFrame.tsx`:

```
╭ Title ──────────────────────────────────── 3/18 ─╮
│ body                                             │
│                                                  │
╰ hint · hint · hint ──────────────────────────────╯
```

- Ink `borderStyle="round"`, `borderColor` = `inputBorder` for input-bearing panels
  (confirm, secret, scope, keys, picker, completion) and `border` for read-only panels
  (pager, jobs, plan).
- Title in the border colour, one space either side. Right side of the top border carries a
  counter when the panel is a list: `3/18`.
- The bottom border carries the key hints in `muted`. If they do not fit, they are truncated
  from the right with `…`; the full set is always in `/shortcuts`.
- Width is the bounded `shellWidth` supplied by the root, not raw terminal `columns - 2`.
  Height is exactly `allocateChrome().overlay`; the body width is the frame's
  `shellWidth - 4` interior and body height is `overlay - 2`.
- Body content is pre-wrapped and then windowed; the frame does not silently clip prose at
  its boundary. Bottom hints are fixed affordances and may be ellipsized when they cannot
  fit; the full set remains in `/shortcuts`.

### 5.2 Picker — the selection pane

Used by `/model`, `/models`, `/provider`, `/history`, `/effort`, `/output`, `/permissions`,
`/search`, `/scope` target choice, and the plan pager list.

```
╭ Select model ─────────────────────────────────── 4/62 ─╮
│ filter: kimi                                           │
│ ❯ kimi-k2-thinking          groq · 128k · reasoning    │
│   kimi-k2-instruct          groq · 128k                │
│   moonshotai/kimi-k2        openrouter · 128k          │
│   kimi-latest               kimchi                     │
╰ ↑↓ move · ⏎ select · esc cancel · type to filter ──────╯
```

- Filtering through `filterPickerOptions` / `activeIndex` in
  `ui-core/rendering/picker-filter.ts`. Never re-implement the matcher.
- Filter row shown only once the user types; it takes one body row.
- Active row: `❯` in `inputBorder`, label bold `foreground`, background `selection`, full
  panel width so the highlight is a clean bar.
- Inactive rows: zebra `rowA` / `rowB`. Description right-aligned in `muted`; dropped below
  68 columns.
- `twoLine` requests put the description on its own indented row in `muted`.
- `historyStyle` requests render as:

```
╭ Resume session ───────────────────────────────── 2/24 ─╮
│ ❯ Add pagination to the users endpoint                 │
│     2h ago · 18 msgs · agent · groq/kimi-k2            │
│   Fix the failing build                                │
│     yesterday · 42 msgs · agent · nvidia/nemotron      │
╰ ↑↓ · ⏎ resume · ^D delete · esc cancel ────────────────╯
```

- A `rowAction` chord from `PickerRequest` is appended to the bottom hints and dispatched
  through `overlay.actOnPickerRow`.
- Empty result: one body row `no matches` in `muted`, hints keep `esc cancel`.
- Windowing: keep the active row inside the visible body with a 1-row margin; the counter
  in the top border is `activeIndex + 1` over the filtered length.

### 5.3 Completion menu

Same frame, titled by trigger, rendered immediately above the composer. Row count from
`clamp(floor(rows / 3), 6, 12)` capped by the allocator.

Slash:

```
╭ /commands ────────────────────────────────────── 1/38 ─╮
│ ❯ /model            switch model for the active provider│
│   /models           browse every known model            │
│   /mode             set ask, agent, or plan             │
╰ ⇥ complete · ⏎ run · esc dismiss ──────────────────────╯
```

Mention:

```
╭ @files ───────────────────────────────────────── 2/12 ─╮
│   src/routes/                              dir          │
│ ❯ src/routes/users.ts                      2.1 KB       │
│   src/routes/users.test.ts                 4.8 KB       │
╰ ⇥ complete · ⏎ insert · esc dismiss ───────────────────╯
```

- Command name in `cyan`, description in `muted`, alias shown as `/provider, /use`.
- Candidates come from `ui-core/composer/completion.ts` and `app/commands/catalog.ts`.
  Absolute paths beginning with `/` are prompts, never commands — that predicate already
  exists in the catalogue and must be preserved with a test.
- Directories sort before files; images get a `[img]` tag in `magenta`.
- `Tab` completes the common prefix, `Enter` accepts the active row.

### 5.4 Pager

```
╭ shell.exec · npm test ───────────────────────── 41/318 ─╮
│  38   PASS src/db/users.test.ts                         │
│  39   PASS src/routes/users.test.ts                     │
│  40                                                     │
│  41 ▎ Tests: 42 passed, 42 total                        │
╰ ↑↓ jk · ^R find · n/N · f fmt · r raw · s scroll · e ed · c copy · q ─╯
```

- Lines are prepared by classic `pagerLines(body, shellWidth, rows, format)`, using
  `wrapPagerLine` for raw text and shared markdown rendering for formatted text. The
  number-gutter width is iterated with wrapping so the final line count and digit width
  agree; no body row is clipped a second time at the frame boundary.
- The initial mode comes from `resolvePagerMarkdownMode` / `defaultPagerMarkdownMode`:
  help/system/compacted documents and clear Markdown `fs.read` bodies start formatted;
  shell output and file mutations start raw. `f` / `r` still toggle explicitly.
- Formatted fs.read bodies remove tool headers and `N: ` prefixes. Formatted diff bodies
  remove source gutters and markers; raw mode preserves the source. Large bodies stream
  through `ui-core/rendering/artifact-pager-source.ts`; live job feeds use
  `job-tail-source.ts`.
- Caret row marked `▎` in `inputBorder`. This is the one surface with a caret, which is why
  `selection.extend-*` is live here.
- Search matches are found against ANSI-stripped lines, painted `inverse`, and the active
  match is additionally bold. Segmentation comes from `ui-core/state/pager-search.ts`
  (`segmentPagerLine`).
- `l` toggles follow for live feeds; when following, the top border shows `· follow`.
- `s` exports to scrollback and `e` to `$EDITOR`, both through `PagerExportPort`, which
  leaves the alternate screen before the child and re-enters it before remounting Ink.
- Line numbers are shown only when the body has more rows than the body height. Diff/source
  gutters remain part of raw content but are not copied into formatted code.

### 5.5 Confirm

```
╭ ⚠ Approve tool ────────────────────────────────────────╮
│ shell.exec wants to run:                               │
│   rm -rf ./build                                       │
│                                                        │
│ ❯ y approve   n deny   a approve and don't ask again    │
╰ y/n · esc deny ───────────────────────────────────────╯
```

- Frame `borderColor` = `activity`, title glyph `⚠`.
- Prompt text verbatim from `ConfirmRequest.prompt` — those strings live in
  `ui-core/bootstrap/overlay-ports.ts` and are shared with OpenTUI, so wording never drifts.
- Variant keys: tool `y`/`n`/`a`; pentest `y`/`n`; reset `r`; continue `y`/`n`;
  switch `y`/`n`; delete adds `v preview` which opens the pager *over* the confirm without
  resolving it (`OverlayController.suspendUnder` already supports this).
- Plan variant:

```
╭ Plan ready ────────────────────────────────────────────╮
│ 8 tasks · add pagination to the users endpoint         │
│ ❯ i implement   d discard   s suggest changes   p view │
╰ i/d/s/p · esc dismiss ────────────────────────────────╯
```

- The composer is suspended while a confirm is open. Only `y`/`n`/variant keys, `Esc`, and
  `Ctrl+C` are honoured; every other key is swallowed.

### 5.6 Secret

```
╭ 🔒 sudo password ──────────────────────────────────────╮
│ sudo password required for: nmap -sV 10.0.0.1          │
│ ❯ ••••••••                                             │
╰ ⏎ submit · esc cancel ────────────────────────────────╯
```

- Value lives only in `ui-core/composer/secret-buffer.ts`. Never in component state, never
  in the transcript, never in a log, never in an Ink frame beyond the bullet mask.
- `reveal: true` requests (Modal endpoint, Ollama host) show the text and use the same
  frame with a different title.
- Paste is decoded and stripped of ANSI before it reaches the buffer.
- Frame `borderColor` = `magenta` so it is unmistakably distinct from the composer.

### 5.7 Scope editor

```
╭ Engagement scope ──────────────────────────────── 2/3 ─╮
│   1  10.0.0.0/24                                    ×  │
│ ❯ 2  example.com                                     ×  │
│   3  + add target                                       │
╰ ↑↓ · ⏎ edit · ^D remove · ^S save · ^R clear · esc ────╯
```

`ACCENT` is `inputBorder`. Saving an empty list disables scoping, matching
`answerScope([])`.

### 5.8 Keys editor

```
╭ groq · API keys ───────────────────────────────── 1/3 ─╮
│ ❯ ★ 1  gsk_••••••••••••3f9a                          ×  │
│   ☆ 2  gsk_••••••••••••7b21                          ×  │
│     3  + add key                                        │
╰ ⏎ edit · ␣ set active · ^D remove · ^S save · ^R reset ╯
```

`★` in `activity` marks the sticky rotation key. An empty value on save keeps the stored
secret. Capped at `MAX_PROVIDER_KEYS`. The endpoint-URL variant reuses this panel with
`itemLabel: "endpoint URL"` and `reveal` semantics.

### 5.9 Jobs

```
╭ Background jobs ──────────────────────────────── 2/4 ─╮
│ ✓ nmap -sV 10.0.0.1                   done · 4m12s    │
│ ❯ ● ffuf -u https://target/FUZZ    running · 1m03s    │
│   ○ nuclei -t cves/                 queued            │
╰ ↑↓ · ⏎ live · t tail · k stop · q close ──────────────╯
```

Elapsed from `formatJobElapsed`. The panel polls (jobs are not event-driven) on the shared
1 Hz tick, not its own timer. `t` opens the tail through `createJobTailPagerSource` in the
pager, stacked over the jobs panel; closing the pager restores the job list.

### 5.10 Plan panel

```
╭ Tasks ─────────────────────────────────── 3/8 done ─╮
│ ▓▓▓▓▓░░░░░  38%                                     │
│ ✓ Read the route handler                            │
│ ◉ Add limit/offset to the query layer               │
│    RESPONDER · RUNNING                              │
│ ○ Update the response shape                         │
│ ○ Add tests                                         │
╰ ^H hide · ^P detail · ↑↓ task ─────────────────────╯
```

- Rows from `ui-core/rendering/plan-view.ts`: `progressBar`, `taskGlyph`,
  `planStatusChip`, `taskOwnerChip`, `wrapPlanText`, `orderPlanTasksForDisplay`.
- Glyph colours: done `success`, active `activity`, pending `muted`, failed `diffDel`,
  skipped `muted`.
- Titles wrap, never ellipsize — `wrapPlanText` already guarantees that.
- Owner chip on its own indented row in `chipTeal`.
- Focused task row gets a `selection` background when focus region is `plan`.
- Ctrl+P opens `formatPlanPagerDocument` in the pager. There is no split pane — deviation
  D-05.

### 5.11 Prompt actions

```
╭ Prompt ───────────────────────────────────────────────╮
│ add pagination to the users endpoint and return        │
│ metadata in the response body                         │
╰ c copy · r resend · e edit · esc close ──────────────╯
```

Opened by `Enter` on a user block. Body windows long prompts with the counter in the top
border.

### 5.12 Search

```
╭ Find in transcript ───────────────────────────── 2/7 ─╮
│ find: pagination                                      │
│   ◆ I'll read the route handler …                     │
│ ❯ ● shell.exec(npm test) … pagination contract        │
╰ ↑↓ · ⏎ open in pager · esc close ────────────────────╯
```

Backed by `findMatches` / `nextMatchIndex` / `prevMatchIndex` in
`ui-core/state/transcript-search.ts`. Each hit shows its block glyph and a one-line
context excerpt with the match `inverse`.

## 6. Per-state screens

### 6.1 First launch, empty session

Intro card, one blank row, composer, status. Live tail is empty. No spinner, no activity
row.

### 6.2 Streaming

Assistant block open in the live tail with a trailing `…`; activity row replaces the hint
row: `⠋ generating response · 12s · esc to cancel`. Composer stays open with the
`Queue a follow-up...` placeholder.

### 6.3 Tool running

Tool block open with `running · Ns` right-aligned; activity row reads
`⠋ tool: shell.exec · 7s · esc to cancel`. Output rows append into the live tail as they
arrive, bounded by the live-tail policy.

### 6.4 Confirm open

Confirm panel above the composer, composer border and mark dimmed to `muted`, placeholder
`input locked`, activity row unchanged so the user can still see the turn state.

### 6.5 Narrow, 44 columns

```
● shell.exec(npm test…)
  └ PASS src/db/us…
  … +18 · ^O
╭────────────────────────────────────────╮
│ ❯ Ask…                                 │
╰────────────────────────────────────────╯
 AGENT · 24k · ▲▼
```

Right-aligned suffixes dropped, descriptions dropped, one status row, ASCII glyphs if the
terminal lacks Unicode.

### 6.6 Very short, 8 rows

Composer 3, status 1, live tail 3, one row spare. Plan and toasts suppressed;
`degraded === true` and the status row appends ` ·` plus a dim `↕` to signal suppression.

### 6.7 Legacy conhost, no Unicode, 16 colours

```
* shell.exec(npm test --run)                    running - 7s
  \ PASS src/db/users.test.ts
  ... +18 lines - ^O
+------------------------------------------------------------+
| > Ask anything...                                          |
+------------------------------------------------------------+
 AGENT - groq/kimi-k2 - ctx 24.1k/128k - ~/dev/clai
 ^G help - ^T thinking - ^O output - ^H tasks
```

`borderStyle="classic"`, ASCII glyph table, `·` → `-`, diff washes off with `+`/`−` markers
kept as `+`/`-`.

### 6.8 Non-TTY

Ink never mounts. `src/noninteractive` handles it. See [06-ONESHOT.md](06-ONESHOT.md).

## 7. Accessibility and safety

- Every action is keyboard-reachable. Mouse is additive and off by default.
- No information is conveyed by colour alone: every state also has a glyph and a text
  label. Verified by the `colorMode: "none"` golden fixtures.
- All untrusted content (tool output, file contents, web bodies, model text) passes
  `sanitizeDisplayText` before it reaches a frame, so no injected escape can move the
  cursor, clear the screen, or repaint chrome.
- Secrets are masked at the buffer boundary, not at the render boundary.
- Prose, transcript rows, composer text, picker entries, and pager bodies wrap at the
  shared shell boundary. Ellipses are reserved for intentional preview caps and fixed
  chrome affordances (for example a one-line toast or footer hint), not for silently
  discarding text merely because it reached the edge. Any styled row is sealed after
  wrapping so it cannot leak an SGR into the next row.

## 8. Kill switch

`CLAI_CLASSIC_UI=plain` makes the classic frontend start the non-interactive stream
renderer instead of Ink. It is the one-line escape hatch for a terminal that fights the
feed model, and it must be documented in `--help` and `doctor`. Remove it one release after
the migration ships if no one uses it.
