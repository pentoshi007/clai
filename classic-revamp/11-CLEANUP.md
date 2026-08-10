# Cleanup and Size Reduction

Nothing here is deleted on sight. Every removal needs a `grep` proof in the completion
report plus a green `npx vitest run` in the same package.

## 1. Deletions — classic REPL (W16)

| Path | Lines | Blocked on |
|---|---|---|
| `src/repl.ts` | 2332 | W12, W13 green; `src/index.ts` no longer imports `startRepl` |
| `src/repl/prompt-line.ts` | 696 | above |
| `src/repl/slash-commands.ts` | 414 | W01 moved it to `src/app/commands/catalog.ts` |
| `src/repl/` directory | — | the two files above |
| `src/agent/classic-renderer.ts` | 151 | W14; its assertions move to `test/noninteractive/stream-blocks.test.ts` |
| `src/ui/banner.ts` | — | `repl.ts` and `prompt-line.ts` were the only importers |
| `src/ui/intro-card.ts` | — | `repl.ts` was the only importer; the intro card is `ui/intro-header.ts`, which stays |
| `src/ui/keys.ts` | — | `repl.ts` and `prompt-line.ts` were the only importers |
| `test/classic-renderer.test.ts` | — | its subject is gone |
| `test/classic-lifecycle.test.ts` | — | replaced by `test/classic/lifecycle.test.ts` |

Subtotal: about **3600 lines**.

## 2. Deletions — runner presentation (W14)

| Target | Approx. lines |
|---|---|
| `writesDirectly` constant and all 30 references in `src/agent/runner.ts` | 250–350 |
| `noopSpinner` stub | 6 |
| `src/ui/spinner.ts` | — |
| `src/ui/output-pane.ts` | — |
| `src/ui/ansi-box.ts` | — |

`src/ui/output-pane.ts` and `src/ui/ansi-box.ts` are also imported by
`src/agent/plan-decision.ts`. Convert that file to the shared overlay/pager ports in W14
before deleting either. If `plan-decision.ts` still needs a pager after the conversion, it
should call `overlay.openPager`, not own one.

`src/ui/spinner.ts` is replaced by `src/noninteractive/stream-spinner.ts`, which takes an
injected stream and is therefore testable.

## 3. Deletions — dead code (W16)

Confirmed to have zero importers in `src/`. Each still needs its own `grep -rn` proof
because a test may reference it.

| Path | Note |
|---|---|
| `src/ui/task-pane.ts` | superseded by `ui-core/rendering/plan-view.ts` |
| `src/tui-v2/bootstrap/disable-native-selection.ts` | no-op stub, 15 lines |
| `src/tui-v2/composer/newline-hint.ts` | superseded by `capabilities.canDistinguishShiftEnter` |
| `src/tui-v2/composer/history-nav.ts` | superseded by `prompt-history.ts` |
| `src/tui-v2/rendering/transcript-export.ts` | 27 lines, no importer |
| `src/app/adapters/current-terminal-adapter.ts` | no importer |
| `src/app/controllers/job-controller.ts` | superseded by the jobs port |
| `src/tools/reducers/generic.ts` | **verify against `src/tools/policies/output-policy.ts` first** — `pickReducer` may resolve it dynamically |
| `src/safety/path-permissions.ts` | **verify against `src/safety/classifier.ts` first** |

The last two are marked because a dynamic or re-exported reference would not show up in a
plain import grep. Prove with `grep -rn "path-permissions\|pathPermissions"` and by reading
`output-policy.ts`'s `pickReducer` before removing.

## 4. Trim `src/tui/state.ts` (W16)

643 lines, of which only `TranscriptItem` and its member interfaces (`UserItem`,
`AssistantItem`, `ThinkingItem`, `ToolItem`, `NoticeItem`, `PlanItem`, `CompactedItem`,
`ToolStatus`) are used, by five files:

- `src/app/adapters/current-store-adapter.ts:4`
- `src/app/controllers/session-controller.ts:31`
- `src/app/ports/persistence-port.ts:5`
- `src/store/history.ts:29`
- `src/tui-v2/state/transcript-hydrate.ts:10`

Zero importers: `TuiState`, `TuiAction`, `reducer`, `initialState`, `PendingConfirm`,
`TurnStatus`, and this file's own `serializeTranscriptForCompaction` (the live one is
`ui-core/state/transcript-compaction.ts`).

Action: `git mv src/tui/state.ts src/app/ports/transcript-item.ts`, delete everything except
the item types, update the five importers. About **500 dead lines** removed, and the app
layer stops depending on a directory named after a renderer.

`src/tui/` then contains only `can-use-tui.ts`, `runtime.ts`, `text-format.ts`,
`input-history.ts`, and `format-keys.ts`. W02 moves `text-format.ts` and `input-history.ts`
into `ui-core`. Verify `format-keys.ts`'s only importer is
`ui-core/commands/key-commands.ts` and move it too. `src/tui/` should end up holding just
`can-use-tui.ts` and `runtime.ts` — both genuinely about deciding whether OpenTUI can run —
or be renamed `src/opentui-runtime/` for clarity. Renaming is optional and must not be
bundled with a behaviour change.

## 5. Dependency removals

### `@inquirer/prompts` (W14)

Importers: `src/agent/confirm-port.ts`, `src/agent/plan-decision.ts`, `src/repl.ts`,
`src/commands/providers.ts`, `src/commands/search-providers.ts`.

- `src/repl.ts` disappears in W16.
- `confirm-port.ts` and `plan-decision.ts` move to `src/noninteractive/stdio-confirm-port.ts`
  and the shared overlay ports.
- `providers.ts` and `search-providers.ts` use inquirer for their own subcommand pickers.
  Convert both to the same `node:readline/promises` helpers.

Then remove the dependency from `package.json` and regenerate the lockfile with npm. This is
the single largest dependency-tree reduction available.

### `@opentui/core-win32-x64`, `@opentui/core-win32-arm64` (W15)

Remove from `optionalDependencies`. OpenTUI is unreachable on Windows through both
`defaultUiForPlatform` and `canUseTui`, so these binaries are downloaded on every Windows
install and never loaded. Keep them in `scripts/install-opentui-platforms.mjs`, which exists
precisely because `bun build --compile` resolves dynamic imports at build time and needs the
tarballs on the build host.

### `@opentui/keymap` — confirmed unreferenced

Listed in `dependencies` but referenced nowhere in `src/`. The only mention is
`test/tui-v2/quality-guard.test.ts:38`, which asserts version alignment across the three
`@opentui` packages. Confirm with `grep -rn "@opentui/keymap" src` returning nothing, then
remove it from `dependencies` and drop it from that test's list. Small win, zero risk.

### `@opentui/keymap` (W15)

In `dependencies` but referenced nowhere in `src/`. See §5 above — remove it and drop it from
the `test/tui-v2/quality-guard.test.ts` version-alignment list.

### `undici`, via `cheerio` (W00)

Not a removal from `package.json` — a removal from the runtime graph. `cheerio` stays;
importing `cheerio/slim` instead of `cheerio` drops the `undici` edge and with it four high
-severity advisories that currently ship.
See [13-DEPENDENCIES.md](13-DEPENDENCIES.md) §4.1.

### Additions

`ink@7.1.1` in `dependencies`, `ink-testing-library@4.0.0` in `devDependencies`. Ink brings
`yoga-layout` 3.2.1 (WebAssembly) plus a set of terminal utilities, several of which
(`string-width`, `chalk`) are already in the tree and will dedupe.

### Keep

`react` (both renderers), `chalk` (markdown, intro header, non-interactive), `commander`,
`conf`, `execa`, `string-width`, `cheerio` (web tools, via `/slim`), `@napi-rs/keyring` and
`node-pty` (optional, real features), `react-devtools-core` (OpenTUI peer; also satisfies
Ink 7's peer floor, so no `overrides.ink` entry is needed).

Full target dependency set, with versions and reasons:
[13-DEPENDENCIES.md](13-DEPENDENCIES.md) §5.

## 6. Scripts and spikes

- `scripts/v2-spikes/*` is wired to `npm run test:bun:v2` via
  `scripts/v2-spikes/ci-smoke.ts` and is a real CI gate. **Keep.**
- `classic-revamp/spikes/*` is created and deleted inside W00. Nothing there ships. Add
  `classic-revamp/spikes/` to `.gitignore` or delete the directory at the end of W00.
- `scripts/pty-smoke.py` is extended in W17, not replaced.
- `scripts/install-opentui-platforms.mjs` keeps all eight platform entries.

## 7. Measurement protocol

Record in the W00 baseline and again in W18. Same machine, same Node, clean
`node_modules` for the install measurements.

```
npm pack --dry-run                      # unpacked size, file count
npm run build && du -sh dist            # dist size
npm run compile && ls -l release/       # per-target binary size
find src -name '*.ts' -o -name '*.tsx' | xargs wc -l | tail -1
npm ls --all --parseable | wc -l        # dependency tree size
```

Baseline reference points already measured while writing this plan:

| Metric | Value at `v3.16.0` |
|---|---|
| `src/` total lines | 114,109 |
| `src/agent/runner.ts` | 6,656 |
| `src/repl.ts` | 2,332 |
| classic REPL total (4 files) | 3,593 |
| `src/tui-v2` files | 131 |

Expected delta:

| Change | Lines |
|---|---|
| classic REPL deletion | −3,600 |
| runner presentation removal | −300 |
| `src/tui/state.ts` trim | −500 |
| nine dead files | −200 (estimate; measure) |
| `src/classic` addition | +6,000 to +8,000 (35–40 files under 350 lines) |
| `src/noninteractive` addition | +600 |
| tests addition | +4,000 |

Source lines go **up**, which is expected and fine: the new surface does far more than the
old one and is properly decomposed. What must go **down** is the shipped artifact:

| Artifact | Requirement |
|---|---|
| npm unpacked size | lower than baseline |
| `dist/` size | lower than baseline |
| POSIX binaries | lower than baseline |
| Windows binary | lower, or flat with the split-entrypoint fallback |
| dependency tree entry count | lower (inquirer removal dominates) |

If any of these ends up higher, that is a finding to report with the measured numbers and the
reason, not a reason to skip the measurement.

## 8. What must not be deleted

Frequently mistaken for classic-only. Each has a live non-REPL importer:

| Path | Live importer |
|---|---|
| `src/ui/markdown.ts` | `ui-core/rendering/render-markdown-lines.ts`, the runner |
| `src/ui/code-block.ts` | `ui-core/rendering/streaming-markdown.ts` |
| `src/ui/text-width.ts` | `ui-core/rendering/pager-chrome.ts`, status and thinking components |
| `src/ui/mentions.ts` | `attachments/service.ts`, composer completion, `app/ports/agent-port.ts` |
| `src/ui/thinking.ts` | `agent/context-manager.ts`, `agent/session-title.ts`, `app/controllers/session-compact-helper.ts` |
| `src/ui/plan-pane.ts` | `agent/plan-tool.ts`, `agent/plan-decision.ts` |
| `src/ui/intro-header.ts` | the intro card in both renderers — this is the CLAI brand asset |
| `src/ui/wordmark.ts` | `ui/intro-header.ts` |
| `src/tui/can-use-tui.ts` | `src/index.ts`, `src/commands/doctor.ts` |
| `src/tui/runtime.ts` | `src/index.ts`, `src/commands/doctor.ts` |
| `scripts/v2-spikes/` | `npm run test:bun:v2` |

W02 moves several of these into `src/ui-core/rendering/`. Moving is not deleting — use
`git mv` and update importers in the same commit.
