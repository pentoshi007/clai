# Render Model — the feed renderer

This document defines how Ink puts pixels on screen. It is the load-bearing design
decision of the migration. [04-UI-SPEC.md](04-UI-SPEC.md) describes *what* each element
looks like; this file describes *where frames come from* and *why nothing ever misplaces*.

## 1. Candidate models and the current choice

**Model A — owned full-screen shell.** Enter the alternate screen, render a frame that is
exactly the terminal height, and keep terminal ownership and cleanup in one lifecycle
object. This is the OpenTUI-style startup contract.

**Model B — scrollback feed.** Stay on the normal screen and let completed output become
terminal-owned scrollback while Ink repaints only a small chrome block at the bottom. This
was the original W00 proposal, not the current classic startup contract.

**Decision: use Model A's terminal ownership with the classic feed/block renderer.**
`TerminalSession` owns alternate-screen entry/exit, clear/home, cursor, paste, optional
mouse, raw input, and teardown. Ink is mounted with `alternateScreen: false`, so Ink and
the session cannot emit competing alternate-screen sequences. The allocator may consume all
usable rows; there is no phantom bottom row.

Reasons, in order of weight:

1. **Startup must be a fresh space.** Entering `?1049h`, clearing, and homing the cursor
   prevents the classic UI from appearing inside the user's existing scrollback.
2. **The shell has one measurable boundary.** `horizontalPadding()` and
   `innerShellWidth()` define the left/right margins once. Feed, chrome, composer, panels,
   status, and directory/branch rows all receive that bounded width.
3. **The feed renderer remains deterministic.** `FeedStatic` and the commit ledger still
   append complete blocks in order, while the live tail and chrome are re-rendered inside
   the owned screen. Committed blocks are not silently reflowed by individual components.
4. **Terminal lifecycle is explicit.** Suspend/resume, export, resize, and every exit path
   pass through `TerminalSession`, which makes cleanup testable and idempotent.
5. **The implementation stays renderer-neutral.** Markdown, pager policy, wrapping, and
   semantic state remain in `ui-core`; only terminal ownership and Ink composition are
   classic concerns.

Costs, all accepted and recorded in [09-PARITY.md](09-PARITY.md):

- The classic screen owns the viewport while it is running; native normal-screen
  scrollback is not the primary transcript viewport.
- There is no custom full-transcript scrollbar or mouse selection model. The live tail can
  be moved when internally clipped, and older/complete content is reachable through the
  pager and transcript search.
- Committed blocks are append-only for the feed ledger. Changes that require reflow or
  full detail open the pager instead of truncating content in place.

## 2. Screen ownership

The classic renderer owns a fresh alternate-screen buffer. `TerminalSession` is the only
code allowed to emit terminal lifecycle sequences; Ink is configured with
`alternateScreen: false`.

`classic/bootstrap/terminal-session.ts` emits, on `enter()`:

| Sequence | Purpose |
|---|---|
| `\x1b[?1049h` | enter the alternate screen |
| `\x1b[2J` | clear the fresh buffer |
| `\x1b[H` | home the cursor before the first frame |
| `\x1b[?2004h` | bracketed paste on |
| `\x1b[?25l` | hide the terminal cursor; Ink draws the input caret |
| `\x1b[?1000h\x1b[?1002h\x1b[?1006h` | only when `CLAI_CLASSIC_MOUSE=1` |

On `leave()`, the session detaches raw input, disables optional mouse reporting, shows the
cursor, disables bracketed paste, and emits `\x1b[?1049l`. Each step is guarded so one
failure cannot skip the rest, and enter/leave are idempotent. `clearScreen()` remains an
explicit `/clear`, `/new`, or `/clean` operation rather than a render-side write.

Raw mode is set in `attachInput()`, separate from `enter()`, so the byte decoder and raw
mode arrive together and detach together. Suspend/resume uses the same owner, leaving and
re-entering the alternate screen around child processes such as `$EDITOR`.

## 3. Frame anatomy

```
 ┌─ owned alternate-screen frame ────────────────────────────────
 │ committed feed blocks (append-only `<Static>` history)          │
 │ ▌ YOU  first prompt                            │  committed blocks
 │ ◆ assistant reply                              │  written once by <Static>
 │ ● shell.exec(…)  ✓                             │  never rewritten
 │ …                                              │
 ├─ re-rendered shell sections ──────────────────────────────────
 │ live tail        (open / recent blocks)        │  flex, shrinks first
 │ plan panel       (Ctrl+H)                     │
 │ overlay panel    (picker | pager | jobs | …)   │
 │ queue panel                                   │
 │ responder strip                               │
 │ toast rows       (0–2)                        │
 │ composer box     (≥3 rows)                    │
 │ status rows      (1–3)                        │
 └─────────────────────────────────────────────────────────────────
```

React tree:

```tsx
<Box width={terminalColumns} paddingLeft={horizontalPadding} paddingRight={horizontalPadding}>
  <Static items={committed}>{(block) => <CommittedBlock key={block.key} block={block} />}</Static>
  <Chrome />
</Box>
```

`<Static>` is the only mechanism allowed to append committed feed blocks. They remain
append-only within the alternate-screen frame; normal-screen scrollback is not the active
viewport. `<Chrome>` renders exactly the row count the allocator gives it — never more,
never fewer — and every child wraps to the shared inner shell width.

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

`classic/feed/commit-ledger.ts` decides which blocks are committed to the owned frame and
which stay live and re-renderable.

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
explicit `\x1b[2J\x1b[H` from `terminal-session.ts`. Entering the alternate screen also
clears and homes it, but ordinary state changes do not issue a full-screen clear.

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
  readonly composer: number;   // includes directory row and 2 border rows
  readonly status: number;
  readonly toast: number;
  readonly queue: number;
  readonly responder: number;
  readonly plan: number;
  readonly overlay: number;
  readonly liveTail: number;
  readonly total: number;      // === rows or less
  readonly degraded: boolean;
}

allocateChrome(demand: ChromeDemand): ChromeLayout
```

Algorithm — strict priority order, each step takes only what remains:

```
budget = max(rows, 0)                   // the alternate-screen shell owns every row

1. composer = 1 + 2 + clamp(composerTextRows, 1, min(COMPOSER_MAX_TEXT_ROWS, floor(rows*0.4)))
   if composer > budget: composer = min(4, budget)      // directory + border + one line, or less
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

- `total <= rows` for every `rows` in 1…200 crossed with every demand combination
  (property test with `fast-check`, because the alternate screen intentionally uses the
  full terminal height).
- Monotonicity: increasing `rows` never decreases `liveTail`.
- `rows = 1` → composer 1, everything else 0, `degraded === true`.
- Assert the exact full-height table for `rows` 1–10 as a golden snapshot so the
  degradation path cannot drift silently.
- An open overlay at `rows = 12` still leaves `composer >= 3` and `status >= 1`.

## 9. Repaint discipline

| Concern | Rule |
|---|---|
| Frame rate | Ink writes only when the rendered string changed. Keep the store's 16 ms coalescing. Cap chrome-driven repaints at 20 fps with a trailing-edge scheduler in `classic/app/app-wiring.ts`. |
| Spinner | 80 ms braille cycle, and it must touch only one row's content. Never re-derive feed blocks on a spinner tick. |
| Elapsed timers | one 1 Hz tick drives every "· 12s" label. Never one timer per card. |
| Resize | `process.stdout.on("resize")` debounced 80 ms. Recompute terminal columns, derive `innerShellWidth()`, rebuild live blocks, and reallocate the full-height shell. Every surface receives the new bounded width. |
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
| `transcript.scroll-up` / `-down` | scroll the live tail when it is internally clipped; otherwise a one-shot toast: `use the pager or Ctrl+R to search older content` |
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

1. `allocateChrome` totals `<= rows` for every size — the alternate-screen shell intentionally
   uses the full terminal height, and the property test is the correctness gate.
2. Every `FeedBlock.lines.length` equals the block's rendered row count — golden fixtures
   at widths 40, 48, 68, 80, 96, 120, 200.
3. Every rendered row's display width is `<= innerShellWidth(terminalColumns)` — assertions
   cover the shared left/right shell padding plus CJK, emoji, combining marks, and ANSI
   tool output.
4. No frame contains a bare `\x1b` fragment or an unterminated SGR — regex assertion.
5. Ink's rendered frame height equals `ChromeLayout.total` — asserted from captured frames.
6. Resize from every width to every other width in the golden set leaves no row wider than
   the new bounded shell width.
