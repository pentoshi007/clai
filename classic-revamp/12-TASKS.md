# Task Tracker

The only place progress is recorded. Check a box only after running the validation command
named in [08-ROADMAP.md](08-ROADMAP.md) for that item. Never check a box because the code
looks right.

## W00 — Baseline and spikes

- [x] Baseline recorded: `typecheck`, `vitest run`, `build`, `compile`, `test:bun` — [BASELINE.md](BASELINE.md)
- [x] Baseline recorded: `npm pack --dry-run`, `du -sh dist`, `ls -l release/`, `src` line count, dep tree count
- [x] Baseline recorded: `npm audit`, `npm audit --omit=dev`, `npm outdated`
- [x] `npm view ink engines peerDependencies dependencies` output recorded — `7.1.1`, `node >=22`, `react >=19.2.0`, `yoga-layout ~3.2.1`; matches the plan exactly
- [x] `engines.node` raised to `>=22`; release-note entry drafted (W18)
- [x] `ink@7.1.1` and `ink-testing-library@4.0.0` installed at exact pins, lockfile via npm
- [x] `react` 19.2.8, `@types/react` 19.2.18, `@types/node` 26.2.0, `vitest` 4.1.10, `fast-check` 4.9.0, `tsx` 4.23.12
- [x] `typescript` decision recorded — stays 6.0.3
- [x] `cheerio/slim` swap done in `readable.ts` and `duckduckgo.ts`; **`npm ls undici` is not empty** — see the finding below
- [x] `npm audit fix` applied for the dev-chain advisories
- [x] `npm audit` and `npm audit --omit=dev` both report zero advisories
- [x] Deprecation sweep clean: no deprecated direct deps, no Node runtime deprecations under `--throw-deprecation`, no Ink mount warning
- [x] CI `node-version` moved to `[22, 24]`; typecheck + full suite green on both locally
- [x] S1 Ink 7 renders on Node 22/24/26/Bun **and** the Ink 7 API matches the spec — [SPIKES.md](SPIKES.md) §S1
- [x] S2 streaming throughput measured — 10,000 deltas → 1 notification → 6 writes
- [x] S3 `<Static>` interleaving — historical scrollback-feed result recorded; its `rows - 1` conclusion is superseded by the W17 full-height alternate-screen shell
- [x] S4 unmount → child process → remount verified; `suspendTerminal()` found and preferred
- [x] S5 raw input decoding verified against Ink 7 — decoder confirmed mandatory
- [x] S6 Bun compile import graph inspected — `opentui.dll` is embedded in the Windows binary
- [x] S7 frame height equals computed row budget at rows 8/12/24/50
- [x] Spike directory removed; every finding captured in [SPIKES.md](SPIKES.md)

### W00 findings that change later packages

1. **Historical S3 was load-bearing only for the discarded normal-scrollback feed.** Ink 7 clears
   the terminal and replays all `<Static>` history when that old dynamic frame reaches the
   terminal row count. That result remains recorded for the scrollback experiment, but W17
   now owns a fresh alternate screen in `TerminalSession` and intentionally allocates the
   full height. W06's active invariant is `ChromeLayout.total <= rows`; the old
   `rows - 1` requirement and the `commitLines` fallback are superseded.
2. **Historical S7 measured the old unbounded bordered-box geometry.** The current classic
   shell computes `horizontalPadding()` / `innerShellWidth()` once and passes the bounded
   width to every surface, so the old `width={columns - 2}` prescription is superseded by
   the shared shell-width contract. The invariant that no content crosses the shell or
   terminal boundary remains active.
3. **S6: the Windows binary embeds `opentui.dll`.** The W15 split-entrypoint fallback is
   likely, not remote.
4. **S1: `useApp().suspendTerminal()` exists** and is the preferred `RendererSuspendPort`
   implementation in W04, with S4's unmount/remount as the proven fallback. `maxFps`,
   `incrementalRendering`, `interactive`, and `waitUntilRenderFlush()` are also available;
   `alternateScreen` and `concurrent` must stay `false`.
5. **S5 corrects three rows of the 05-INPUT §1 table for Ink 7**: CSI-u *is* decoded by
   `parseKeypress` (but carries `text: "\r"` and leaks as raw text through
   `createInputParser`), Alt+Enter is one event with `meta: true`, and `0x7F` reports
   `backspace`. Ctrl+J, Ctrl+H, and SGR mouse are unchanged and still decisive.
6. **`npm ls undici` cannot be empty.** `cheerio@1.2.0` declares `undici` in
   `dependencies`, so npm installs it regardless of which subpath is imported; the plan's
   assertion was not achievable as written. The `cheerio/slim` swap still removes it from
   the *runtime* graph, and the audit gate is met for a different reason: `undici@7.29.0`
   has since been published and is patched, so the 7.x line did not end at 7.28.0 as
   13-DEPENDENCIES §4.1 recorded. No `overrides` entry was needed.
7. **`fast-uri` reaches production**, via `conf → ajv`, not dev-only as
   13-DEPENDENCIES §4 recorded. `npm audit fix` resolved it to 3.1.5.
8. **npm 12 requires an `allowScripts` allow-list** in `package.json` for `esbuild`,
   `fsevents`, and `node-pty`, or vitest cannot run. Toolchain requirement, not a
   migration change.

## W01 — Command catalogue

- [x] `src/repl/slash-commands.ts` → `src/app/commands/catalog.ts` via `git mv`
- [x] `registry.ts`, `picker-commands.ts`, `input-history.ts`, `repl.ts`, `prompt-line.ts` import the new path
- [x] `/jobs` added to the catalogue
- [x] `test/app/catalog.test.ts` green (9 cases); `test/infer-provider.test.ts` moved to `test/app/` with the module
- [x] `src/app` guard extended to forbid `src/repl` imports
- [x] `test/app` + `test/tui-v2` + `typecheck` green — 96 files / 749 tests; full suite 352 files / 2798 tests

## W02 — `src/ui-core`

- [x] `test/ui-core/architecture.test.ts` written first and green
- [x] Cluster 1 actions moved; `test/tui-v2` green
- [x] Cluster 2 controllers moved; `test/tui-v2` green
- [x] Cluster 3 state + React hooks moved; `test/tui-v2` green
- [x] Cluster 4 composer logic moved; `test/tui-v2` green
- [x] Cluster 5 layout + motion moved; `test/tui-v2` green
- [x] Cluster 6 pure rendering moved; `test/tui-v2` green
- [x] Cluster 7 capabilities + lifecycle moved; `test/tui-v2` green
- [x] Cluster 8 composition root + ports moved; `test/tui-v2` green
- [x] Cluster 9 command handlers + plan moved; `test/tui-v2` green
- [x] Cluster 10 React providers moved; `test/tui-v2` green
- [x] Cluster 11 `status-segments.ts` and `context-limit.ts` extracted; OpenTUI consumes them
- [x] `AnsiLine[]` seam done; `styled-markdown.ts` added; before/after frame comparison recorded
- [x] Cluster 12 all re-export shims deleted
- [x] `test/tui-v2` and `test/app` green and unchanged in content
- [x] `npm run test:bun` green
- [x] Manual OpenTUI walkthrough recorded

Record: `classic-revamp/W02-UI-CORE.md` (directory map, `AnsiLine[]` frame comparison, spike walkthrough, findings that change W03–W06).

## W03 — Launch selection

- [x] `UiChoice` is `"tui" | "classic" | "noninteractive"`
- [x] Alias table implemented
- [x] Precedence corrected: explicit flags beat environment
- [x] `defaultUiForPlatform` added, pure and injected
- [x] `--ui` choices widened in `src/index.ts`
- [x] `oneShot` restructured; `warnOnce` added
- [x] `doctor` reports the resolved frontend and why
- [x] `test/ui-core/ui-selection.test.ts` green, including both current defects
- [x] `--classic` reaches the stub without loading OpenTUI

Record: `classic-revamp/W03-LAUNCH-SELECTION.md` (alias table, precedence, platform default, doctor output, findings that change W04/W06/packaging).

## W04 — Bootstrap and lifecycle

- [x] `terminal-session.ts` with idempotent `enter`/`attachInput`/`detachInput`/`leave`
- [x] `suspend-port.ts` and `osc52-renderer.ts`
- [x] `start-classic.tsx` with composition root, command handlers, lifecycle, console guard
- [x] `ClassicApp.tsx` minimal shell
- [x] `test/classic/architecture.test.ts` green
- [x] `test/classic/lifecycle.test.ts` green for all six exit paths
- [x] Manual: `clai --classic` starts and exits leaving the terminal clean

Record: `classic-revamp/W04-BOOTSTRAP.md` (file map, emitted sequences, exit-path table, verification, findings that change W05/W06/W10/W15).

## W05 — Input

- [x] `raw-decoder.ts` implements all eight rules
- [x] `chord-from-key.ts` covers the full mapping table
- [x] `paste-decoder.ts` and `sgr-mouse.ts`
- [x] `input-router.ts` implements the nine-step ownership order
- [x] Double-press ladders with the OpenTUI constants
- [x] `chord-table.test.ts` enumerates `defaultKeymap` and is green
- [x] `raw-decoder.fuzz.test.ts` green over 10,000 cases
- [x] `paste.test.ts`, `sgr-mouse.test.ts`, `focus-routing.test.ts`, `double-press.test.ts` green

Record: `classic-revamp/W05-INPUT.md` (pipeline, decoder rule table, ownership order, ladder constants, findings that change W08/W09/W11/W17).

## W06 — Chrome skeleton

- [x] `row-budget.ts` implements the nine-step allocator with the specified constants
- [x] `row-budget.test.ts` property test green for rows 1–200
- [x] Full-height golden table for rows 1–10 recorded (`ChromeLayout.total <= rows`)
- [x] `frame-height.test.ts` green at rows 8/12/24/50 with the alternate-screen shell
- [ ] Manual host resize walkthrough with screenshots — unavailable; provider-independent macOS PTY evidence is tracked in W17/W18

Record: `classic-revamp/W06-CHROME.md` (golden table, one prose deviation in 03-RENDER-MODEL §8, resize measurements, findings that change W07/W08/W09/W17).

## W07 — Feed

- [x] S3 decision applied
- [x] `glyphs.ts`, `ink-theme.ts`, `ansi-text.ts`, `wrap.ts`, `measure.ts`
- [x] `feed-blocks.ts` with the exact-height invariant
- [x] `block-height.ts`, `live-tail-policy.ts`, `commit-ledger.ts`
- [x] `Feed.tsx`, `FeedStatic.tsx`, `LiveTail.tsx`
- [x] Nine block components
- [x] `feed-blocks.test.ts` golden fixtures across the required matrix
- [x] `commit-ledger.test.ts` covers all four rules
- [x] `invariants.test.ts` green over every fixture
- [x] Manual: scripted turn renders correctly at 80 and 44 columns

Record: `classic-revamp/W07-FEED.md` (block map, golden matrix, invariant table, two
deviations, findings that change W08–W11).

## W08 — Composer

- [x] `editor-model.ts` grapheme-aware
- [x] `editor-view.ts` with the inverse-cell caret
- [x] `composer-frame.ts`, `Composer.tsx`
- [x] `CompletionPanel.tsx`
- [x] Reuses `ui-core/composer/*` with no new policy
- [x] `editor-model.test.ts`, `completion.test.ts`, `paste.test.ts`, `history.test.ts` green
- [ ] Manual: wrap, Shift/Alt+Enter, 500-line paste, `@`-mention, history, Ctrl+X, Ctrl+Shift+X, resize mid-draft — deferred to W11, when input reaches the composer

Record: `classic-revamp/W08-COMPOSER.md` (file map, chord ownership table, verification
table, findings that change W09-W11).

## W09 — Status, toasts, queue, responder

- [x] `StatusBar.tsx` driven by `status-segments.ts` and `idleHintIds`
- [x] `ToastRow.tsx` with the two-row cap and `(+1)` marker
- [x] `QueuePanel.tsx`, `ResponderStrip.tsx`
- [x] `status-density.test.ts` golden rows at five widths and five states
- [x] `toast.test.ts` green
- [ ] Manual: Shift+Tab, context chip thresholds, no stacked rotation toasts — deferred to W11, when input and the tick reach the chrome

Record: `classic-revamp/W09-STATUS.md` (row model, density ladder evidence, findings that
change W10/W11).

## W10 — Panels

- [x] `PanelFrame.tsx` and `panel-host.tsx`
- [x] Picker, Pager, Jobs, Plan, Confirm, Secret, Scope, Keys, PromptActions, Search
- [x] One test per panel, asserting rows, keys, and controller calls
- [x] `overlay-stacking.test.ts` green for pager-over-confirm and pager-over-jobs
- [x] `secret.test.ts` no-leak assertions green
- [ ] Manual: every overlay opens, operates, closes, restores focus — deferred to W11, when overlays are wired to real input

Record: `classic-revamp/W10-PANELS.md` (file map, panel/controller flow, overlay-stacking and
secret-safety evidence, verification table, findings that change W11).

## W11 — Wiring

- [x] `action-handlers.ts` per action group
- [x] `app-wiring.ts` with turn-end, plan approval, queue drain, jobs, Esc disarm, update toast, 1 Hz tick, resize, repaint scheduler
- [x] `ClassicApp.tsx` under 150 lines
- [x] `actions.test.ts` enumerates `ACTION_IDS` and is green
- [x] `feed-behaviour.test.ts` green
- [ ] Manual: full turn with confirm, queued follow-up, abort, `/compact`

Record: `classic-revamp/W11-WIRING.md` (ownership map, action group table, §10 remapping evidence,
verification table, findings that change W12/W14).

## W12 — Command parity

- [x] `test/classic/commands.test.ts` covers every catalogue command with a state assertion
- [x] `/jobs` opens the jobs panel
- [x] `/help` and `/shortcuts` open the pager with generated content
- [x] No handler changed without an OpenTUI re-check

Record: `classic-revamp/W12-COMMANDS.md` (command coverage table, store sandboxing, queue-chord
binding that closes the W09/W11 dead-shortcut finding, verification table).

## W13 — Session and history

- [x] `session.test.ts` covers save, autosave, `--no-history`, privacy, resume, flush order
- [x] `cross-renderer-history.test.ts` green both directions
- [ ] Manual: start in OpenTUI, resume with `--classic`, tools and diffs present

Record: `classic-revamp/W13-SESSION.md` (write guards, resume assertions, flush ordering,
cross-renderer fingerprint table, verification table).

## W14 — Non-interactive and runner cleanup

- [x] `src/noninteractive/*` implemented
- [x] `oneShot` uses it; `--show-thinking`, `--verbose`, `--quiet` added
- [x] Exit codes 0 / 130 / 1
- [x] `src/modes/agent.ts` no longer double-renders
- [x] Golden before/after comparison recorded for the scripted turn
- [x] `writesDirectly` and every direct write removed from `src/agent/runner.ts`
- [x] `runner-no-direct-writes.test.ts` green
- [x] `confirm-port.ts`, `plan-decision.ts`, `providers.ts`, `search-providers.ts` off inquirer
- [x] `@inquirer/prompts` removed from `package.json` and the lockfile
- [x] Eight `test/noninteractive/*` files green
- [x] `src/ui/spinner.ts` deleted; `output-pane.ts` and `ansi-box.ts` deleted or justified

## W15 — Packaging

- [x] `bin/postinstall.mjs` skips Bun install on win32
- [x] `@opentui/core-win32-x64` and `-win32-arm64` removed from `optionalDependencies`
- [x] `@opentui/keymap` removed from `dependencies`; quality guard updated
- [ ] Windows binary probe run and recorded
- [ ] Split entrypoints applied only if the probe failed
- [x] `test/install.test.ts` covers the postinstall platform branch
- [x] `build`, `compile`, `release:verify` green for all five targets
- [x] Size metrics recorded

## W16 — Delete the line REPL

- [x] `src/repl.ts`, `src/repl/`, `src/agent/classic-renderer.ts` deleted
- [x] `src/ui/banner.ts`, `src/ui/intro-card.ts`, `src/ui/keys.ts` deleted
- [x] `test/classic-renderer.test.ts`, `test/classic-lifecycle.test.ts` deleted
- [x] `src/tui/state.ts` trimmed and moved to `src/app/ports/transcript-item.ts`; five importers updated
- [x] Nine dead files deleted, each with a `grep` proof
- [x] `tools/reducers/generic.ts` and `safety/path-permissions.ts` verified before removal
- [x] Guard added: no `src/` file imports `src/repl`
- [x] `vitest run`, `typecheck`, `build` green
- [x] Line-count delta recorded in `W16-CLEANUP.md`

Record: `classic-revamp/W16-CLEANUP.md` (REPL removal, transcript-port migration, runner cleanup, dead-file proof, architecture guard, line counts, and validation output).

## W17 — Platform verification

- [ ] Windows Terminal key checklist recorded as fixtures
- [ ] PowerShell 5.1 and 7 recorded
- [ ] cmd.exe / conhost recorded, including `unicode: false`
- [ ] VS Code Windows terminal recorded
- [ ] Bracketed paste of 500 lines in each host
- [ ] Resize during a running turn in each host
- [ ] W05 fixture skip markers removed
- [ ] PTY smoke extended and green on macOS and Linux, including full-height alternate-screen startup/teardown — Linux host evidence is unavailable in
      this checkout, and the CI result is not recorded as a local pass
- [x] Provider-independent POSIX PTY smoke passed locally on macOS; the smoke asserts
      alternate-screen on, clear/home, and off plus terminal restoration (exact output is
      recorded after the current run)
- [x] Genuine `classic-posix` Ubuntu/macOS matrix job added in `.github/workflows/ci.yml`;
      Windows CI is intentionally not claimed
- [x] Classic architecture/performance safeguards added and targeted tests passed:
      `npx vitest run test/classic/performance.test.ts test/classic/architecture.test.ts`
      plus the W17 terminal/lifecycle/install/selection/quality guard selection; 84 passed,
      10 skipped

## W18 — Documentation and release

- [x] `README.md` frontend section, platform notes, stdout/stderr semantics, exit-code text,
      and flag table updated
- [x] `--help` text reflects `--ui` aliases, `--classic`, `--tui`, `--show-thinking`,
      `--verbose`, and `--quiet`; verified from the current CLI source/help path
- [x] `describeUiDefault()` updated and `test/ui-core/ui-selection.test.ts` remains green
- [x] `CONTRIBUTING.md` documents the `src/app`/`src/ui-core` renderer-neutral boundary and
      dependency rules
- [x] Release notes cover the exit-code change, the stdout/stderr split, the line REPL
      removal, architecture/performance safeguards, clean build output, validation, metrics,
      and unavailable evidence — [W18-RELEASE.md](W18-RELEASE.md)
- [ ] [09-PARITY.md](09-PARITY.md) fully checked; unavailable Windows/Linux/manual/provider
      gates remain open
- [ ] All 17 release gates in [10-TESTING.md](10-TESTING.md) passed; the ledger records the
      verified automated subset and leaves target-host, manual, live-measurement, parity, and
      size-reduction gates open
- [x] Final report: files changed, line count, package/dist/binary/dependency measurements,
      size deltas, deviations, and known limitations — [W18-RELEASE.md](W18-RELEASE.md)

## Deviation log

Add a row whenever a new deviation is discovered. Nothing ships with an unapproved row.

| ID | Discovered in | Description | Alternative | Approved |
|---|---|---|---|---|
| D-01 … D-08 | planning | see [09-PARITY.md](09-PARITY.md) | documented | yes |
| D-09 | W00/W06 | Historical `rows = 1` prose versus the discarded `rows - 1` scrollback-feed property. The current full-height alternate-screen allocator returns `composer 1`, `total 1` at one row. | none — the old interpretation is superseded by W17 | superseded |
| D-10 | W05 | An unterminated bracketed paste is bounded by 250 ms **idle** rather than 250 ms since paste start, so a slow multi-megabyte paste is not split. Same bound on truly unterminated pastes. | absolute timeout, which splits large slow pastes | pending |
| D-11 | W07 | Tool cards show elapsed only when the transcript carries both ends of the span. `ToolItem` gained an optional `endedAt`, set on `tool-result`/`tool-blocked`, so live sessions match 04-UI-SPEC §3.5 (`done · 2.4s`); sessions resumed from history have no `endedAt` and render `done` with no elapsed. Blocked tools never show elapsed, matching the spec's own sample. | thread a start/end pair through persistence so resumed cards also show elapsed | pending |
| D-12 | W07 | 04-UI-SPEC §3.9 gives raw hex for the notice plates (`#D97706`, `#B91C1C`). Classic uses the `activityBg` / `failedBg` / `chip` theme tokens instead, which §4.3 already assigns to the same three severities for toasts, so the two surfaces cannot drift and §1's "never write a raw hex in a component" holds. | keep the raw hex and exempt notices from the no-hex rule | pending |
