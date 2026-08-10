# Non-interactive Surface

Covers `clai "prompt"`, `clai --mode agent "find all pdf files on my computer larger than
100mb"`, piped stdin/stdout, CI, and `CLAI_CLASSIC_UI=plain`.

## 1. The problem with the current path

`oneShot` calls `runAgent` without `onEvent`, so `src/agent/runner.ts:568` sets
`writesDirectly = true` and the runner itself formats and prints the turn. There are 30
`writesDirectly` references spread through a 6656-line file, including
`writeStatus`, `writeNotice`, `writeAssistantMessage`, `writeThinkingBlock`,
`writeToolOutput`, `writeToolCall`, `writePlanUpdate`, `writeToolBlocked`, `writeAbort`,
the compaction header/delta/footer writers, the spinner selection, the tool-result status
glyph, and the `renderTurnOutcome` write.

Consequences:

- The agent layer owns presentation, which is why one-shot output looks nothing like the
  interactive surfaces and drifts every time either changes.
- Two renderings of the same turn exist and must be kept in sync by hand.
- `src/agent/runner.ts` cannot be reasoned about as pure orchestration.
- `src/ui/spinner.ts`, `src/ui/output-pane.ts`, and `src/ui/ansi-box.ts` stay alive only to
  serve this branch.

## 2. Target design

```
src/noninteractive/
  start-noninteractive.ts     entry: builds the minimal composition, runs the turn, exits
  stream-renderer.ts          AppEvent → ordered stdout lines
  stream-blocks.ts            per-event-kind line builders (shared presenters)
  stdio-confirm-port.ts       readline confirm/secret, replaces @inquirer/prompts
```

`start-noninteractive.ts` builds a **minimal** composition — session controller plus agent
port, no overlay, no toast, no selection, no plan pane — and passes an `onEvent` that feeds
`stream-renderer.ts`. `runAgent` is therefore always called *with* `onEvent`, and
`writesDirectly` disappears.

`stream-renderer.ts` is a small class, not React:

```ts
interface StreamRendererOptions {
  readonly out: NodeJS.WritableStream;
  readonly err: NodeJS.WritableStream;
  readonly columns: number;
  readonly color: boolean;
  readonly unicode: boolean;
  readonly verbosity: "quiet" | "normal" | "verbose";
  readonly showThinking: boolean;
}

class StreamRenderer {
  handle(event: AgentEvent): void;
  finish(outcome: TurnOutcome): void;
}
```

It reuses the same presenters as the Ink feed — `tool-presenter.ts`,
`render-markdown-lines.ts`, `file-diff-view.ts`, `batch-sections.ts`, `plan-view.ts`,
`thinking-tail.ts`, `sanitize-display.ts` — so a tool card in one-shot output is the same
card the interactive feed shows, minus the interactive affordances. That shared-presenter
rule is what stops the two surfaces from drifting again.

`stream-blocks.ts` holds one pure function per event kind returning
`readonly string[]`, so every line is unit-testable without a stream.

## 3. Output shape

`clai --mode agent "find all pdf files on my computer larger than 100mb"` on a colour TTY:

```
◆ I'll search your home directory for large PDFs, then report sizes.

● shell.exec(find ~ -type f -iname '*.pdf' -size +100M -print0 | xargs -0 ls -lh)
  └ -rw-r--r--  1 you staff  142M Feb  3 11:20 /Users/you/Downloads/atlas.pdf
    -rw-r--r--  1 you staff  118M Jan 12 09:04 /Users/you/Docs/scan-2025.pdf
  … +4 lines
✓ done · 3.2s

◆ Found 6 PDFs over 100 MB:

  1. ~/Downloads/atlas.pdf — 142 MB
  2. ~/Docs/scan-2025.pdf — 118 MB
  …

  Total 812 MB across 6 files.
```

Rules:

1. **Append-only.** One write per logical line group. No cursor movement, no erase
   sequences, no repaint. The stream is a transcript, and it must remain correct when
   redirected to a file mid-run.
2. **Same glyphs and colours** as the feed, from the same tables, degraded by the same
   `colorMode` ladder.
3. **stdout carries the answer. stderr carries progress.** Status lines, the spinner,
   notices, and diagnostics go to stderr. This makes
   `clai --mode agent "…" > answer.md` produce a clean file, which the current
   implementation does not.
4. **Thinking is off by default** in one-shot, printed to stderr with the `│` gutter when
   `--show-thinking` or `CLAI_SHOW_THINKING=1` is set. Reasoning is noise in a script and
   essential when debugging one.
5. **Tool output is bounded** to the same 3-line collapsed preview plus
   `… +N lines`, and the artifact path is printed once on stderr as
   `saved <path>` when one exists. `--verbose` raises the cap to 40 lines.
6. **File diffs** print the title row plus `+N −M`, then hunks only under `--verbose`.
7. **The final answer** is `renderTurnOutcome(outcome)` written to stdout exactly once, at
   the end, by `finish()`. It is never written twice — the current double-render in
   `src/modes/agent.ts` (which renders the outcome again purely to return a string) is
   removed; the return value becomes the already-rendered text.
8. **Compaction** prints one stderr line at start and one at completion with the token
   label. No streaming body.

### Non-TTY

When `stdout.isTTY` is false: `color: false`, no spinner, no `\r`, no ANSI at all, plain
`[tool] name` prefixes instead of glyphs. A snapshot test pins the current non-TTY byte
stream **before** any change lands, and the new implementation must produce output that is
still line-oriented, still parseable, and still contains the same information. Byte-for-byte
equality is not required — the current output is what we are improving — but the change must
be reviewed as a deliberate diff, recorded in the completion report.

### Spinner

Only when `stderr.isTTY`. One line on stderr, rewritten with `\r`, cleared with
`\r\x1b[K` before any stdout write so the two streams never interleave mid-line:

```
⠋ waiting for model · 12s
⠙ tool: shell.exec · 7s
⠹ generating response · 240 tokens · 18s
```

Labels come from the same `status` events the interactive surface consumes, so the phrasing
matches. `src/ui/spinner.ts` is replaced by a ~40-line
`noninteractive/stream-spinner.ts` that writes to the injected `err` stream, making it
testable, and then deleted.

## 4. Confirmations without inquirer

`@inquirer/prompts` is currently used by `src/agent/confirm-port.ts`,
`src/agent/plan-decision.ts`, `src/repl.ts`, `src/commands/providers.ts`, and
`src/commands/search-providers.ts`.

`noninteractive/stdio-confirm-port.ts` implements `ConfirmationPort` and
`SecretPort["request"]` on `node:readline/promises`:

- `confirmTool` / `confirmPentest` / `confirmContinue` / `confirmAgentSwitch` — a `y/n`
  question with the exact prompt strings from `ui-core/bootstrap/overlay-ports.ts`, so all
  three surfaces ask the same question in the same words.
- `request` for secrets — echo disabled by writing `\x1b[8m` before and `\x1b[28m` after,
  falling back to no echo suppression only when stdin is not a TTY, in which case the value
  is read from a single line without display.
- Non-TTY stdin with no `-y`: do not hang. Fail the tool with
  `confirmation required; re-run with -y or --permissions allow-all` and let the runner
  surface it as a blocked tool. The current behaviour — an inquirer prompt against a
  non-TTY stdin — is a hang, and that is a bug this migration fixes.
- `-y` semantics are preserved exactly: it short-circuits everything **except**
  `fs.delete` and `forceConfirm`, and it flips pentest authorization for the session only,
  never persisting it.

`src/commands/providers.ts` and `src/commands/search-providers.ts` use inquirer for their
own pickers. Convert them to the same readline helpers in W14. Only then can
`@inquirer/prompts` be removed from `package.json`.

## 5. CLI additions

| Flag | Env | Effect |
|---|---|---|
| `--show-thinking` | `CLAI_SHOW_THINKING=1` | print reasoning to stderr |
| `--verbose` | — | raise tool-output and diff caps |
| `--quiet` | — | answer only; suppress all stderr progress |

Existing flags keep their meaning. `-y`, `--no-history`, `--provider`, `--model`, `--mode`
are untouched. `--ui`/`--classic`/`--tui` remain ignored when a prompt is present, and
`--help` says so.

Exit codes:

| Situation | Code |
|---|---|
| turn completed, including a soft failure | 0 |
| turn aborted by signal | 130 |
| unhandled error | 1 |
| loader failure | 1 |

The current code exits 0 unconditionally at `src/index.ts:178`. Distinguishing abort from
success is a small, real improvement for scripting; it is a behaviour change and must be
listed in the completion report and the changelog.

## 6. Removing `writesDirectly`

Sequence, all inside W14 so the runner is never half-converted:

1. Build `src/noninteractive/` and its tests against the existing `AgentEvent` stream. Do
   not touch the runner yet.
2. Switch `oneShot` in `src/index.ts` to `startNoninteractive`.
3. Verify: golden-fixture comparison of the old and new output for a scripted turn covering
   assistant text, thinking, three tools, one failure, one blocked tool, a file diff, a
   batch, a compaction, and an abort. Record both outputs in the completion report.
4. Delete from `src/agent/runner.ts`: the `writesDirectly` constant, every
   `if (writesDirectly)` branch, the `noopSpinner` stub, the `startThinkingSpinner` call and
   import, and the direct-write bodies of all `write*` helpers — each becomes a plain
   `emit(...)`.
5. Delete the now-unused imports of `src/ui/spinner.ts`, `src/ui/output-pane.ts`,
   `src/ui/ansi-box.ts`, and `src/ui/markdown.ts` from the runner if nothing else in it
   needs them.
6. Add `test/agent/runner-no-direct-writes.test.ts` asserting `src/agent/runner.ts`
   contains no `process.stdout.write` and no `writesDirectly` identifier. This is the guard
   that stops the branch reappearing.
7. Run the full suite. `test/classic-renderer.test.ts` is deleted in the same package
   because its subject is gone; its assertions about event→text mapping move to
   `test/noninteractive/stream-blocks.test.ts`.

Expected reduction in `src/agent/runner.ts`: roughly 250–350 lines, and the file stops
importing any UI module.

## 7. Tests

| File | Asserts |
|---|---|
| `test/noninteractive/stream-blocks.test.ts` | one pure line-builder per event kind, at widths 40/80/120, colour on and off |
| `test/noninteractive/stream-renderer.test.ts` | full scripted event sequence → exact stdout and stderr strings, via injected fake streams |
| `test/noninteractive/stream-split.test.ts` | the answer appears only on stdout; every progress line only on stderr |
| `test/noninteractive/nontty.test.ts` | no ANSI byte and no `\r` in the output when `isTTY` is false |
| `test/noninteractive/spinner.test.ts` | clears itself before a stdout write; never writes when stderr is not a TTY |
| `test/noninteractive/confirm.test.ts` | `y`/`n` parsing, secret echo suppression, `-y` bypass with the `fs.delete` and `forceConfirm` exceptions, non-TTY refusal instead of a hang |
| `test/noninteractive/exit-codes.test.ts` | 0 / 130 / 1 per §5 |
| `test/agent/runner-no-direct-writes.test.ts` | the guard from §6 step 6 |
