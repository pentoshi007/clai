# Platform Behaviour and Packaging

## 1. Launch selection

`UiChoice` becomes a three-member union:

```ts
type UiChoice = "tui" | "classic" | "noninteractive";
```

`ui-core/bootstrap/ui-selection.ts` after W03:

```ts
resolveUiChoice(options: UiSelectionOptions, env: NodeJS.ProcessEnv): UiChoice
```

Alias normalization, applied before any decision:

| Token | Normalizes to |
|---|---|
| `classic`, `legacy`, `ink` | `classic` |
| `tui`, `v2`, `opentui` | `tui` |
| anything else | rejected by commander's `.choices`, and ignored from `CLAI_UI` |

Precedence — **explicit flags beat environment**, which is a fix to the current order:

1. `--ui <choice>`
2. `--classic` (boolean flag)
3. `--tui` (boolean flag)
4. `CLAI_UI`
5. `CLAI_CLASSIC=1` or `CLAI_TUI=0` → `classic`
6. `CLAI_CLASSIC_UI=plain` → `noninteractive`
7. platform default (§2)

Commander's `--ui` choices become `["tui", "v2", "classic", "legacy", "ink"]` so every token
`resolveUiChoice` understands is actually reachable from the command line. Today
`--ui classic` is rejected at parse time even though the resolver accepts it.

`resolveUiChoice` is pure and env-injected. `test/ui-core/ui-selection.test.ts` covers the
full precedence cross-product, including the two current defects:
`--classic` with `CLAI_UI=tui` must resolve to `classic`, and `--ui classic` must parse.

## 2. Platform default

```ts
defaultUiForPlatform(input: {
  platform: NodeJS.Platform;
  stdoutIsTTY: boolean;
  stdinIsTTY: boolean;
  columns: number | undefined;
  rows: number | undefined;
}): UiChoice
```

| Condition | Result |
|---|---|
| stdout or stdin is not a TTY | `noninteractive` |
| `platform === "win32"` | `classic` |
| terminal smaller than 60x14 | `classic` |
| otherwise | `tui` |

This is a pure function with no process access, separate from `canUseTui()`. `canUseTui()`
keeps its current job — deciding whether OpenTUI *can* run — and its `win32` early return
stays as a second line of defence. `defaultUiForPlatform` is the product decision;
`canUseTui` is the capability check.

Note the size rule changes meaning: today a small terminal falls back to the line REPL,
which is worse in a small terminal. Ink's classic surface degrades gracefully down to
about 8 rows and 40 columns (see [04-UI-SPEC.md](04-UI-SPEC.md) §6.5–6.6), so small
terminals now get a real UI.

## 3. Startup flow in `src/index.ts`

```
oneShot(promptParts, options):
  if prompt is non-empty:
    return startNoninteractive({ prompt, ...resolved })

  ui = resolveUiChoice(options, process.env)

  if ui === "noninteractive":
    return startNoninteractive({ interactiveStdin: true, ...resolved })

  if ui === "classic":
    return startClassic(resolved)                  // no Bun probe, no OpenTUI import

  gate = canUseTui()
  if !gate.ok:
    warnOnce(`TUI unavailable (${gate.reason}); using classic.`)
    return startClassic(resolved)

  if !isBunRuntime():
    if reexecWithBunIfNeeded(CLAI_ENTRY) return
    warnOnce(openTuiRuntimeHint())
    return startClassic(resolved)

  try:
    { startTuiV2 } = await import("./tui-v2/bootstrap/start-tui-v2.js")
    return await startTuiV2(resolved)
  catch error:
    if isOpenTuiFfiError(error):
      warnOnce("Failed to start OpenTUI renderer; using classic.")
      return startClassic(resolved)
    throw error
```

Hard requirements:

- The `import("./tui-v2/...")` stays **dynamic** and stays after the `classic` branch, so
  choosing classic never evaluates the OpenTUI module graph.
- `import("./classic/bootstrap/start-classic.js")` is likewise dynamic, so a one-shot run
  never loads Ink, React, or Yoga. That keeps `clai --mode agent "…"` startup fast.
- `reexecWithBunIfNeeded` is only ever reached on the `tui` path. Windows never enters it.
- All fallback diagnostics go through one `warnOnce` helper writing a single dim line to
  stderr. Three stacked warning lines, as today, is noise.

## 4. Per-OS behaviour

### Windows

- Default and only interactive frontend: Ink classic. `clai` with no arguments starts it
  directly, prints no OpenTUI diagnostic, and never touches Bun.
- Must work under `npm i -g @pentoshi/clai` with Node 20 and no Bun installed anywhere.
- `bin/postinstall.mjs` currently auto-installs Bun on every platform. Change it to skip
  the install entirely when `process.platform === "win32"`, since Windows can never use
  OpenTUI. That removes a 100 MB download and a PowerShell execution-policy failure mode
  from every Windows install. Keep the `CLAI_NO_BUN_AUTO_INSTALL=1` escape for the other
  platforms.
- Hosts to verify: Windows Terminal, PowerShell 5.1 and 7, cmd.exe/conhost, VS Code
  integrated terminal, Git Bash/mintty.
- `capabilities.unicode` must report false on legacy conhost so the ASCII glyph table
  engages. Verify by checking `WT_SESSION` / `ConEmuANSI` / `TERM_PROGRAM` absence.
- Process-tree cleanup uses the existing `src/os/process-tree.ts`. Never assume POSIX
  signals.
- Paths: reuse `src/ui/mentions.ts` handling for `C:\…` and UNC `\\…`.
- `$EDITOR` fallback stays `notepad`.
- Keep the `uncaughtException` / `unhandledRejection` handlers at `src/index.ts:688-700`.
  They exist because cmd.exe can exit before stderr flushes, and the classic path must
  never fail silently.

### macOS

- Default: OpenTUI. `--classic` gives Ink.
- Option is reported as `alt`; Command is `meta` and unbound.
- Terminal.app is 256-colour; iTerm2 is truecolor. Both must be captured in the golden
  fixtures via `colorMode`.
- `shift+enter` only distinguishable in kitty/ghostty/WezTerm; `alt+enter` is the macOS
  default hint.

### Linux

- Default: OpenTUI on a capable TTY. Ink on `--classic`, in a small terminal, over a
  minimal `TERM`, and on any OpenTUI FFI failure (musl, missing glibc symbols, unusual
  arch).
- The raw framebuffer console may lack braille; the ASCII spinner covers it.
- tmux/screen: `TERM=screen*`. Nothing classic emits needs passthrough, because no mouse
  and no alternate screen are used. This is a direct benefit of the feed model.
- SSH: latency makes the write budget in [03-RENDER-MODEL.md](03-RENDER-MODEL.md) §9 the
  binding constraint, not colour depth.

### Terminal capability matrix

| Terminal | OS | colorMode | unicode | kittyKeyboard | Notes |
|---|---|---|---|---|---|
| Windows Terminal | win | truecolor | yes | no | primary Windows target |
| PowerShell / cmd via ConPTY | win | 256–truecolor | yes | no | VT on by default on Win10+ |
| cmd.exe legacy console | win | 16 | **no** | no | ASCII path, must stay readable |
| ConEmu / Cmder | win | 256+ | yes | no | `ConEmuANSI=ON` |
| Git Bash / mintty | win | 256+ | yes | no | |
| VS Code terminal | any | truecolor | yes | no | |
| Terminal.app | mac | 256 | yes | no | |
| iTerm2 | mac | truecolor | yes | no | |
| kitty / ghostty / WezTerm / foot | any | truecolor | yes | **yes** | real `shift+enter` |
| xterm / gnome-terminal / konsole | linux | 256+ | yes | no | |
| Linux raw console | linux | 16 | partial | no | ASCII spinner |
| tmux / screen | any | per outer | yes | no | |
| `TERM=dumb`, CI, pipe | any | none | n/a | n/a | `noninteractive` |

## 5. Packaging

### npm distribution

`package.json` `files` stays `["bin", "dist", "README.md"]`. Node does not evaluate the
unused dynamic branch, so a Windows install never loads `@opentui/*`.

`optionalDependencies` currently lists eight `@opentui/core-*` platform packages. They stay
optional, so npm skips non-matching platforms — including all of them on Windows, where npm
will still try `@opentui/core-win32-x64`. Remove `@opentui/core-win32-x64` and
`@opentui/core-win32-arm64` from `optionalDependencies`: OpenTUI is unreachable on Windows
through both `defaultUiForPlatform` and `canUseTui`, so downloading its Windows FFI binaries
on every Windows install is pure waste. `scripts/install-opentui-platforms.mjs` keeps them
in its own list because `bun build --compile` resolves every dynamic import at compile time
and needs the tarballs present on the build host — that is a build-time concern, not an
install-time one.

### Compiled binaries

`scripts/build.ts` and `.github/workflows/release.yml` build five targets:
`bun-darwin-arm64`, `bun-darwin-x64`, `bun-linux-x64`, `bun-linux-arm64`,
`bun-windows-x64`.

The prior spike measured a 108 MB Windows executable bundling 877 modules including the
OpenTUI graph, with platform bindings loading lazily. Lazy binding load is not proof that
nothing initializes. **W15 must prove it on a real Windows runner:**

1. Build `clai-bun-windows-x64.exe`.
2. Run it in Windows Terminal, PowerShell, and cmd.exe with no arguments. It must start the
   Ink classic surface, print no OpenTUI diagnostic, and not exit silently.
3. Run `clai --mode agent "echo hi"` and assert a clean exit 0.
4. Instrument: run with a `Process Monitor` capture or a `--trace-warnings` build and assert
   no `.node`, `.dll`, or opentui native artifact is opened during startup.

If the probe fails, apply the recorded fallback — split entrypoints:

```
src/cli/main.ts                shared commander wiring and subcommand behaviour
src/entry/node.ts              default entry; dynamic platform selection (npm distribution)
src/entry/compiled-posix.ts    imports both startTuiV2 and startClassic
src/entry/compiled-windows.ts  imports only startClassic and startNoninteractive
```

`scripts/build.ts` then selects `src/entry/compiled-windows.ts` for `bun-windows-x64` and
`src/entry/compiled-posix.ts` for the rest. `release.yml` gets the same conditional. This is
strictly more machinery, which is why it is the fallback and not the plan.

Never ship a Windows executable that bundles or initializes unsupported native code and
exits without a message.

### Size budget

Measure before and after. Record the numbers in the final report.

| Metric | How to measure |
|---|---|
| unpacked npm size | `npm pack --dry-run` |
| `dist/` size | `du -sh dist` after `npm run build` |
| each binary | `ls -l release/` after `npm run compile` |
| module count per binary | `bun build --compile` output line |

Expected movement:

| Change | Direction |
|---|---|
| delete `src/repl.ts` + `prompt-line.ts` + `classic-renderer.ts` (3593 lines) | down |
| delete ~350 lines of runner direct-write code | down |
| delete ~500 dead lines from `src/tui/state.ts` | down |
| delete the nine unreferenced files in [11-CLEANUP.md](11-CLEANUP.md) | down |
| drop `@inquirer/prompts` | down, meaningfully — it pulls a large dependency tree |
| drop two `@opentui/core-win32-*` optional deps | down on Windows installs |
| add `ink` + `yoga-layout` wasm | up |
| add `src/classic` (~35 files, target under 350 lines each) | up |

Net must be negative for the npm package and for the POSIX binaries. The Windows binary
should drop substantially if the split-entrypoint fallback is used, and stay roughly flat
otherwise.

If the net is positive, that is a finding, not a failure — record the measured numbers and
the reason before declaring the work done.

## 6. `doctor` updates

`src/commands/doctor.ts` already imports `canUseTui` and `runtime`. Extend it to report:

```
frontend        classic (Ink)     default for win32
opentui         unavailable       Windows (OpenTUI not yet supported)
bun             not installed     not required for classic
terminal        Windows Terminal  truecolor · unicode · 132x38
newline chord   alt+enter         shift+enter not distinguishable
mouse           off               set CLAI_CLASSIC_MOUSE=1 to enable
```

Values come from `defaultUiForPlatform`, `resolveUiChoice`, `canUseTui`,
`readCapabilitiesFromProcess`, and `describeUiDefault`. `doctor` is the first thing a user
runs when the UI looks wrong, so it must state which frontend will actually launch and why.

## 7. Documentation to update

- `README.md` — frontend section, the flag table, the Windows note, and any screenshot or
  description that still says the classic frontend is a line REPL.
- `--help` text for `--ui`, `--classic`, `--tui`, plus the three new one-shot flags.
- `describeUiDefault()` in `ui-selection.ts`.
- `CONTRIBUTING.md` — the `src/ui-core` boundary and the dependency rules from
  [02-ARCHITECTURE.md](02-ARCHITECTURE.md) §"Dependency rules".
- Release notes — the one-shot exit-code change, the stdout/stderr split, and the removal of
  the line REPL are all user-visible.
