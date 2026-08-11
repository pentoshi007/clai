# W18 — Release record

## Outcome

W17–W18 completes the verifiable classic-frontend migration work in this checkout and
records the remaining evidence honestly. The classic Ink frontend is wired to the shared
application/session layer, the line-oriented REPL is removed, the non-interactive stream
surface owns piped output, and the OpenTUI and classic launch choices are documented. The
working tree is not a full cross-platform/manual parity sign-off: Windows runtime, Linux
local-host, provider-backed, native-terminal, and manual walkthrough evidence remains
unavailable and is left open in [09-PARITY.md](09-PARITY.md), [10-TESTING.md](10-TESTING.md),
and [12-TASKS.md](12-TASKS.md).

No commit, push, reset, or destructive git operation was performed for this record. The
ignored `dist` output was regenerated cleanly by the build script so package measurements do
not include stale deleted modules.

## User-visible and architectural changes

- Exit codes are explicit: success `0`, user cancellation/second interrupt `130`, and
  operational failure `1`. The behavior is covered by
  `test/noninteractive/exit-codes.test.ts`.
- Non-interactive output is split by stream: the final answer is written to stdout and
  progress, diagnostics, and spinner activity are written to stderr. ANSI and carriage
  returns are suppressed for non-TTY output. The behavior is covered by
  `test/noninteractive/stream-split.test.ts` and `test/noninteractive/nontty.test.ts`.
- The line-oriented `src/repl.ts` and `src/repl/` surface, its classic renderer, and the
  dead legacy UI support cluster were deleted. `src/index.ts` now routes a no-argument
  non-TTY launch through the stream renderer rather than reviving a second interactive
  input path. W16 records the deletion proof in [W16-CLEANUP.md](W16-CLEANUP.md).
- Help and selection records now describe `--tui`, `--classic`, `--ui` aliases
  (`tui`, `v2`, `opentui`, `classic`, `legacy`, `ink`), and the
  `--show-thinking`, `--verbose`, and `--quiet` options. Doctor reports
  `OpenTUI: clai (Bun/native runtime)  ·  classic Ink UI: clai --classic`.
- Classic app wiring is split into lifecycle and interaction helpers, panel effects are
  isolated in the panel controller, and `test/classic/architecture.test.ts` enforces a
  maximum of 400 lines for every TypeScript file under `src/classic`.
- Deterministic performance safeguards cover 8,000 assistant deltas coalescing to one store
  notification, bounded tool-output/feed rows, `MAX_BLOCK_ROWS`, and a 10,000-item semantic
  transcript budget. These safeguards do not claim live frame-write counts or CPU usage.
- The npm build now clears `dist` before TypeScript emission. This prevents removed source
  modules from surviving in an ignored build directory and entering a later npm pack.

## Automated validation

Commands were run from the repository root on macOS darwin arm64, Node v26.4.0, npm 12.0.1,
and Bun 1.3.14 unless a command's output says otherwise.

| Command | Recorded result |
|---|---|
| `npm run typecheck` | Passed. |
| `npx vitest run` | **403 test files passed; 3,769 tests passed; 10 skipped.** The skips are the intentionally unrecorded Windows fixture cases. |
| `npx vitest run test/classic test/ui-core test/noninteractive test/app test/tui-v2` | **153 files, 1,747 passed, 10 skipped.** |
| `npm run test:classic:pty` | `PTY smoke passed: exit=0, bytes=25842, max_visible_row=59, echo=on, initial_echo=on` |
| `npm run build` | Passed after clearing `dist`. |
| `npm run compile` | Passed for all five configured Bun targets: darwin arm64/x64, Linux arm64/x64, and Windows x64. Bundle counts were 1,413 for Darwin and 1,415 for Linux/Windows. |
| `npm run release:verify` | `Release inputs verified for 3.17.0: exact dependencies and synchronized lockfile` |
| `npm pack --dry-run` | Package size **1.9 MB**, unpacked size **8.1 MB**, **1,475 files**. |
| `du -sh dist` | **11M** |
| `git diff --check` | Passed with no whitespace errors. |

Earlier focused evidence remains recorded in the W17/W18 task entries: help/doctor/selection
validation passed with 5 files and 39 tests; the W17 targeted selection passed with 8 files,
84 tests, and 10 skips; and `npm run typecheck` passed before and after the source refactor.

## Final measurements

The source measurement includes every `*.ts` and `*.tsx` file below `src`.

| Measurement | Final value | Baseline | Delta |
|---|---:|---:|---:|
| Source lines | 120,510 | 114,545 | +5,965 |
| Source TypeScript files | 489 | — | — |
| Largest source file | `src/agent/runner.ts`: 6,202 lines | — | — |
| Largest `src/classic` file | `src/classic/panels/panel-controller.ts`: 400 lines | — | — |
| Dependency tree (`npm ls --all --parseable \| wc -l`) | 183 | 172 | +11 |
| `du -sh dist` | 11M | 9.9M | +1.1M |
| npm package compressed | 1.9 MB | 1.8 MB | +0.1 MB |
| npm package unpacked | 8.1 MB | 7.6 MB | +0.5 MB |
| npm package files | 1,475 | 1,159 | +316 |

Compiled binary sizes from the final `ls -l release/` output are compared with the W00
baseline. These are cross-compile measurements, not target-host runtime probes.

| Target | Final bytes | Baseline bytes | Delta |
|---|---:|---:|---:|
| `clai-bun-darwin-arm64` | 78,207,842 | 78,059,234 | +148,608 |
| `clai-bun-darwin-x64` | 83,804,240 | 83,656,784 | +147,456 |
| `clai-bun-linux-x64` | 132,827,264 | 132,683,904 | +143,360 |
| `clai-bun-linux-arm64` | 132,425,872 | 132,294,800 | +131,072 |
| `clai-bun-windows-x64.exe` | 113,149,440 | 113,004,032 | +145,408 |

The final package, dist tree, source tree, and binaries are larger than the W00 baseline;
therefore the size-reduction release gate is not marked passed. The measurements are
reported without treating size growth as a failure of the migration itself.

## PTY and platform evidence

The provider-independent local PTY smoke passed on macOS. It launches
`node bin/clai.mjs --classic --no-history` in an isolated POSIX PTY, exercises help/pager
completion, draft input, resize, and double Ctrl+C, and verifies cleanup (`ECHO`, `ICANON`,
cursor visibility, bracketed paste, and no alternate screen). It deliberately does not submit
a provider prompt or claim tool-card/turn-abort coverage.

The `.github/workflows/ci.yml` `classic-posix` Ubuntu/macOS matrix is present and runs the
classic/UI-core/noninteractive selection plus the same PTY smoke, but no hosted CI result is
being represented as local evidence here. The following remain unavailable and are not
marked as passed:

- Windows Terminal, PowerShell 5.1/7, cmd.exe/conhost, VS Code Windows terminal, Git Bash,
  ConPTY, Windows key/paste captures, and Windows runtime startup.
- Windows one-shot startup and Process Monitor proof that classic startup does not open an
  unsupported OpenTUI native artifact.
- Linux local-host PTY evidence.
- Provider-backed prompt, tool, confirmation, and abort behavior.
- Manual OpenTUI walkthrough evidence on macOS.
- Live frame-write count, CPU percentage, and native terminal timing.

The ten Windows fixture cases remain skipped and their fixture metadata remains
`recorded: false`; null key/paste bytes are not treated as captures. `npm run compile` proves
that the five binary targets can be produced, not that those binaries run on their target
hosts.

## Remaining release status

The authoritative per-gate ledger is in [10-TESTING.md](10-TESTING.md). In summary, local
automated tests, architecture guards, deterministic performance tests, cross-renderer history
contracts, POSIX macOS smoke, clean build output, five-target compilation, release-input
verification, and measurements are recorded. The full parity checklist, target-host/manual
checks, provider-backed checks, CPU/live-frame measurements, and size-reduction requirement
remain open. [12-TASKS.md](12-TASKS.md) retains those unchecked statuses rather than turning
configuration or cross-compilation into runtime evidence.
