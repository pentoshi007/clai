# W03 — Launch selection record

## `UiChoice`

```ts
type UiChoice = "tui" | "classic" | "noninteractive";
```

`"legacy"` is gone as a *value*; it survives only as an input alias. The
deprecated `isV2Requested` export was removed — nothing outside its own test
used it.

## Alias table

`normalizeUiToken` is the single entry point, applied before any decision, and
is case- and whitespace-insensitive.

| Token | Normalizes to |
| --- | --- |
| `tui`, `v2`, `opentui` | `tui` |
| `classic`, `legacy`, `ink` | `classic` |
| anything else | `undefined` (ignored from `CLAI_UI`, rejected by commander) |

`UI_FLAG_CHOICES` is exported from `ui-selection.ts` and fed straight into
commander's `.choices(...)`, so the flag surface and the resolver can no longer
drift. Verified against the built CLI:

```
$ clai --ui bogus
error: option '--ui <mode>' argument 'bogus' is invalid. Allowed choices are tui, v2, opentui, classic, legacy, ink.

$ clai --ui classic      # reaches the classic frontend
```

## Precedence

Explicit flags now beat the environment, reversing the old `--ui` → `CLAI_UI` →
`--classic` order:

1. `--ui <choice>`
2. `--classic`
3. `--tui`
4. `CLAI_UI`
5. `CLAI_CLASSIC=1` or `CLAI_TUI=0` → `classic`
6. `CLAI_CLASSIC_UI=plain` → `noninteractive`
7. `defaultUiForPlatform`

Both recorded defects are covered by named regression cases in
`test/ui-core/ui-selection.test.ts`:

- `--classic` with `CLAI_UI=tui` resolves to `classic` (was `tui`).
- `--ui classic` parses (was rejected by commander despite the resolver accepting it).

## Platform default

`defaultUiForPlatform(probe)` is pure — no `process` access — and takes
`{ platform, stdoutIsTTY, stdinIsTTY, columns, rows }`.

| Condition | Result |
| --- | --- |
| stdout or stdin is not a TTY | `noninteractive` |
| `win32` | `classic` |
| smaller than `MIN_COLS`x`MIN_ROWS` (60x14) | `classic` |
| otherwise | `tui` |

The thresholds are imported from `ui-core/bootstrap/can-use-tui.ts` rather than
redeclared, per W02 finding 4. `currentPlatformProbe()` is the only impure
helper and is injected as `resolveUiChoice`'s third argument.

`canUseTui()` is untouched: it remains the OpenTUI *capability* check that runs
after the product decision.

## Startup flow

`oneShot` now delegates the no-prompt path to `startInteractive`, which follows
the 07-PLATFORM-PACKAGING §3 order exactly: `noninteractive` → `classic` →
`canUseTui` gate → Bun probe/re-exec → dynamic OpenTUI import with an FFI-error
fallback. `reexecWithBunIfNeeded` is unreachable unless the resolved choice is
`tui`, so Windows never enters it.

`src/classic/bootstrap/start-classic.ts` is the W03 stub: it takes the same
options shape as `startTuiV2` and dynamically imports the existing line REPL.
W04 replaces the body with the Ink mount; no call site changes.

Every fallback diagnostic goes through `warnOnce` (`src/ui/warn-once.ts`), which
writes one dim, whitespace-collapsed line to stderr and deduplicates by message.
That replaces the three stacked `console.error` lines the old flow emitted.
`warnOnce` lives outside `ui-core` because the ui-core architecture guard forbids
terminal writes there.

## `doctor`

```
UI default: tui (OpenTUI) on an interactive POSIX terminal at least 60x14; classic (Ink) on win32 or a smaller terminal; noninteractive without a TTY
UI resolved now: noninteractive (platform-default: stdin and stdout are not TTYs)
UI platform default: noninteractive (darwin, 0x0, stdout not a tty, stdin not a tty)
UI host: unavailable — not a TTY
```

`explainUiChoice` returns `{ choice, source, reason }`, so doctor reports both
*what* was chosen and *which precedence level* chose it.

## `--classic` never loads OpenTUI

`test/classic/no-opentui.test.ts` walks the transitive **static** import graph of
`start-classic.ts` and asserts it contains no `@opentui/*` package and no
`src/tui-v2` module. It also asserts `src/index.ts` has no static OpenTUI or
`tui-v2` import, reaches both frontends only via `import(...)`, and places the
`ui === "classic"` branch before both `isBunRuntime()` and the tui-v2 import.

`test/tui-v2/architecture.test.ts` gained the reverse rule — `src/tui-v2` may not
import `src/classic` or `src/noninteractive` — and its renderer allowlist was
pruned of the seven entries W02 moved into `ui-core`.

## Verification

| Check | Result |
| --- | --- |
| `npm run typecheck` | clean |
| `npx vitest run` (full, x2) | 355 files / 2834 tests passed, zero failures both runs |
| `npm run test:bun` | 38 files / 256 tests passed |
| `npm run build` / `npm run compile` | clean, 837 modules per Bun target |
| `clai --ui bogus` | rejected at parse time with the full choice list |
| `clai --ui classic` | starts the classic frontend |
| `CLAI_UI=tui clai --classic` | starts the classic frontend |
| `clai doctor` | reports resolved frontend, source, reason, and platform default |

## Findings that change later packages

1. **`noninteractive` currently routes to the line REPL.** `startInteractive`'s
   `noninteractive` branch calls `startRepl` directly, matching today's
   behaviour. W06 replaces that single call with
   `src/noninteractive/start-noninteractive.ts`; the resolver needs no change.
2. **`start-classic.ts` is the only seam W04 must touch.** Its signature
   (`StartClassicOptions`, mirroring `StartTuiV2Options`) is already what
   `src/index.ts` passes, and the dynamic-import site is asserted by test.
3. **`UI_FLAG_CHOICES` is the single source of truth for the flag surface.** Any
   future frontend token must be added there, not in `src/index.ts`.
4. **Small terminals now get the classic frontend, not the line REPL.** Once W04
   lands, `defaultUiForPlatform`'s size rule sends sub-60x14 terminals to Ink.
   The 04-UI-SPEC §6.5–6.6 degradation ladder (down to ~40x8) is therefore load
   bearing, not optional.
5. **The Windows postinstall Bun skip (07-PLATFORM-PACKAGING §4) is still open.**
   `bin/postinstall.mjs` was not changed in W03; it belongs with the packaging
   work package.
