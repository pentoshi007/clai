# Audit — verified current state

Every claim below was verified against the working tree at `v3.16.0` (`dc65ac0`).
File:line references are to that commit. Re-verify before relying on a line number.

## 1. Launch path

### CLI surface

`bin/clai.mjs` → `dist/index.js`. `bin/clai.mjs:8-28` recovers from a deleted cwd by
chdir-ing to `HOME`/`USERPROFILE`/`TMPDIR`/`/tmp`/`/`. `bin/clai.mjs:30-46` catches loader
failure, prints remediation including `clai --classic`, sets `exitCode = 1`.

Root program at `src/index.ts:182-217`: `--mode ask|agent|plan`, `--provider`, `--model`,
`-y/--yes`, `--no-history`, `--tui`, `--classic`, `--ui legacy|tui|v2`, variadic
`[prompt...]`.

Subcommands: `config`, `set`, `unset`, `keys`, `use`, `provider`, `search-provider`,
`model`, `mode`, `doctor`, `history`, `update`, `authorize-pentest`, `scope`, `privacy`.

### The branch that selects a frontend

`src/index.ts:87-135`, reached only when the prompt is empty:

```
ui = resolveUiChoice(options)                  // index.ts:88
if (ui === "tui"):
  gate = canUseTui()                           // index.ts:90
  if gate.ok:
    if !isBunRuntime(): reexecWithBunIfNeeded() // index.ts:94-95
      else warn + startRepl()                   // index.ts:97-101
    try startTuiV2()                            // index.ts:103-113
    catch isOpenTuiFfiError → warn + startRepl  // index.ts:114-126
  else print "TUI unavailable (reason)"         // index.ts:129-132
startRepl()                                     // index.ts:133
```

Three gates:

1. **Platform/TTY/size** — `src/tui/can-use-tui.ts:35-47`. `win32` is a hard block at
   `:38-40` with reason `"Windows (OpenTUI not yet supported)"`, checked *before* TTY.
   Then `evaluateTui` requires both stdio ends to be TTYs and `MIN_COLS=60`,
   `MIN_ROWS=14` (`:12-13`, `:22-33`).
2. **Bun runtime** — `src/tui/runtime.ts:13-15`, `:186-224`. Re-exec is skipped for
   `CLAI_NO_BUN_REEXEC=1` or `CLAI_FORCE_NODE=1`; otherwise finds or auto-installs Bun
   and `spawnSync`s the same entry, exiting with the child status.
3. **Native module** — no explicit probe exists. Failure surfaces as a thrown error from
   the dynamic import, classified by `isOpenTuiFfiError` (`src/tui/runtime.ts:227-232`).

`resolveUiChoice` (`src/tui-v2/bootstrap/ui-selection.ts:63-79`) precedence: `--ui` →
`CLAI_UI` → `--classic`/`CLAI_CLASSIC=1`/`CLAI_TUI=0` → `--tui` → default `tui`.

Two defects to fix in W03:

- `CLAI_UI=tui` beats an explicit `--classic` because env is consulted before the boolean
  flags. Explicit flags must win over environment.
- `resolveUiChoice` accepts the tokens `classic` and `opentui`, but commander's
  `.choices(["legacy","tui","v2"])` at `src/index.ts:211` rejects them at parse time, so
  they are only reachable through `CLAI_UI`. `ink` is not accepted at all.

### One-shot path

`oneShot` (`src/index.ts:75-178`) with a non-empty prompt never consults
`resolveUiChoice`, `canUseTui`, or Bun. It resolves provider/mode/model, expands `@file`
mentions through `resolveTurnInput`, calls `runAgent` **without** `onEvent`, optionally
saves history, closes interactive sessions, then `process.exit(0)` at `:178`.

Because `onEvent` is absent, `src/agent/runner.ts:568` sets `writesDirectly = true` and
the runner prints the entire turn to stdout itself. `attachClassicRenderer` is not used
here — it is REPL-only.

## 2. What the current classic REPL is

`startRepl` at `src/repl.ts:1732`. Line counts:

| File | Lines | Role |
|---|---|---|
| `src/repl.ts` | 2332 | REPL loop, slash dispatch, pickers, SIGINT, history |
| `src/repl/prompt-line.ts` | 696 | line editor, slash + mention menus, clipboard image |
| `src/repl/slash-commands.ts` | 414 | command catalogue + `knownModels` + helpers |
| `src/agent/classic-renderer.ts` | 151 | `AgentEvent` → ANSI for the REPL |
| **total** | **3593** | |

Feature surface it renders today: intro card (`src/repl.ts:1959-1963`), a keybinding
footer (`:394-398`), the prompt line, slash/mention menus, spinners
(`src/ui/spinner.ts`), the pager (`src/ui/output-pane.ts`, Ctrl+O), plan checklists
(`src/ui/plan-pane.ts`, Ctrl+P), thinking toggle (Ctrl+T), inquirer confirmations,
provider/key/model/history pickers, double-ESC cancel, double-Ctrl+C exit.

It has no queue panel, no jobs panel, no responder strip, no toasts, no structured file
diffs, no batch cards, no transcript search, no context meter, no scope editor, no
multi-key editor, and no plan pane. That gap list is the scope of this migration.

## 3. Layering that already exists and must be preserved

`src/app` is the correct backend boundary and is guarded by
`test/app/architecture-guard.test.ts`, which fails on any import of `@opentui/*`, `ink`,
`ink-*`, `solid-js`, `react`, `react-dom`, `@inquirer/*`, and on any
`process.stdout.write` under `src/app`.

`src/app` owns: `SessionController`, `PlanController`, `TurnController`,
`SessionPromptQueue`, `SessionResponder`, the `AppEvent` protocol, the command registry,
and every port (`agent`, `persistence`, `jobs`, `interactiveSessions`, `updates`,
`clipboard`, `confirm`, `secret`, `terminal`).

`src/tui-v2/bootstrap/composition-root.ts` builds `AppServices` — `ports`, `commands`,
`session`, `focus`, `router`, `selection`, `toast`, `transcript`, `plan`, `overlay`,
`pagerExport`, `requestExit`, `capabilities`, `recordedEvents`, `dispose`. It is pure DI
with no runtime OpenTUI or React import, and it owns the single `emit` fan-out:
`transcript.dispatch` + `plan.observe` unconditionally, `token-usage` →
`session.recordTokenUsage`, `compaction-completed` → `session.noteContextCompacted`,
`context-estimate` → `session.noteContextEstimate`, `notice` → **toast only, never a chat
row**, with API-key-rotation messages coalesced under key `"api-key-rotation"` at 3000 ms.

## 4. OpenTUI coupling census

131 TypeScript/TSX files under `src/tui-v2`. 46 contain a `@opentui` reference; 85 do not.

Of the 46, two are false positives:

- `src/tui-v2/actions/chord-from-key.ts` — the token appears only in a comment; the file
  deliberately declares its own `KeyEventLike` so it imports nothing.
- `src/tui-v2/bootstrap/composition-root.ts` — the token appears only in a comment
  asserting the file imports no `@opentui`/React.

Genuinely coupled (44): every `.tsx` under `components/`, `app/App.tsx`,
`app/providers.tsx`, `composer/composer-editor.tsx`, `composer/use-draft-actions.ts`,
`components/transcript/use-click-without-drag.ts`,
`components/transcript/use-native-selection-copy.ts`,
`components/transcript/use-transcript-selection.ts`, `rendering/ansi-to-styled.ts`,
`rendering/pager-markdown.ts`, `bootstrap/start-tui-v2.ts`,
`bootstrap/patch-opentui-text.ts`, `bootstrap/disable-native-selection.ts`.

Two files are *transitively* coupled — pure logic that returns OpenTUI styled values:
`rendering/render-markdown-lines.ts` and `rendering/streaming-markdown.ts`. Their logic is
reusable; only the final mapping step changes.

Everything else — all of `state/`, `controllers/`, `actions/`, `layout/`, `motion/`,
22 of 26 `rendering/`, the composer logic modules, and most of `bootstrap/` — is
renderer-neutral today and is misplaced under a renderer directory. That is what W02
extracts.

## 5. Cross-layer violations to fix

| Violation | Evidence | Fix |
|---|---|---|
| App layer imports the classic REPL | `src/app/commands/registry.ts:1` imports `slashCommands` from `../../repl/slash-commands.js` | W01 moves the catalogue to `src/app/commands/catalog.ts` |
| OpenTUI imports the classic REPL | `src/tui-v2/app/commands/picker-commands.ts:21` imports `getKnownModels` from `../../../repl/slash-commands.js` | W01, same move |
| Shared module imports the classic REPL | `src/tui/input-history.ts:1` imports `isKnownSlashCommand` from `../repl.js` | W01 + W02 move both |
| `/jobs` unreachable as a typed command | absent from `slashCommands`; handler registered at `src/tui-v2/app/command-handlers.ts` and bound to Ctrl+J | W01 adds it to the catalogue with a regression test |
| Renderer-neutral code lives under a renderer | §4 above | W02 |
| Runner owns presentation | 30 `writesDirectly` references in `src/agent/runner.ts` (6656 lines) | W14 deletes the branch |

## 6. Dead code found

Confirmed unreferenced anywhere in `src/`:

| Path | Lines | Note |
|---|---|---|
| `src/ui/task-pane.ts` | — | no importer; superseded by `rendering/plan-view.ts` |
| `src/tui-v2/bootstrap/disable-native-selection.ts` | 15 | no-op stub |
| `src/tui-v2/composer/newline-hint.ts` | — | superseded |
| `src/tui-v2/composer/history-nav.ts` | — | superseded by `prompt-history.ts` |
| `src/tui-v2/rendering/transcript-export.ts` | 27 | no importer |
| `src/tools/reducers/generic.ts` | — | verify against `policies/output-policy.ts` before deleting |
| `src/app/adapters/current-terminal-adapter.ts` | — | no importer |
| `src/app/controllers/job-controller.ts` | — | superseded by the jobs port |
| `src/safety/path-permissions.ts` | — | verify against `safety/classifier.ts` before deleting |

Partially dead: `src/tui/state.ts` (643 lines) is a legacy Ink reducer. Only
`TranscriptItem` and its member item interfaces are used, by
`src/app/adapters/current-store-adapter.ts:4`,
`src/app/controllers/session-controller.ts:31`, `src/app/ports/persistence-port.ts:5`,
`src/store/history.ts:29`, `src/tui-v2/state/transcript-hydrate.ts:10`.
`TuiState`, `TuiAction`, `reducer`, `initialState`, `PendingConfirm`, `TurnStatus`,
`PlanItem`, and this file's `serializeTranscriptForCompaction` have **zero** importers —
roughly 500 dead lines sitting in a file the app layer depends on.

Do not delete anything from this table on sight. Each deletion is a W16 item with a
`grep` proof plus a green `npm test` in the completion report.

## 7. Modules that are classic-only (die with the REPL)

`src/repl.ts`, `src/repl/prompt-line.ts`, `src/agent/classic-renderer.ts`,
`src/ui/banner.ts`, `src/ui/intro-card.ts`, `src/ui/keys.ts`, `src/tui/format-keys.ts`
(verify), `src/ui/ansi-box.ts` (after the runner branch is removed),
`src/ui/output-pane.ts` (after the runner branch is removed), `src/ui/spinner.ts` (after
the runner branch is removed).

## 8. Modules that are shared and must survive

`src/ui/markdown.ts` (used by `rendering/render-markdown-lines.ts:10` and the runner),
`src/ui/code-block.ts` (`rendering/streaming-markdown.ts:10`), `src/ui/text-width.ts`,
`src/ui/mentions.ts` (attachments + composer completion), `src/ui/thinking.ts`
(context-manager, runner, session-title, compact helper), `src/ui/plan-pane.ts`
(`agent/plan-tool.ts`, `agent/plan-decision.ts`), `src/ui/intro-header.ts` +
`src/ui/wordmark.ts` (the CLAI brand card), `src/tui/text-format.ts`,
`src/tui/input-history.ts`, `src/tui/can-use-tui.ts`, `src/tui/runtime.ts`.

## 9. Windows-specific behaviour already in the tree

- Hard OpenTUI block at `src/tui/can-use-tui.ts:38-40`, so Windows is 100 % classic today.
- `bun.exe` naming, `%LOCALAPPDATA%\bun`, `%APPDATA%\bun\bin` candidates, `F_OK`
  instead of `X_OK` (`src/tui/runtime.ts:18-46`).
- PowerShell installer with an `npm.cmd` fallback, `windowsHide: true` on every spawn
  (`src/tui/runtime.ts:97-121`).
- Process-level `uncaughtException` / `unhandledRejection` handlers at
  `src/index.ts:688-700` exist because cmd.exe can exit before stderr flushes.
- Single batched frame write in `src/ui/output-pane.ts:279-283` because many small writes
  flicker on Windows Terminal.
- `C:\…` and UNC path handling in `src/ui/mentions.ts:257-261`.
- `notepad` as the `$EDITOR` fallback in `src/tui-v2/bootstrap/pager-export.ts:34`.

## 10. Recorded spike evidence to reuse

`git show feature/classic-react:classic-improvements/spikes/NOTES.md` holds measured
findings from a prior Ink attempt (2026-08-07). Treat as strong prior, re-verify in W00:

- Ink's `useInput` does not decode CSI-u / kitty sequences: `\x1b[13;2u` arrives as the
  literal text `[13;2u`. An own raw decoder is mandatory for Shift+Enter.
- Ctrl+J arrives as `\n` with every key flag false — indistinguishable from LF unless raw
  `0x0A` is claimed before text handling.
- Ctrl+H arrives as `0x08` with `backspace: true` and no ctrl flag; `0x7F` arrives as
  `delete: true`.
- SGR mouse reports leak into text as `[<0;10;5M` and must be filtered before any prompt
  or secret buffer sees them.
- `\x1b\r` (Alt+Enter) arrives as escape-then-return across two events.
- Streaming throughput: 10,000 synchronous deltas produced 3 committed frames in ~305 ms
  under both Node 20.19.0 and Bun.
- Unmount → run child process → remount works cleanly, which is the mechanism for
  `$EDITOR` export.
- `bun build --compile --target bun-windows-x64` produced a 108 MB executable bundling 877
  modules including the OpenTUI graph, with platform bindings loading lazily. Runtime
  proof on a real Windows runner is still required.

## 11. Risk register

| Risk | Impact | Mitigation |
|---|---|---|
| Ink `<Static>` interleaving duplicates or reorders rows | corrupted transcript | W00 spike S3 with a hard fallback rule; see [03-RENDER-MODEL.md](03-RENDER-MODEL.md) §7 |
| Row-budget arithmetic overflows the terminal and causes scroll/flicker | the "abnormal placement" class of bug | single pure allocator, property-tested over every size |
| Extraction churn breaks OpenTUI silently | product regression | one cluster per commit, `test/tui-v2` after each |
| Windows console key delivery differs from POSIX | broken newline/shortcut | fixture-driven decoder tests plus PTY smoke on a Windows runner |
| Bun compile pulls OpenTUI native code into the Windows binary | silent exit on launch | W15 probe, split entrypoints as the recorded fallback |
| Deleting `repl.ts` breaks an unnoticed importer | build break | W01 removes every non-`index.ts` importer first; deletion is its own package |
