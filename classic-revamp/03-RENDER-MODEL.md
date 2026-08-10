# Render Model — the feed renderer

This document defines how Ink puts pixels on screen. It is the load-bearing design
decision of the migration. [04-UI-SPEC.md](04-UI-SPEC.md) describes *what* each element
looks like; this file describes *where frames come from* and *why nothing ever misplaces*.

## 1. The two candidate models, and the choice

**Model A — fixed full-screen.** Enter the alternate screen, render one frame that is
exactly `rows` tall, implement our own scrolling, our own scrollbar, our own selection
hit-testing. This is what OpenTUI does.

**Model B — scrollback feed.** Never leave the normal screen. Completed output is
*committed* into the terminal's own scrollback and never rewritten. A small live *chrome
block* at the bottom is the only thing Ink repaints. This is what Claude Code and Codex CLI
do.

**Decision: Model B.**

Reasons, in order of weight:

1. **Ink cannot do Model A well.** Ink has no scroll container. Ink's writer erases the
   previous frame and writes the new one; a 50-row frame means a 50-row erase-and-repaint
   on every state change. Over SSH that is visibly slow and prone to tearing. OpenTUI
   avoids this with cell diffing; Ink has no equivalent.
2. **Windows.** Alternate-screen plus raw mode plus mouse tracking is exactly the
   combination that misbehaves on legacy conhost and in some VS Code terminal
   configurations. Model B emits almost no control sequences, so there is far less to get
   wrong and far less to restore on exit.
3. **Selection and copy come free.** Ink has no text selection. Under Model A we would have
   to enable mouse reporting and re-implement hit-testing to feed `SelectionController`,
   which simultaneously *destroys* the terminal's native selection. Under Model B mouse
   reporting stays off and the user selects and copies with their terminal, as they already
   do in Claude Code.
4. **Scrollback comes free.** The user's scrollback, search, and mouse wheel already work.
5. **Streaming is cheap.** Only the small live region repaints per delta. The 3-frames-per
   -10,000-deltas throughput measured in the prior spike is a property of this model.

Costs, all accepted and recorded in [09-PARITY.md](09-PARITY.md):

- No side-by-side plan split. The plan is a bounded panel plus the Ctrl+P pager.
- No in-place expand of *committed* blocks. Expansion works on live blocks; committed
  content is reachable through `/output`, `Ctrl+R` search, and the pager.
- No custom scrollbar. The terminal's own is authoritative.

## 2. Screen ownership

The classic renderer does **not** use the alternate screen buffer.

`classic/bootstrap/terminal-session.ts` emits, on `enter()`:

| Sequence | Purpose |
|---|---|
| `\x1b[?2004h` | bracketed paste on |
| `\x1b[?25l` | hide cursor (Ink draws its own caret block) |
| `\x1b[?1000h\x1b[?1002h\x1b[?1006h` | **only** when `CLAI_CLASSIC_MOUSE=1` |

On `leave()`, in reverse, each wrapped so one failure does not skip the rest:
mouse off, `\x1b[?25h`, `\x1b[?2004l`. Both methods are idempotent via an `owned` flag.
No `\x1b[?1049h`, no `\x1b[2J`, no full-screen clear at any point in a session.

Raw mode is set in `attachInput()`, separate from `enter()`, so the byte decoder and raw
mode arrive together and detach together.

## 3. Frame anatomy

```
 ── terminal scrollback ─────────────────────────────────────────
 │ intro card                                     │
 │ ▌ YOU  first prompt                            │  committed blocks
 │ ◆ assistant reply                              │  written once by <Static>
 │ ● shell.exec(…)  ✓                             │  never rewritten
 │ …                                              │
 ── Ink dynamic frame (repainted) ───────────────────────────────
 │ live tail        (open / recent blocks)        │  flex, shrinks first
 │ plan panel       (Ctrl+H)                     │
 │ overlay panel    (picker | pager | jobs | …)   │
 │ queue panel                                   │
 │ responder strip                               │
 │ toast rows       (0–2)                        │
 │ composer box     (≥3 rows)                    │
 │ status rows      (1–3)                        │
 ────────────────────────────────────────────────────────────────
```

React tree:

```tsx
<Box flexDirection="column">
  <Static items={committed}>{(block) => <CommittedBlock key={block.key} block={block} />}</Static>
  <Chrome />
</Box>
```

`<Static>` is the only mechanism allowed to produce scrollback. Nothing else writes above
the dynamic frame. `<Chrome>` renders exactly the row count the allocator gave it — never
more, never fewer.

## 4. Blocks

A **block** is one renderable transcript unit derived from one `TranscriptItem`.

```ts
type BlockKind =
  | "intro" | "user" | "assistant" | "thinking"
  | "tool" | "batch" | "diff" | "compacted" | "notice";

interface FeedBlock {
  readonly key: string;          // item id + generation
  readonly itemId: string;
  readonly kind: BlockKind;
  readonly open: boolean;        // streaming or running
  readonly lines: readonly string[];   // ANSI, pre-wrapped, exact rows
  readonly turnId: string | undefined;
  readonly sequence: number;
}
```

`classic/feed/feed-blocks.ts` is a pure function:

```ts
buildFeedBlocks(state: TranscriptState, view: FeedViewInput): readonly FeedBlock[]
```

where `FeedViewInput` carries `{ width, glyphs, theme, colorLevel, expandThinking,
expandOutput, expandFileDiffs, itemOverrides, fileDiffOverrides, spool }`.

Invariants, each with a test:

- **Exact height.** `lines.length` is the block's true row count at `width`. Wrapping is
  done by us in `classic/render/wrap.ts` using `string-width`, never by Yoga.
- **No trailing blank.** Inter-block spacing is added by the container, not by blocks.
- **Deterministic.** Same inputs → identical output. No `Date.now()`, no randomness, no
  reads of process state inside the builder. Elapsed times come in through `FeedViewInput`.
- **Pure ANSI.** A line is a styled string safe to hand to `<Text>`. All untrusted content
  passes `sanitizeDisplayText` first.
- **Bounded.** A block is never taller than `MAX_BLOCK_ROWS = 400`. Beyond that it renders
  its bounded form with a "full output → pager" footer.
- **Quiet meta tools hidden.** Reuse `shouldHideQuietMetaToolInChat`; a hidden tool
  produces zero blocks.

## 5. The commit ledger

`classic/feed/commit-ledger.ts` decides which blocks are committed to scrollback and which
stay live and re-renderable.

```ts
interface CommitDecision {
  readonly committed: readonly FeedBlock[];  // append-only, in order
  readonly live: readonly FeedBlock[];
  readonly committedCount: number;
}

decideCommit(input: {
  blocks: readonly FeedBlock[];
  liveBudgetRows: number;
  committedCount: number;
  turnBoundary: boolean;
}): CommitDecision
```

Rules — all four are tested individually:

1. **Monotonic.** `committedCount` never decreases. A committed block is never
   un-committed, re-rendered, or reordered. `<Static>` cannot take content back, so
   neither can we.
2. **Whole blocks only.** A block is entirely live or entirely committed. Never split.
3. **Commit triggers.** A block leaves the live region when *any* holds:
   - **budget overflow** — walking backwards from the newest block, accumulated
     `lines.length` exceeds `liveBudgetRows`. Everything older commits.
   - **turn boundary** — on `turn-start`, every block from a previous turn commits. This
     guarantees a clean flush at each user prompt and bounds the live region's age.
   - **own height** — the block alone exceeds `liveBudgetRows` and is closed.
4. **Open blocks are never committed** while `open === true`, with one exception: an open
   block taller than `liveBudgetRows` renders a *bounded tail* (see §6) and commits in full
   only when it closes.

`/clear`, `/new`, and `/clean` reset the ledger: `committedCount = 0`, `<Static>` receives
a fresh `items` array with a new generation prefix in every key, and the renderer emits one
`\x1b[2J\x1b[H` from `terminal-session.ts` — the only full clear in the product, and only
on explicit user command.

## 6. Live tail policy

`classic/feed/live-tail-policy.ts` bounds an open block that does not fit:

| Kind | Bounded form while open |
|---|---|
| `assistant` | last `min(liveBudget − reserved, 12)` rendered lines, plus a dim `… streaming` marker on the first visible row when truncated |
| `thinking` | reuse `liveThinkingDisplay` from `ui-core/rendering/thinking-tail.ts` |
| `tool` | last 8 output lines plus the header row; reuse the existing tool preview policy |
| `batch` | header plus the running sub-tool, others collapsed to one row each |
| `diff` | header plus first `min(8, budget)` hunk rows |
| `compacted` | reuse `liveCompactionHeadTail` |

When the block closes it commits at full (still `MAX_BLOCK_ROWS`-bounded) height. The
bounded tail therefore never persists into scrollback — the committed copy is the complete
one.

## 7. The `<Static>` interleaving risk — W00 spike S3

Everything above assumes Ink's `<Static>` appends new items above the dynamic frame without
duplicating or reordering, including when the dynamic frame shrank in the same commit.
That must be proven, not assumed.

**Spike S3** (`classic-revamp/spikes/static-interleave.tsx`), asserted with
`ink-testing-library` frame capture *and* a PTY capture:

1. Render 3 static items plus a 5-row dynamic region.
2. In one `act`, append 2 static items and shrink the dynamic region to 2 rows.
3. Assert the captured byte stream contains each static line exactly once, in order, and
   that no stale dynamic row survives below them.
4. Repeat 200 times with randomized sizes as a fuzz case.

**If S3 passes** (expected): implement as specified.

**If S3 fails**, apply this fallback and record it in [09-PARITY.md](09-PARITY.md):
drop `<Static>` and give `terminal-session.ts` a `commitLines(lines: string[])` method that
(a) erases the dynamic region with `\x1b[<n>F\x1b[0J`, (b) writes the committed lines
followed by `\n`, (c) lets Ink repaint. Ink must then be mounted with a writer that reports
its own last frame height, which `terminal-session.ts` reads before erasing. This is
strictly more code and strictly more risk, which is why `<Static>` is the primary plan.

Do not start W07 before S3 has a recorded result.

## 8. The row budget allocator

This single pure function is the answer to "no misplacement, no abnormality". Every
chrome element gets its rows from here and renders exactly that many.

`classic/chrome/row-budget.ts`:

```ts
interface ChromeDemand {
  readonly rows: number;
  readonly columns: number;
  readonly composerTextRows: number;      // from editor-model, ≥1
  readonly statusRowsWanted: 1 | 2 | 3;   // from density ladder
  readonly toastCount: number;
  readonly queueCount: number;
  readonly responderVisible: boolean;
  readonly planVisible: boolean;
  readonly planRowsWanted: number;
  readonly overlay: { kind: OverlayKind; rowsWanted: number } | undefined;
}

interface ChromeLayout {
  readonly composer: number;   // includes 2 border rows
  readonly status: number;
  readonly toast: number;
  readonly queue: number;
  readonly responder: number;
  readonly plan: number;
  readonly overlay: number;
  readonly liveTail: number;
  readonly total: number;      // === rows - 1 or less
  readonly degraded: boolean;
}

allocateChrome(demand: ChromeDemand): ChromeLayout
```

Algorithm — strict priority order, each step takes only what remains:

```
budget = max(rows - 1, 0)                 // keep one row free; never write the last cell

1. composer = 2 + clamp(composerTextRows, 1, min(COMPOSER_MAX_TEXT_ROWS, floor(rows*0.4)))
   if composer > budget: composer = min(3, budget)      // border+1 line, or less
   budget -= composer
2. status = min(1, budget); budget -= status            // one row is mandatory chrome
3. overlay = overlay ? clamp(rowsWanted, OVERLAY_MIN_ROWS, floor(rows*0.6), budget) : 0
   budget -= overlay
4. toast = min(toastCount, MAX_TOAST_ROWS, budget); budget -= toast
5. queue = queueCount > 0 ? min(queueCount + 1, QUEUE_MAX_ROWS, budget) : 0
   budget -= queue
6. responder = responderVisible ? min(1, budget) : 0; budget -= responder
7. plan = planVisible ? clamp(planRowsWanted + 2, PLAN_MIN_ROWS, PLAN_MAX_ROWS, budget) : 0
   budget -= plan
8. statusExtra = min(statusRowsWanted - status, budget); status += statusExtra
   budget -= statusExtra
9. liveTail = budget
degraded = (status < statusRowsWanted) || (overlay > 0 && overlay < rowsWanted)
         || (planVisible && plan === 0) || liveTail === 0
```

Constants: `COMPOSER_MAX_TEXT_ROWS = 18` (matches `COMPOSER_MAX_HEIGHT`),
`OVERLAY_MIN_ROWS = 5`, `MAX_TOAST_ROWS = 2`, `QUEUE_MAX_ROWS = 5`,
`PLAN_MIN_ROWS = 5`, `PLAN_MAX_ROWS = 14`.

Why status before the overlay: a user who has lost the mode/model line cannot orient. Why
the overlay before toasts: an open overlay is the user's current intent. Why the plan last:
it is the only purely informational surface.

Required tests in `test/classic/chrome/row-budget.test.ts`:

- `total <= rows - 1` for every `rows` in 1…200 crossed with every demand combination
  (property test with `fast-check`, already a dev dependency).
- Monotonicity: increasing `rows` never decreases `liveTail`.
- `rows = 1` → composer 1, everything else 0, `degraded === true`.
- `rows = 3` → composer 3, status 0? No: composer clamps to `min(3, budget=2)` = 2, then
  status 0. Assert the exact table for `rows` 1–10 as a golden snapshot so the degradation
  path can never drift silently.
- An open overlay at `rows = 12` still leaves `composer >= 3` and `status >= 1`.

## 9. Repaint discipline

| Concern | Rule |
|---|---|
| Frame rate | Ink writes only when the rendered string changed. Keep the store's 16 ms coalescing. Cap chrome-driven repaints at 20 fps with a trailing-edge scheduler in `classic/app/app-wiring.ts`. |
| Spinner | 80 ms braille cycle, and it must touch only one row's content. Never re-derive feed blocks on a spinner tick. |
| Elapsed timers | one 1 Hz tick drives every "· 12s" label. Never one timer per card. |
| Resize | `process.stdout.on("resize")` debounced 80 ms. Recompute `columns`, rebuild live blocks, reallocate rows. **Committed blocks are never reflowed** — they were printed at the old width and stay as printed, exactly like Claude Code. |
| Streaming | derive live blocks from the coalesced store notification, not per delta. |
| Memory | committed `FeedBlock` objects drop their `lines` array after `<Static>` has rendered them once; keep only `{ key }` for reconciliation. The store's 2000-item bound stays authoritative for content. |
| Writes | never call `process.stdout.write` from a component. |

Performance gate: a scripted 60-second turn with 200 tool-output lines and 8,000 assistant
deltas must produce fewer than 400 frame writes and must not exceed 5 % of one core.
Measured in `test/classic/performance.test.ts` with a fake clock and a counting stream.

## 10. Scroll, search, and expansion in a feed world

Semantic actions still resolve; their effect is re-mapped. All of this is
[09-PARITY.md](09-PARITY.md) deviation D-01 through D-04.

| Action | Feed behaviour |
|---|---|
| `transcript.scroll-up` / `-down` | scroll the live tail when it is internally clipped; otherwise a one-shot toast: `use your terminal's scrollback · ^R to search` |
| `transcript.page-up` / `-down` | same |
| `transcript.top` | toast pointing at `^R` / `/history` |
| `transcript.bottom` | no-op; the feed is already at the bottom by construction |
| `transcript.search` (`Ctrl+R`) | opens `SearchPanel` — filters the in-memory store with `findMatches`, shows hits as a picker, Enter opens the hit in the pager |
| `transcript.expand-toggle` (`Enter` on transcript focus) | toggles the *live* selected block; if the selection is committed, opens it in the pager |
| `transcript.toggle-thinking` (`Ctrl+T`) | flips `expandThinkingGlobal` — applies to live blocks immediately and to all future blocks; when no live thinking block exists, opens the last thinking block in the pager |
| `transcript.toggle-output` (`Ctrl+O`) | flips `expandOutputGlobal` — same rule; when nothing live, runs the existing `/output` picker |
| `selection.select-all` (`Ctrl+A`) | selects the whole in-memory transcript in `SelectionController` |
| `selection.copy` (`Ctrl+Shift+C`) | copies the current `SelectionController` range, else the whole transcript, through `ClipboardPort` |
| `selection.clear` (`Esc`) | clears the range, then falls through to the global cancel ladder |
| `selection.extend-*` | active only inside `PagerPanel`, where a caret exists |

`SelectionController` and `semantic-document` stay in use: the pager panel is a real
caret-bearing surface, and select-all/copy operate on semantic ranges. Nothing is deleted.

## 11. Focus regions

`FocusController` regions in classic: `composer`, `transcript`, `plan`. `transcript` focus
means "keyboard targets the live tail / feed actions", not a scroll cursor. `Tab` cycles
`composer → transcript → plan` (plan only when the panel is visible), matching OpenTUI.
Overlay contexts push and pop exactly as they do today, and `pushOverlay` still throws on a
second open — the single-overlay invariant is unchanged.

## 12. Definition of "picture perfect"

Enforced mechanically, not by review:

1. `allocateChrome` totals `<= rows - 1` for every size — property test.
2. Every `FeedBlock.lines.length` equals the block's rendered row count — golden fixtures
   at widths 40, 48, 68, 80, 96, 120, 200.
3. Every rendered row's display width is `<= columns` — `string-width` assertion over all
   golden fixtures, including CJK, emoji, combining marks, and ANSI-bearing tool output.
4. No frame contains a bare `\x1b` fragment or an unterminated SGR — regex assertion.
5. Ink's rendered frame height equals `ChromeLayout.total` — asserted from captured frames.
6. Resize from every width to every other width in the golden set leaves no row wider than
   the new `columns`.
