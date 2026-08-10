# Task Tracker

The only place progress is recorded. Check a box only after running the validation command
named in [08-ROADMAP.md](08-ROADMAP.md) for that item. Never check a box because the code
looks right.

## W00 — Baseline and spikes

- [ ] Baseline recorded: `typecheck`, `vitest run`, `build`, `compile`, `test:bun`
- [ ] Baseline recorded: `npm pack --dry-run`, `du -sh dist`, `ls -l release/`, `src` line count, dep tree count
- [ ] Baseline recorded: `npm audit`, `npm audit --omit=dev`, `npm outdated`
- [ ] `npm view ink engines peerDependencies dependencies` output recorded
- [ ] `engines.node` raised to `>=22`; release-note entry drafted
- [ ] `ink@7.1.1` and `ink-testing-library@4.0.0` installed at exact pins, lockfile via npm
- [ ] `react` 19.2.8, `@types/react` 19.2.18, `@types/node` 26.2.0, `vitest` 4.1.10, `fast-check` 4.9.0, `tsx` 4.23.12
- [ ] `typescript` decision recorded (stay 6.0.3 unless the owner asks otherwise)
- [ ] `cheerio/slim` swap done in `readable.ts` and `duckduckgo.ts`; `npm ls undici` empty
- [ ] `npm audit fix` applied for the dev-chain advisories
- [ ] `npm audit` and `npm audit --omit=dev` both report zero advisories
- [ ] Deprecation sweep clean: no deprecated direct deps, no Node runtime deprecations, no Ink mount warning
- [ ] CI `node-version` moved to `[22, 24]`; green on both
- [ ] S1 Ink 7 renders on Node 22/24/current/Bun **and** the Ink 7 API matches the spec (`<Static>`, `render` options, `borderStyle`)
- [ ] S2 streaming throughput measured
- [ ] S3 `<Static>` interleaving — result and decision recorded
- [ ] S4 unmount → child process → remount verified
- [ ] S5 raw input decoding verified for CSI-u, Alt+Enter, Ctrl+J, Ctrl+H, SGR mouse, bracketed paste
- [ ] S6 Bun compile import graph inspected
- [ ] S7 frame height equals computed row budget at rows 8/24/50
- [ ] Spike directory removed; each finding captured as a test or a note in this directory

## W01 — Command catalogue

- [ ] `src/repl/slash-commands.ts` → `src/app/commands/catalog.ts` via `git mv`
- [ ] `registry.ts`, `picker-commands.ts`, `input-history.ts`, `repl.ts` import the new path
- [ ] `/jobs` added to the catalogue
- [ ] `test/app/catalog.test.ts` green
- [ ] `src/app` guard extended to forbid `src/repl` imports
- [ ] `test/app` + `test/tui-v2` + `typecheck` green

## W02 — `src/ui-core`

- [ ] `test/ui-core/architecture.test.ts` written first and green
- [ ] Cluster 1 actions moved; `test/tui-v2` green
- [ ] Cluster 2 controllers moved; `test/tui-v2` green
- [ ] Cluster 3 state + React hooks moved; `test/tui-v2` green
- [ ] Cluster 4 composer logic moved; `test/tui-v2` green
- [ ] Cluster 5 layout + motion moved; `test/tui-v2` green
- [ ] Cluster 6 pure rendering moved; `test/tui-v2` green
- [ ] Cluster 7 capabilities + lifecycle moved; `test/tui-v2` green
- [ ] Cluster 8 composition root + ports moved; `test/tui-v2` green
- [ ] Cluster 9 command handlers + plan moved; `test/tui-v2` green
- [ ] Cluster 10 React providers moved; `test/tui-v2` green
- [ ] Cluster 11 `status-segments.ts` and `context-limit.ts` extracted; OpenTUI consumes them
- [ ] `AnsiLine[]` seam done; `styled-markdown.ts` added; before/after frame comparison recorded
- [ ] Cluster 12 all re-export shims deleted
- [ ] `test/tui-v2` and `test/app` green and unchanged in content
- [ ] `npm run test:bun` green
- [ ] Manual OpenTUI walkthrough recorded

## W03 — Launch selection

- [ ] `UiChoice` is `"tui" | "classic" | "noninteractive"`
- [ ] Alias table implemented
- [ ] Precedence corrected: explicit flags beat environment
- [ ] `defaultUiForPlatform` added, pure and injected
- [ ] `--ui` choices widened in `src/index.ts`
- [ ] `oneShot` restructured; `warnOnce` added
- [ ] `doctor` reports the resolved frontend and why
- [ ] `test/ui-core/ui-selection.test.ts` green, including both current defects
- [ ] `--classic` reaches the stub without loading OpenTUI

## W04 — Bootstrap and lifecycle

- [ ] `terminal-session.ts` with idempotent `enter`/`attachInput`/`detachInput`/`leave`
- [ ] `suspend-port.ts` and `osc52-renderer.ts`
- [ ] `start-classic.tsx` with composition root, command handlers, lifecycle, console guard
- [ ] `ClassicApp.tsx` minimal shell
- [ ] `test/classic/architecture.test.ts` green
- [ ] `test/classic/lifecycle.test.ts` green for all six exit paths
- [ ] Manual: `clai --classic` starts and exits leaving the terminal clean

## W05 — Input

- [ ] `raw-decoder.ts` implements all eight rules
- [ ] `chord-from-key.ts` covers the full mapping table
- [ ] `paste-decoder.ts` and `sgr-mouse.ts`
- [ ] `input-router.ts` implements the nine-step ownership order
- [ ] Double-press ladders with the OpenTUI constants
- [ ] `chord-table.test.ts` enumerates `defaultKeymap` and is green
- [ ] `raw-decoder.fuzz.test.ts` green over 10,000 cases
- [ ] `paste.test.ts`, `sgr-mouse.test.ts`, `focus-routing.test.ts`, `double-press.test.ts` green

## W06 — Chrome skeleton

- [ ] `row-budget.ts` implements the nine-step allocator with the specified constants
- [ ] `row-budget.test.ts` property test green for rows 1–200
- [ ] Golden table for rows 1–10 recorded
- [ ] `frame-height.test.ts` green at rows 8/12/24/50
- [ ] Manual resize causes no scroll and leaves no stale row

## W07 — Feed

- [ ] S3 decision applied
- [ ] `glyphs.ts`, `ink-theme.ts`, `ansi-text.ts`, `wrap.ts`, `measure.ts`
- [ ] `feed-blocks.ts` with the exact-height invariant
- [ ] `block-height.ts`, `live-tail-policy.ts`, `commit-ledger.ts`
- [ ] `Feed.tsx`, `FeedStatic.tsx`, `LiveTail.tsx`
- [ ] Nine block components
- [ ] `feed-blocks.test.ts` golden fixtures across the required matrix
- [ ] `commit-ledger.test.ts` covers all four rules
- [ ] `invariants.test.ts` green over every fixture
- [ ] Manual: scripted turn renders correctly at 80 and 44 columns

## W08 — Composer

- [ ] `editor-model.ts` grapheme-aware
- [ ] `editor-view.ts` with the inverse-cell caret
- [ ] `composer-frame.ts`, `Composer.tsx`
- [ ] `CompletionPanel.tsx`
- [ ] Reuses `ui-core/composer/*` with no new policy
- [ ] `editor-model.test.ts`, `completion.test.ts`, `paste.test.ts`, `history.test.ts` green
- [ ] Manual: wrap, Shift/Alt+Enter, 500-line paste, `@`-mention, history, Ctrl+X, Ctrl+Shift+X, resize mid-draft

## W09 — Status, toasts, queue, responder

- [ ] `StatusBar.tsx` driven by `status-segments.ts` and `idleHintIds`
- [ ] `ToastRow.tsx` with the two-row cap and `(+1)` marker
- [ ] `QueuePanel.tsx`, `ResponderStrip.tsx`
- [ ] `status-density.test.ts` golden rows at five widths and five states
- [ ] `toast.test.ts` green
- [ ] Manual: Shift+Tab, context chip thresholds, no stacked rotation toasts

## W10 — Panels

- [ ] `PanelFrame.tsx` and `panel-host.tsx`
- [ ] Picker, Pager, Jobs, Plan, Confirm, Secret, Scope, Keys, PromptActions, Search
- [ ] One test per panel, asserting rows, keys, and controller calls
- [ ] `overlay-stacking.test.ts` green for pager-over-confirm and pager-over-jobs
- [ ] `secret.test.ts` no-leak assertions green
- [ ] Manual: every overlay opens, operates, closes, restores focus

## W11 — Wiring

- [ ] `action-handlers.ts` per action group
- [ ] `app-wiring.ts` with turn-end, plan approval, queue drain, jobs, Esc disarm, update toast, 1 Hz tick, resize, repaint scheduler
- [ ] `ClassicApp.tsx` under 150 lines
- [ ] `actions.test.ts` enumerates `ACTION_IDS` and is green
- [ ] `feed-behaviour.test.ts` green
- [ ] Manual: full turn with confirm, queued follow-up, abort, `/compact`

## W12 — Command parity

- [ ] `test/classic/commands.test.ts` covers every catalogue command with a state assertion
- [ ] `/jobs` opens the jobs panel
- [ ] `/help` and `/shortcuts` open the pager with generated content
- [ ] No handler changed without an OpenTUI re-check

## W13 — Session and history

- [ ] `session.test.ts` covers save, autosave, `--no-history`, privacy, resume, flush order
- [ ] `cross-renderer-history.test.ts` green both directions
- [ ] Manual: start in OpenTUI, resume with `--classic`, tools and diffs present

## W14 — Non-interactive and runner cleanup

- [ ] `src/noninteractive/*` implemented
- [ ] `oneShot` uses it; `--show-thinking`, `--verbose`, `--quiet` added
- [ ] Exit codes 0 / 130 / 1
- [ ] `src/modes/agent.ts` no longer double-renders
- [ ] Golden before/after comparison recorded for the scripted turn
- [ ] `writesDirectly` and every direct write removed from `src/agent/runner.ts`
- [ ] `runner-no-direct-writes.test.ts` green
- [ ] `confirm-port.ts`, `plan-decision.ts`, `providers.ts`, `search-providers.ts` off inquirer
- [ ] `@inquirer/prompts` removed from `package.json` and the lockfile
- [ ] Eight `test/noninteractive/*` files green
- [ ] `src/ui/spinner.ts` deleted; `output-pane.ts` and `ansi-box.ts` deleted or justified

## W15 — Packaging

- [ ] `bin/postinstall.mjs` skips Bun install on win32
- [ ] `@opentui/core-win32-x64` and `-win32-arm64` removed from `optionalDependencies`
- [ ] `@opentui/keymap` removed from `dependencies`; quality guard updated
- [ ] Windows binary probe run and recorded
- [ ] Split entrypoints applied only if the probe failed
- [ ] `test/install.test.ts` covers the postinstall platform branch
- [ ] `build`, `compile`, `release:verify` green for all five targets
- [ ] Size metrics recorded

## W16 — Delete the line REPL

- [ ] `src/repl.ts`, `src/repl/`, `src/agent/classic-renderer.ts` deleted
- [ ] `src/ui/banner.ts`, `src/ui/intro-card.ts`, `src/ui/keys.ts` deleted
- [ ] `test/classic-renderer.test.ts`, `test/classic-lifecycle.test.ts` deleted
- [ ] `src/tui/state.ts` trimmed and moved to `src/app/ports/transcript-item.ts`; five importers updated
- [ ] Nine dead files deleted, each with a `grep` proof
- [ ] `tools/reducers/generic.ts` and `safety/path-permissions.ts` verified before removal
- [ ] Guard added: no `src/` file imports `src/repl`
- [ ] `vitest run`, `typecheck`, `build` green
- [ ] Line-count delta recorded

## W17 — Platform verification

- [ ] Windows Terminal key checklist recorded as fixtures
- [ ] PowerShell 5.1 and 7 recorded
- [ ] cmd.exe / conhost recorded, including `unicode: false`
- [ ] VS Code Windows terminal recorded
- [ ] Bracketed paste of 500 lines in each host
- [ ] Resize during a running turn in each host
- [ ] W05 fixture skip markers removed
- [ ] PTY smoke extended and green on macOS and Linux
- [ ] `windows-latest` CI job added and green

## W18 — Documentation and release

- [ ] `README.md` frontend section and flag table updated
- [ ] `--help` text updated for `--ui`, `--classic`, `--tui`, and the three one-shot flags
- [ ] `describeUiDefault()` updated
- [ ] `CONTRIBUTING.md` documents the `src/ui-core` boundary and dependency rules
- [ ] Release notes cover the exit-code change, the stdout/stderr split, and the REPL removal
- [ ] [09-PARITY.md](09-PARITY.md) fully checked; deviations limited to the approved table
- [ ] All 17 release gates in [10-TESTING.md](10-TESTING.md) passed with recorded output
- [ ] Final report: files changed, line delta, size delta, deviations, known limitations

## Deviation log

Add a row whenever a new deviation is discovered. Nothing ships with an unapproved row.

| ID | Discovered in | Description | Alternative | Approved |
|---|---|---|---|---|
| D-01 … D-08 | planning | see [09-PARITY.md](09-PARITY.md) | documented | yes |
