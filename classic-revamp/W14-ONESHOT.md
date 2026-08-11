# W14 — Non-interactive surface and runner cleanup (record)

## Scope

W14 moves one-shot execution onto an injected stream renderer, removes presentation writes
from the agent runner, replaces the remaining Inquirer prompt path with readline helpers,
and makes scripted output safe to redirect. Interactive REPL cleanup remains W16 work.

## File map

| File | Owns |
| --- | --- |
| `src/noninteractive/start-noninteractive.ts` | One-shot composition, injected streams, confirmations/secrets, abort forwarding, history save, outcome-to-exit-code mapping. |
| `src/noninteractive/stream-renderer.ts` | Ordered stdout/stderr rendering for agent events, verbosity, thinking, quiet mode, and idempotent outcome completion. |
| `src/noninteractive/stream-blocks.ts` | Pure event-to-line presenters for assistant, thinking, tools, diffs, batches, compaction, and abort states. |
| `src/noninteractive/stream-spinner.ts` | Non-interactive stderr spinner implementation. |
| `src/noninteractive/readline-prompts.ts` | Readline-based line, choice, and secret prompt helpers. |
| `src/noninteractive/stdio-confirm-port.ts` | Confirmation and secret ports over injected stdin/stderr. |
| `src/index.ts` | Prompt-path integration and `--show-thinking`, `--verbose`, and `--quiet`. |
| `src/modes/agent.ts` | Event forwarding, outcome capture, and return of the already-rendered final answer. |
| `src/agent/runner.ts` | Event orchestration only; no `writesDirectly` branch or `process.stdout.write`. |
| `src/agent/confirm-port.ts` | Readline confirmation migration. |
| `src/agent/plan-decision.ts` | Readline plan-decision migration. |
| `src/commands/providers.ts` | Readline provider/key selection migration. |
| `src/commands/search-providers.ts` | Readline search-provider selection migration. |
| `test/noninteractive/*` | Stream, prompt, spinner, non-TTY, and exit-code coverage. |
| `test/agent/runner-no-direct-writes.test.ts` | Guard against reintroducing runner-owned terminal writes. |

The broader W14 regression fixes are also recorded in the working tree:
`src/classic/bootstrap/terminal-session.ts` keeps the production factory on the no-alt-screen
contract while supplying constructor compatibility for the existing startup test;
`src/classic/app/ClassicApp.tsx` can own and dispose a fallback wiring when no prop is supplied;
and `src/ui-core/ports/pager-export-port.ts` supports a neutral renderer fake without changing
the OpenTUI or classic adapters.

## Stream contract

- stdout contains assistant rows and the final answer only. It is suitable for redirecting to
  an answer file.
- stderr contains thinking when enabled, status/tool rows, bounded tool output, diffs,
  batches, compaction notices, abort notices, confirmation prompts, diagnostics, and cleanup
  failures.
- `--quiet` suppresses renderer stderr progress while retaining the answer on stdout.
- Non-TTY output disables ANSI and carriage-return control sequences and uses line-oriented
  tool prefixes.
- Confirmation and secret prompts receive the injected stderr stream, so prompts cannot pollute
  the answer stream.
- The renderer's `finish()` is idempotent and suppresses duplicate final answers when the runner
  has already emitted the final assistant event.

## Golden comparison

The old capture was produced by the legacy renderer fixture before the W14 stream split. The
new capture is the exact scripted fixture asserted by
`test/noninteractive/stream-renderer.test.ts`.

### Before — legacy renderer capture

```text
  ▸ thinking collapsed — Ctrl+T to expand
  I'll search your home directory.
  ○ shell.exec find ~ -name '*.pdf'
  ▶ shell.exec running…
  atlas.pdf
  scan.pdf
  report.pdf
  notes.pdf
  
  ○ shell.exec du -sh missing
  ✗ blocked: confirmation required
  ○ fs.edit {"path":"/repo/src/app.ts"}
  ○ tool.batch 2 calls
  ── #1 shell.exec [ok exit=0]
  alpha
  ── #2 fs.read [fail exit=1]
  boom
  ⏹ Aborted.
  Found 6 PDFs over 100 MB.
  
```

### After — split stdout/stderr capture

stdout:

```text
◆ I'll search your home directory.
◆ Found 6 PDFs over 100 MB.
```

stderr:

```text
│ I should search the home directory.
● shell.exec(find ~ -name '*.pdf')
  └ atlas.pdf
    scan.pdf
    report.pdf
    … +1 line
✓ done · 2.4s
● shell.exec(du -sh missing)
✗ failed · 1 · 2.4s
    du: missing: No such file
⊘ fs.delete blocked
    confirmation required
● fs.edit
✓ Edited app.ts                                                          +2 −1
  file  /repo/src/app.ts
● tool.batch(2 calls)
  ✓ shell.exec                                                   done (exit 0)
  ✗ fs.read                                                    failed (exit 1)
  1 failed / 2 sub-tool(s)
✗ failed · 2.4s
    1 of 2 failed
✦ compacting context · ~120,000 tokens before
✦ compacted context · ~120,000 → ~30,000 tokens
⊘ aborted
```

The comparison is intentionally not byte-for-byte identical: the old renderer mixed progress,
tool output, and the answer on one stream, while the new renderer makes the stream boundary
explicit, uses the shared status glyphs/presenters, and keeps output append-only.

## Confirmation and exit behavior

| Situation | Exit code | Evidence |
| --- | ---: | --- |
| Completed turn, including succeeded, partial, blocked, failed, or paused-budget outcome | `0` | `exitCodeForOutcome()` and non-interactive tests. |
| SIGINT/SIGTERM abort | `130` | `exitCodeForOutcome({ status: "aborted" })` and abort test. |
| Unhandled execution error | `1` | `exitCodeForError()` and the outer CLI error path. |
| Loader/startup failure | `1` | Outer CLI error path; no unconditional `process.exit(0)` remains. |

`-y` retains the existing exceptions for `fs.delete` and forced confirmations. A non-TTY
confirmation without authorization refuses instead of hanging, and the refusal is rendered as a
blocked tool result.

## Verification

| Command | Result |
| --- | --- |
| `npm run typecheck` | clean |
| `npx vitest run test/noninteractive test/agent/runner-no-direct-writes.test.ts` | 8 files, 206 passed |
| `npx vitest run test/agent` | 21 files, 214 passed |
| `npx vitest run test/classic` | 48 files, 779 passed, 10 skipped |
| `npx vitest run test/tui-v2 test/app` | 51 files, 331 passed |
| `npx vitest run test/classic/startup.test.tsx test/classic/terminal-session.test.ts test/tui-v2/bootstrap/pager-export-port.test.ts` | 23 tests passed |
| `npx tsx src/index.ts --help` | passed; help includes all three one-shot flags and says UI flags are ignored with a prompt |
| `npm ls @inquirer/prompts --all --depth=0` | empty; package is absent from direct dependencies and lockfile |
| `git diff --check` | clean |

## Deferred cleanup

`src/ui/spinner.ts` is not deleted in W14 because `src/repl.ts` and
`src/agent/classic-renderer.ts` still import it. `src/ui/output-pane.ts` and
`src/ui/ansi-box.ts` also remain live: the runner uses sanitization and viewport registration,
while the REPL, prompt line, and plan-decision paths use pager/ANSI helpers. W16 removes the
line REPL and classic renderer first; only then can the spinner and any newly dead UI helpers be
deleted with grep proof. The combined W14 cleanup checkbox remains unchecked.

## Manual gates and deviations

The W08, W09, W10, W11, and W13 manual gates remain unchecked. W14 adds no manual sign-off and
no new deviation row. D-09 through D-12 remain pending as listed in `12-TASKS.md`.
