# Roadmap

Eighteen work packages, in order. A package is complete only when its acceptance gate
passes **and** `npx vitest run test/tui-v2 test/app` is still green. Do not combine
extraction, Ink construction, and deletion into one change.

Notation: **New** = files created, **Move** = `git mv`, **Edit** = modified, **Gate** = the
exact commands whose output goes in the completion report.

---

## W00 — Baseline and spikes

Prove every assumption before structural change.

**Baseline** — record the output of each, so later regressions are attributable:
`npm run typecheck`, `npx vitest run`, `npm run build`, `npm run compile`,
`npm run test:bun`, `npm pack --dry-run`, `du -sh dist`, `ls -l release/`.

**Dependency and version work** — all of [13-DEPENDENCIES.md](13-DEPENDENCIES.md):

- `npm view ink engines peerDependencies dependencies` and the same for
  `ink-testing-library`. Record the output. If the registry has moved past 7.1.1, use the new
  latest and record why.
- **Edit** `package.json`: `engines.node` from `">=20"` to `">=22"`.
- Install `ink@7.1.1` and `ink-testing-library@4.0.0` at exact pins, via npm only.
- Bump `react` 19.2.8, `@types/react` 19.2.18, `@types/node` 26.2.0, `vitest` 4.1.10,
  `fast-check` 4.9.0, `tsx` 4.23.12. Keep `typescript` at 6.0.3 (§6 of that document).
- **Security remediation, before any UI work:** switch
  `src/tools/web/readable.ts` and `src/tools/web/providers/duckduckgo.ts` to
  `import * as cheerio from "cheerio/slim"`, then prove `npm ls undici` is empty. Run
  `npm audit fix` for the three dev-chain advisories.
- **Edit** `.github/workflows/ci.yml`: `node-version` from `20` to `[22, 24]`.
- Run the §7 deprecation sweep: `npm audit`, `npm audit --omit=dev`, `npm outdated`,
  captured `npm WARN deprecated` lines, and `node --throw-deprecation` on a scripted run.

Gate additions: `npm audit` and `npm audit --omit=dev` both report zero advisories; the
existing web-tool tests still pass after the cheerio change.

**Spikes** under `classic-revamp/spikes/`, deleted after each finding becomes a test:

| ID | Question | Method | Fallback if it fails |
|---|---|---|---|
| S1 | Does Ink 7.1.1 render under Node 22, Node 24, current Node, and Bun with React 19.2.8? And is the Ink 7 API still what this plan assumes — `<Static items>` append semantics, `render` accepting `exitOnCtrlC`/`patchConsole`/`stdin`/`stdout`, `borderStyle` accepting `round` and `classic`, no deprecation warning on mount? | render a box + border + CJK + emoji + a `<Static>` append, capture frames on each runtime | any API difference: record the real shape and adapt the spec; do not guess from Ink 6 |
| S2 | Streaming throughput | 10,000 synchronous store deltas → count committed frames and wall time | tune coalescing, re-measure |
| S3 | **`<Static>` interleaving** | [03-RENDER-MODEL.md](03-RENDER-MODEL.md) §7, 200-iteration fuzz | the `commitLines` fallback in §7 |
| S4 | Unmount → child process → remount | run `$EDITOR` equivalent, assert clean remount | keep the pager read-only; drop `e` export |
| S5 | Raw input decoding | feed CSI-u, Alt+Enter, Ctrl+J, Ctrl+H, SGR mouse, bracketed paste through the decoder prototype | none; the decoder is mandatory |
| S6 | Bun compile import graph | `bun build --compile --target bun-windows-x64`, inspect module count and native artifacts | split entrypoints (W15) |
| S7 | Frame height control | assert Ink's frame height equals a computed row budget at rows 8/24/50 | reduce budget by one row and re-verify |

**Gate:** every spike has a recorded result. S1, S3, and S5 have a decision. `npm audit` and
`npm audit --omit=dev` are clean. `npm run typecheck` and `npx vitest run` are green on
Node 22 and Node 24. No production file changed except `package.json`,
`package-lock.json`, `.github/workflows/ci.yml`, and the two cheerio import lines.

---

## W01 — Extract the command catalogue

Removes the app layer's dependency on the classic REPL.

- **Move** `src/repl/slash-commands.ts` → `src/app/commands/catalog.ts` with all exports:
  `SlashCommand`, `slashCommands`, `knownModels`, `getKnownModels`,
  `inferProviderForModel`, `looksLikeSlashCommand`, `slashCommandLabel`,
  `slashCommandFilter`, `getSlashCommandSuggestions`, `isKnownSlashCommand`.
- **Edit** `src/app/commands/registry.ts:1`, `src/tui-v2/app/commands/picker-commands.ts:21`,
  `src/tui/input-history.ts:1` to import from the new path. `input-history.ts` currently
  imports `isKnownSlashCommand` from `src/repl.js`; point it at the catalogue.
- **Edit** the catalogue to add `/jobs` (`usage: "/jobs"`,
  `description: "background jobs and responder status"`). It already has a handler and a
  Ctrl+J binding but is unreachable as a typed command.
- **Edit** `src/repl.ts` to import from the catalogue so it keeps working until W16.
- **New** `test/app/catalog.test.ts`: every command in the catalogue resolves through
  `CommandRegistry`; every alias resolves; `/jobs` resolves; `looksLikeSlashCommand("/etc/hosts")`
  is false; unique-prefix matching is unchanged.
- **New** guard in `test/app/architecture-guard.test.ts`: no file under `src/app` imports
  `src/repl`.

**Gate:** `npx vitest run test/app test/tui-v2 test/mentions.test.ts` and
`npm run typecheck`.

---

## W02 — Create `src/ui-core`

The largest package. Twelve clusters from
[02-ARCHITECTURE.md](02-ARCHITECTURE.md) §"extraction manifest", one commit each.

- **New** `test/ui-core/architecture.test.ts` **first**: no file under `src/ui-core` imports
  `ink`, `@opentui/*`, or contains `process.stdout.write`; `src/ui-core/react/**` may import
  `react`.
- **Move** clusters 1–10 in order. After each: rewrite imports, run
  `npx vitest run test/tui-v2 test/app test/ui-core`, `npm run typecheck`.
- **Edit** cluster 11: extract `status-segments.ts` from
  `components/status/status-line.tsx` and `context-limit.ts` from
  `components/status/context-limit-chip.tsx`; OpenTUI renders the extracted models.
- **Edit** the `AnsiLine[]` seam: `render-markdown-lines.ts` and `streaming-markdown.ts`
  return `readonly string[]`; **new** `src/tui-v2/rendering/styled-markdown.ts` applies
  `ansiToStyledText`. This is the only behaviour-adjacent edit in W02 and needs its own
  before/after frame comparison for one streaming assistant message.
- **Edit** cluster 12: delete every temporary re-export shim.

**Gate:** all of `test/tui-v2` and `test/app` green, unchanged in content;
`npm run typecheck`; `npm run test:bun`; OpenTUI launched manually and exercised through
one full turn with a tool call, a diff, the plan pane, a picker, and the pager. Record what
was exercised.

---

## W03 — Launch selection

- **Move** `ui-selection.ts` to `src/ui-core/bootstrap/` (already done in W02 cluster 8);
  **edit** it to the three-member `UiChoice`, the alias table, and the corrected precedence
  from [07-PLATFORM-PACKAGING.md](07-PLATFORM-PACKAGING.md) §1.
- **New** `defaultUiForPlatform` in the same file, pure and input-injected.
- **Edit** `src/index.ts`: widen `--ui` choices to
  `["tui","v2","classic","legacy","ink"]`; restructure `oneShot` per §3 of that document;
  add the `warnOnce` helper. `startClassic` is a dynamic import of a stub that throws
  `classic frontend not built yet` until W04.
- **Edit** `src/commands/doctor.ts` to report the resolved frontend and why.
- **New** `test/ui-core/ui-selection.test.ts`: full precedence cross-product;
  `--classic` beats `CLAI_UI=tui`; `--ui classic` parses; `defaultUiForPlatform` table for
  win32/darwin/linux × TTY/non-TTY × sizes.

**Gate:** `npx vitest run test/ui-core test/tui-v2` and `npm run typecheck`. OpenTUI still
launches by default on macOS/Linux. `--classic` prints the stub error, proving the branch is
reached without loading OpenTUI.

---

## W04 — Ink bootstrap and lifecycle

An empty but correctly-living frontend.

- **New** `src/classic/bootstrap/terminal-session.ts` — the only byte writer; `enter`,
  `attachInput`, `detachInput`, `leave`, all idempotent; sequences per
  [03-RENDER-MODEL.md](03-RENDER-MODEL.md) §2.
- **New** `src/classic/bootstrap/suspend-port.ts` — `RendererSuspendPort` via
  unmount/remount.
- **New** `src/classic/bootstrap/osc52-renderer.ts` — `Osc52RendererPort`.
- **New** `src/classic/bootstrap/start-classic.tsx` — capabilities, composition root,
  `attachCommandHandlers`, `RendererHandle`, `RendererLifecycle` with the three disposers,
  console guard, `render(..., { exitOnCtrlC: false, patchConsole: false })`.
- **New** `src/classic/app/ClassicApp.tsx` — status row and exit only.
- **New** `test/classic/architecture.test.ts` — no `@opentui/*`, no `src/tui-v2` import, no
  `useInput`, no `process.stdout.write` outside `bootstrap/terminal-session.ts`.
- **New** `test/classic/lifecycle.test.ts` — normal exit, double Ctrl+C, SIGTERM, SIGHUP,
  thrown error, and failed start each restore the terminal exactly once and dispose services
  exactly once, with fake streams.

**Gate:** `npx vitest run test/classic test/tui-v2` and `npm run typecheck`. Manual:
`clai --classic` starts, shows a status row, exits cleanly, and leaves the terminal usable
(cursor visible, echo working, no stray sequences).

---

## W05 — Input

- **New** `src/classic/input/{terminal-sequences,key-event,raw-decoder,chord-from-key,paste-decoder,sgr-mouse,input-router}.ts`.
- **New** `test/classic/input/raw-decoder.test.ts`, `raw-decoder.fuzz.test.ts`,
  `chord-table.test.ts` (enumerates `defaultKeymap`), `paste.test.ts`,
  `sgr-mouse.test.ts`, `focus-routing.test.ts`, `double-press.test.ts`.
- **New** `test/classic/input/fixtures/windows/*.json` — placeholder files with a skip
  marker until W17 records real captures.

**Gate:** every `defaultKeymap` binding has a passing decoder path. Fuzz test green over
10,000 cases. `npm run typecheck`.

---

## W06 — Chrome skeleton

- **New** `src/classic/chrome/row-budget.ts` plus `Chrome.tsx` rendering placeholder boxes
  at the allocated heights.
- **New** `test/classic/chrome/row-budget.test.ts` — the property test, the monotonicity
  test, and the golden table for rows 1–10 from
  [03-RENDER-MODEL.md](03-RENDER-MODEL.md) §8.
- **New** `test/classic/chrome/frame-height.test.ts` — captured Ink frame height equals
  `ChromeLayout.total` at rows 8/12/24/50.

**Gate:** the two new test files green at every size. Resize during a manual run never
scrolls the terminal or leaves a stale row.

---

## W07 — Feed

Blocked on S3.

- **New** `src/classic/render/{glyphs,ink-theme,ansi-text,wrap,measure}.ts`.
- **New** `src/classic/feed/{feed-blocks,block-height,live-tail-policy,commit-ledger}.ts`.
- **New** `src/classic/feed/{Feed,FeedStatic,LiveTail}.tsx`.
- **New** `src/classic/blocks/*.tsx` — nine block components per
  [04-UI-SPEC.md](04-UI-SPEC.md) §3.
- **New** `test/classic/feed/feed-blocks.test.ts` — golden fixtures at widths
  40/48/68/80/96/120/200, `colorMode` truecolor and none, unicode and ASCII.
- **New** `test/classic/feed/commit-ledger.test.ts` — the four rules, each isolated.
- **New** `test/classic/feed/invariants.test.ts` — the six assertions from §12 of the render
  model, run over every golden fixture.

**Gate:** the invariant test is green. Manual: a scripted turn with assistant text, three
tools, a failure, a blocked tool, a diff, a batch, and a compaction renders with no
duplicated, missing, or overflowing row, at 80 and at 44 columns.

---

## W08 — Composer

- **New** `src/classic/chrome/{editor-model,editor-view,composer-frame}.ts` and
  `Composer.tsx`.
- **New** `src/classic/panels/CompletionPanel.tsx`.
- Reuse `ui-core/composer/*` for history, completion, mentions, paste placeholders, height,
  draft actions, and secret buffering. Write no new policy.
- **New** `test/classic/composer/editor-model.test.ts` — grapheme-aware cursor movement,
  insert, delete, word ops, home/end, multiline navigation, CJK and emoji widths.
- **New** `test/classic/composer/completion.test.ts` — slash aliases, unique prefixes,
  `@` mentions for files/dirs/images, absolute paths treated as prompts.
- **New** `test/classic/composer/paste.test.ts` — bounded placeholder, expansion at submit,
  no shortcut interpretation.
- **New** `test/classic/composer/history.test.ts` — up/down browse, draft restore, the
  `arrow-intent` policy.

**Gate:** the four test files green. Manual: type, wrap, Shift/Alt+Enter, paste 500 lines,
`@`-mention a file, walk history, clear with Ctrl+X, cut with Ctrl+Shift+X, resize
mid-draft.

---

## W09 — Status, toasts, queue, responder

- **New** `src/classic/chrome/{StatusBar,ToastRow,QueuePanel,ResponderStrip}.tsx` driven by
  `ui-core/rendering/status-segments.ts`, `idleHintIds`, `contextChipForDensity`,
  `responder-status.ts`.
- **New** `test/classic/chrome/status-density.test.ts` — golden rows at widths
  40/48/68/96/120 for idle, running, armed-cancel, queued, and compacting states.
- **New** `test/classic/chrome/toast.test.ts` — max two rows, `(+1)` overflow marker,
  same-key replacement, no reflow of the feed.

**Gate:** both files green. Manual: Shift+Tab cycles mode and the badge updates; the context
chip colour crosses its thresholds; API-key rotation toasts never stack.

---

## W10 — Panels

- **New** `src/classic/panels/PanelFrame.tsx` and `panel-host.tsx`.
- **New** `PickerPanel`, `PagerPanel`, `JobsPanel`, `PlanPanel`, `ConfirmPanel`,
  `SecretPanel`, `ScopePanel`, `KeysPanel`, `PromptActionsPanel`, `SearchPanel` per
  [04-UI-SPEC.md](04-UI-SPEC.md) §5.
- **New** `test/classic/panels/*.test.ts` — one per panel, asserting rendered rows, key
  handling, and the resulting controller call. Plus `overlay-stacking.test.ts` for
  pager-over-confirm and pager-over-jobs restore, and `secret.test.ts` for the no-leak
  assertions.

**Gate:** every panel test green. Manual: every overlay opens, is keyboard-operable, closes,
and restores focus; `v` on a delete confirm previews without resolving; `p` on a plan confirm
shows detail without resolving.

---

## W11 — Wiring

- **New** `src/classic/app/action-handlers.ts` — one function per `ActionId` group.
- **New** `src/classic/app/app-wiring.ts` — turn-end subscription, plan approval, queue
  drain, jobs subscription, Esc auto-disarm, startup update toast, the 1 Hz tick, the
  resize listener, the repaint scheduler.
- **Edit** `ClassicApp.tsx` to compose feed, chrome, and panel host. Keep it under 150
  lines; it should read as a layout, not a controller.
- **New** `test/classic/app/actions.test.ts` — every `ActionId` reachable in classic maps to
  the expected controller call, table-driven over `ACTION_IDS`.
- **New** `test/classic/app/feed-behaviour.test.ts` — the §10 action remapping table from
  the render model.

**Gate:** both files green. Manual: a full agent turn end to end, including a confirm, a
queued follow-up, an abort, and `/compact`.

---

## W12 — Command parity

- **Edit** nothing in `ui-core/commands/*` beyond what W02 moved. Classic must work with the
  handlers as they are; any handler change is a shared change and needs an OpenTUI check.
- **New** `test/classic/commands.test.ts` — for every command in the catalogue, dispatch it
  in a classic harness and assert the resulting service state or overlay kind. Not merely
  that the name resolves.

**Gate:** every catalogue command exercised. `/jobs` opens the jobs panel. `/help` and
`/shortcuts` open the pager with generated content.

---

## W13 — Session, history, persistence

- **New** `test/classic/session.test.ts` — save, autosave, `--no-history`, private mode,
  `/history` resume with `hydrateFromClassicTranscript` restoring tools, diffs, thinking,
  and compaction cards, and shutdown flush ordering.
- **New** `test/classic/cross-renderer-history.test.ts` — a session written by the OpenTUI
  harness resumes identically in the classic harness and vice versa.

**Gate:** both files green. Manual: start a session in OpenTUI, quit, resume it with
`--classic`, and confirm tools and diffs are present.

---

## W14 — Non-interactive surface and runner cleanup

Follows [06-ONESHOT.md](06-ONESHOT.md) exactly, including the seven-step removal sequence.

- **New** `src/noninteractive/{start-noninteractive,stream-renderer,stream-blocks,stream-spinner,stdio-confirm-port}.ts`.
- **Edit** `src/index.ts` `oneShot` to use it; add `--show-thinking`, `--verbose`,
  `--quiet`; implement the exit codes.
- **Edit** `src/modes/agent.ts` to stop double-rendering the outcome.
- **Edit** `src/agent/runner.ts` to remove `writesDirectly` and every direct write.
- **Edit** `src/agent/confirm-port.ts`, `src/agent/plan-decision.ts`,
  `src/commands/providers.ts`, `src/commands/search-providers.ts` off
  `@inquirer/prompts`.
- **New** the eight test files from [06-ONESHOT.md](06-ONESHOT.md) §7.
- **Delete** `src/ui/spinner.ts`, and `src/ui/output-pane.ts` / `src/ui/ansi-box.ts` if
  nothing else imports them.

**Gate:** golden before/after comparison for the scripted turn, recorded in the report.
`npx vitest run` fully green. `@inquirer/prompts` absent from `package.json` and the
lockfile. `test/agent/runner-no-direct-writes.test.ts` green.

---

## W15 — Packaging

- **Edit** `bin/postinstall.mjs` to skip Bun installation on win32.
- **Edit** `package.json` to drop `@opentui/core-win32-x64` and `@opentui/core-win32-arm64`
  from `optionalDependencies`.
- Run the S6/W15 Windows binary probe from
  [07-PLATFORM-PACKAGING.md](07-PLATFORM-PACKAGING.md) §5. Apply the split-entrypoint
  fallback only if it fails.
- **New** `test/install.test.ts` additions for the postinstall platform branch.
- Measure and record every size metric.

**Gate:** `npm run build`, `npm run compile`, `npm run release:verify` per artifact, the
Windows probe result, and the size table.

---

## W16 — Delete the line REPL

Only after W12 and W13 are green.

- **Delete** `src/repl.ts`, `src/repl/prompt-line.ts`, `src/repl/` directory,
  `src/agent/classic-renderer.ts`, `src/ui/banner.ts`, `src/ui/intro-card.ts`,
  `src/ui/keys.ts`, `test/classic-renderer.test.ts`, `test/classic-lifecycle.test.ts`.
- **Edit** `src/tui/state.ts` down to `TranscriptItem` and its member interfaces; move it to
  `src/app/ports/transcript-item.ts` and update the five importers.
- **Delete** the nine unreferenced files from [01-AUDIT.md](01-AUDIT.md) §6, each with a
  `grep` proof.
- **New** guard: no file under `src/` matches `from ".*repl`.

**Gate:** `npx vitest run` fully green. `npm run typecheck`. `npm run build`.
`grep -rn "repl" src/` returns nothing meaningful. Line-count delta recorded.

---

## W17 — Platform verification

- Windows runner: the [05-INPUT.md](05-INPUT.md) §10 checklist in Windows Terminal,
  PowerShell, cmd/conhost, and VS Code. Record each result as a decoder fixture and remove
  the skip markers from W05.
- macOS and Linux: PTY smoke via `scripts/pty-smoke.py`, extended to cover the classic
  frontend — start, send a prompt, abort, resize, exit, and assert the terminal state after.
- Extend `.github/workflows/ci.yml` with a `windows-latest` job running the classic test
  suite and the PTY smoke.

**Gate:** all three platforms recorded. CI green on all three.

---

## W18 — Documentation and release

- **Edit** `README.md`, `--help`, `describeUiDefault()`, `CONTRIBUTING.md`, release notes
  per [07-PLATFORM-PACKAGING.md](07-PLATFORM-PACKAGING.md) §7.
- **Edit** [09-PARITY.md](09-PARITY.md) — every deviation approved or closed.
- **Edit** [12-TASKS.md](12-TASKS.md) — all boxes checked.
- Final report: files changed, line-count delta, size delta, deviations, known limitations.

**Gate:** every gate in [10-TESTING.md](10-TESTING.md) §"Release gates" passed with recorded
output.

---

## Dependency graph

```
W00
 ├─► W01 ─► W02 ─► W03 ─► W04 ─► W05 ─► W06 ─► W07 ─► W08 ─┬─► W11 ─► W12 ─► W13 ─┐
 │                                            (needs S3)   │                       │
 │                                                W09 ─────┤                       │
 │                                                W10 ─────┘                       │
 └─► W14 (independent of the Ink surface; may run in parallel after W01)            │
                                                                                   ▼
                                                          W15 ─► W16 ─► W17 ─► W18
```

W14 depends only on W01 and the `AppEvent` stream, so it can be built in parallel with the
Ink surface. W16 must follow W12, W13, and W14 — deleting the REPL before the replacement is
proven leaves no fallback.
