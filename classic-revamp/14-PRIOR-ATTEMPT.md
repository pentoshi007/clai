# Post-mortem: the previous Ink attempt

A React + Ink classic frontend was attempted on branch `feature/classic-react` (commits
`7fc9848`, `b54368b`, `e94ed3c`, based on v3.11.29) and abandoned: misplaced UI, features not
working correctly.

This document exists so the same outcome cannot be reached twice. It is a diagnosis, not a
resource.

## What is reused from that branch: two things, neither of them code

1. **Terminal-protocol measurements** from
   `git show feature/classic-react:classic-improvements/spikes/NOTES.md` — that Ink's
   `useInput` does not decode CSI-u, that Ctrl+J arrives as a bare `0x0A`, that Ctrl+H
   arrives as `0x08` with `backspace: true`, that SGR mouse reports leak into text, that
   Alt+Enter arrives as two events. These are facts about terminals and about Ink's input
   layer, independently re-verifiable, and W00 spike **S5** re-verifies them. They are
   recorded in [05-INPUT.md](05-INPUT.md) §1 as a table.
2. **The failure itself**, as the design constraint below.

Nothing else. No file, no component, no controller, no layout module, no naming. The
`src/classic` tree specified in [02-ARCHITECTURE.md](02-ARCHITECTURE.md) has a different
architecture, a different directory shape, and different module boundaries.

**Rule for the implementing agent:** do not open `feature/classic-react`'s `src/` at all.
Reading it will pull its shape into your solution. The spike notes are the only file you may
read from that branch, and they are already summarised in
[01-AUDIT.md](01-AUDIT.md) §10 and [05-INPUT.md](05-INPUT.md) §1, so you should not need even
that.

## Measured shape of the failed attempt

19 files, roughly 6,700 lines:

| Lines | File |
|---|---|
| 1339 | `src/classic/app/classic-overlay-controller.ts` |
| 863 | `src/classic/bootstrap/start-classic.tsx` |
| 728 | `src/classic/composer/classic-composer-controller.ts` |
| 429 | `src/classic/app/ClassicWorkspace.tsx` |
| 408 | `src/classic/transcript/ClassicTranscriptRow.tsx` |
| 392 | `src/classic/transcript/classic-transcript-controller.ts` |
| 360 | `src/classic/input/raw-terminal-decoder.ts` |
| 317 | `src/classic/app/ClassicOverlay.tsx` |
| 221 | `src/classic/app/ClassicApp.tsx` |
| … | nine more under 220 |

## Root causes, and the rule that prevents each

### C1 — It chose the full-screen model that Ink is bad at

`terminal-session.ts` entered the alternate screen. `classic-transcript-controller.ts`
(392 lines) implemented a viewport with `scrollBy`, scroll offsets, and clamping.
`classic-transcript-layout.ts` computed row slices.

That is Model A in [03-RENDER-MODEL.md](03-RENDER-MODEL.md) §1. It requires owning every cell
on screen, which in Ink means erasing and rewriting the full frame on every state change,
while hand-maintaining a scroll offset that must agree with content heights that change as
content streams. Every disagreement between those two numbers is a visible misplacement.

**Prevention:** the scrollback feed model. There is no viewport, no scroll offset, no slice
arithmetic, and no full-frame repaint. The terminal owns history; Ink owns a small bottom
block. The `scrollBy` concept does not exist in the new design.

### C2 — Row positions were computed by hand, in several places at once

`start-classic.tsx` routed mouse events with `transcriptController.containsMouse(event.y)`,
`workspaceController.mouseRegion(event.y)`, and `composer.containsMouse(event.y)`. Three
modules each held their own belief about which screen rows they occupied, and each had to keep
that belief synchronised with what Yoga actually rendered.

There was no single owner of the row budget and no test asserting that the parts summed to the
terminal height. "UI misplaced" is the direct, expected symptom.

**Prevention:** one pure `allocateChrome()` in `classic/chrome/row-budget.ts` is the only
thing that decides heights ([03-RENDER-MODEL.md](03-RENDER-MODEL.md) §8). It is property-
tested to satisfy `total <= rows - 1` at every terminal size, with a golden table for rows
1–10. No component computes a row position. No module stores its own `y`. Mouse hit-testing
by `event.y` does not exist, because mouse reporting is off by default
([05-INPUT.md](05-INPUT.md) §8).

### C3 — Monoliths, so nothing could be tested in isolation

A 1339-line overlay controller holds ten overlays' behaviour in one file. An 863-line
bootstrap holds capabilities, DI, queue actions, mode cycling, plan detail, context-limit
editing, selection, interrupt ladders, a mouse router, and a ~200-line `onAction` switch.

At that size a per-panel test is impossible to write, so the panels were verified by running
the app — which is why "no feature working correctly" and "misplaced UI" arrived together.
They are the same defect: untested units composed into an untestable whole.

**Prevention:** a hard 400-line ceiling enforced by
`test/classic/architecture.test.ts` ([10-TESTING.md](10-TESTING.md)), a 350-line target, one
responsibility per file, and one test file per panel asserting rendered rows, key handling,
and the resulting controller call ([08-ROADMAP.md](08-ROADMAP.md) W10). The overlay controller
is not rewritten at all — `ui-core/controllers/overlay-controller.ts` already exists, is
shared with OpenTUI, and is already tested. The previous attempt wrote a second one.

### C4 — Mouse reporting on by default

`mouseReporting: process.env.CLAI_CLASSIC_MOUSE !== "0"` — enabled unless explicitly
disabled. That takes native text selection away from the user, then obliges the renderer to
reimplement selection through `event.y` hit-testing (C2), on a surface whose row positions
were already unreliable.

**Prevention:** off by default, opt-in via `CLAI_CLASSIC_MOUSE=1`, and even then limited to
wheel and panel-row clicks. Native selection and copy are preserved
([09-PARITY.md](09-PARITY.md) D-03).

### C5 — Built on a base that was already 5 releases old, and stayed there

Branched from v3.11.29; `main` reached v3.16.0. Two commits exist purely to port main's
changes forward, and the shared layer kept moving underneath. The OpenTUI frontend gained
`/models`, unforgeable reasoning markers, compaction recency, and a privacy window while the
Ink branch was catching up.

**Prevention:** work on `fix/classic-revamp`, which is at `main`. W02 extracts the shared
layer into `src/ui-core` **before** any Ink component is written, so both frontends consume
one implementation and there is nothing to port forward. Every package boundary re-runs
`test/tui-v2` and `test/app`.

### C6 — Shared behaviour was duplicated instead of extracted

`classic-composer-controller.ts` (728 lines) and `classic-overlay-controller.ts` (1339 lines)
reimplement work that `ui-core` equivalents already do for OpenTUI. Two implementations of
the same behaviour drift immediately, and drift in a composer or an overlay reads to the user
as "features not working correctly".

**Prevention:** [02-ARCHITECTURE.md](02-ARCHITECTURE.md) forbids a second implementation of
anything, and [00-AI-EXECUTION.md](00-AI-EXECUTION.md) lists the specific duplications as
prohibited patterns. The Ink composer is a *view* over `ui-core/composer/*`; the panels are
*views* over `ui-core/controllers/overlay-controller.ts`. `classic/chrome/editor-model.ts` is
the only genuinely new logic module, because grapheme-aware cursor editing has no shared
equivalent — and it is pure, small, and property-tested.

### C7 — No invariants, so regressions were invisible

`test/classic/` on that branch held a startup test, a lifecycle test, and a chord test. There
was no assertion that a rendered row fits the terminal width, that heights sum correctly,
that blocks are not duplicated, or that a frame contains no severed escape sequence.

**Prevention:** [03-RENDER-MODEL.md](03-RENDER-MODEL.md) §12 defines six mechanical
invariants, and `test/classic/feed/invariants.test.ts` runs all six over every golden fixture,
so adding a fixture extends coverage automatically. Plus six property/fuzz targets in
[10-TESTING.md](10-TESTING.md).

## Summary table

| # | Root cause | Prevention | Enforced by |
|---|---|---|---|
| C1 | full-screen viewport model | scrollback feed; no viewport, no scroll offset | [03](03-RENDER-MODEL.md) §1–2; PTY test asserts no alt-screen sequence |
| C2 | hand-computed row positions in several modules | one pure row allocator | `row-budget.test.ts` property + golden table |
| C3 | 1339- and 863-line monoliths | 400-line ceiling; one responsibility per file | `test/classic/architecture.test.ts` |
| C4 | mouse on by default | mouse off; native selection kept | [05](05-INPUT.md) §8; D-03 |
| C5 | stale base, perpetual forward-porting | at `main`; extract shared layer first | W02 ordering; `test/tui-v2` at every boundary |
| C6 | duplicated composer and overlay controllers | views over `ui-core`; no second implementation | [00](00-AI-EXECUTION.md) prohibited patterns; architecture guards |
| C7 | no rendering invariants | six mechanical invariants over every fixture | `invariants.test.ts` |

## The honest read

The previous attempt failed on architecture, not on Ink, and not on effort. Ink plus Yoga
plus React is a sound stack — it is the stack Claude Code ships. What broke was choosing the
rendering model Ink handles worst, then hand-maintaining screen coordinates across several
large files with no invariant to catch the disagreements.

The plan in this directory inverts each of those decisions. If, during implementation, you
find yourself writing a scroll offset, storing a `y` coordinate in a component, or passing 400
lines in a file, you have re-entered the failure mode. Stop and re-read this page.
