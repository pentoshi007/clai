# Parity Contract

## The rule

The classic frontend may look different from OpenTUI where the renderers differ. Every user
workflow, state transition, command, shortcut, safety decision, and persisted result must be
equivalent. A renderer limitation is acceptable only with a keyboard-accessible alternative
and an entry in §"Approved deviations". Anything else is a gap and blocks release.

Check a box only after running the test or the manual step that proves it.

## Approved deviations

These are consequences of the scrollback-feed model
([03-RENDER-MODEL.md](03-RENDER-MODEL.md) §1) and are accepted deliberately.

| ID | OpenTUI behaviour | Classic behaviour | Alternative | Rationale |
|---|---|---|---|---|
| D-01 | Transcript scrolls inside an owned viewport with a custom scrollbar | The terminal's own scrollback scrolls; no scrollbar is drawn | native wheel and scrollbar; `Ctrl+R` search; `/output` picker | Ink has no scroll container; owning the screen costs native scrollback, native selection, and repaint cost |
| D-02 | `Ctrl+T` / `Ctrl+O` / `Enter` re-render any transcript row in place | Toggles apply to live rows and to all future rows; committed rows keep what was printed | `Ctrl+O` with nothing live opens the `/output` picker; `Ctrl+T` opens the last thinking block in the pager; `Enter` on a committed row opens it in the pager | `<Static>` output cannot be taken back |
| D-03 | Mouse drag selects transcript text; wheel scrolls; rows are clickable | Mouse reporting off by default; `CLAI_CLASSIC_MOUSE=1` enables wheel and row clicks only | native terminal selection and copy; `Ctrl+A` + `Ctrl+Shift+C` for programmatic copy; every click affordance has a key | Enabling mouse reporting removes native selection, which is how copying works in a feed |
| D-04 | `transcript.top` / `page-up` / `page-down` move an owned viewport | They move the live tail when it is clipped, otherwise show a one-shot hint | terminal scrollback; `Ctrl+R`; `/history` | nothing can scroll the host terminal's scrollback programmatically and reliably |
| D-05 | Plan renders as a side-by-side split pane on terminals ≥ 120 columns | Plan renders as a bounded full-width panel above the composer | `Ctrl+H` panel; `Ctrl+P` full detail in the pager | a split pane requires owning the screen, which D-01 gives up |
| D-06 | Toasts slide in from the top with easing, up to 3 visible | Up to 2 rows above the composer, no animation, `(+1)` marker when one is hidden | same content, same lifetimes, same replace-by-key | animation in a feed would repaint committed rows |
| D-07 | Overlays render full-bleed over the whole screen | Overlays are bounded panels sized by the row allocator | identical content and keys | guarantees no overflow at any terminal size |
| D-08 | OSC 8 hyperlinks on detected URLs and file paths | Links are colour-accented but not clickable unless the terminal handles bare URLs | paths and URLs are still selectable and copyable natively | Ink has no link primitive; emitting raw OSC 8 inside `<Text>` is unverified — revisit if a spike proves it safe |

No other deviation is approved. If implementation reveals a new one, add a row here with a
rationale and an alternative, and flag it in the completion report.

## Launch and lifecycle

- [ ] Starts in Windows Terminal, PowerShell 5.1 and 7, cmd.exe/conhost, VS Code terminal,
      Git Bash.
- [ ] Starts on macOS and Linux with `--classic`.
- [ ] Windows with no flag starts classic without probing Bun and without importing
      `@opentui/*`.
- [ ] One-shot with a prompt never loads Ink, React, or Yoga.
- [ ] Non-TTY stdin or stdout runs the non-interactive surface, never Ink.
- [ ] Every exit path restores cursor visibility, raw mode, bracketed paste, and mouse mode
      exactly once.
- [ ] No exit path leaves the terminal echo-less or colour-corrupted.
- [ ] First Ctrl+C aborts a running turn or arms exit; second within 1500 ms exits.
- [ ] First Esc dismisses or arms; second within 1500 ms cancels turn, compaction, queue,
      and session responder jobs.
- [ ] One physical Esc reaching two handlers counts once.
- [ ] SIGTERM → 143, SIGHUP → 129, second SIGINT → 130, uncaught error → 1.
- [ ] Session persistence completes before process exit on every path.
- [ ] Interactive sessions close; no orphaned child process tree.
- [ ] `CLAI_CLASSIC_UI=plain` starts the stream renderer.
- [ ] OpenTUI startup and behaviour unchanged on macOS and Linux.

## Session and agent behaviour

- [ ] Both interactive frontends construct the same `SessionController` and agent adapter.
- [ ] Ask, agent, and plan modes produce identical turn requests.
- [ ] The same `AgentEvent` sequence produces the same `TranscriptState` in both frontends.
- [ ] Safety confirmations, plan gates, scope enforcement, and tool permissions identical.
- [ ] Native and text tool-calling unaffected by frontend choice.
- [ ] Provider fallback, key rotation, responder behaviour, compaction, and context
      accounting unaffected.
- [ ] `--no-history` and privacy mode suppress persistence identically.
- [ ] `-y` bypasses confirmations except `fs.delete` and `forceConfirm`, and never persists
      pentest authorization.

## Composer

- [ ] Enter submits; the draft clears; the prompt appears as a user block.
- [ ] Shift+Enter inserts a newline where the terminal reports it.
- [ ] Alt+Enter inserts a newline everywhere as the fallback.
- [ ] The newline hint matches the chord the terminal actually delivers.
- [ ] Left/right/Home/End/Backspace/Delete and multiline up/down are correct, including CJK,
      emoji, and combining marks.
- [ ] Up/Down browse prompt history only when `arrow-intent` permits; the draft is restored
      on exit from history.
- [ ] Ctrl+X clears the draft; Ctrl+Shift+X copies then clears.
- [ ] Slash completion uses the shared catalogue, including aliases and unique prefixes.
- [ ] `@` completion covers files, directories, quoted paths with spaces, images, and cwd.
- [ ] A prompt starting with `/` that is an absolute path is not treated as a command.
- [ ] Large pastes become bounded placeholders and expand correctly at submit.
- [ ] Bracketed paste content never triggers a shortcut.
- [ ] Clipboard image paste and dropped image paths follow the existing attachment
      preparation and capability fallback.
- [ ] Typing while a turn runs enqueues the prompt.
- [ ] Confirm and secret panels lock composer input.
- [ ] Resize preserves the draft and the cursor position.

## Feed

- [ ] Intro card shows the CLAI wordmark, provider, model, mode, permissions, cwd, version,
      tagline, and welcome line, and reflows at narrow widths.
- [ ] User blocks wrap per `wrapUserPrompt` and collapse past 6 rows.
- [ ] Assistant markdown streams without fence or table corruption.
- [ ] Thinking streams live regardless of the toggle and respects the toggle once closed.
- [ ] Tool blocks show name, args, queued/running/ok/failed/blocked state, summary, exit
      code, and a bounded preview.
- [ ] `tool.batch` shows nested sub-tools with live progress.
- [ ] Artifact-backed output opens in the pager without loading the whole file.
- [ ] File mutations show diff previews with correct add/delete counts and syntax colours.
- [ ] Compaction start, stream, success, failure, and token labels match shared state.
- [ ] Notices appear as toasts and never enter model history.
- [ ] `Ctrl+R` finds semantic content and navigates matches.
- [ ] `Ctrl+A` then `Ctrl+Shift+C` copies the transcript.
- [ ] Hydration from `/history` restores tools, diffs, thinking, compaction, and plans.
- [ ] Committed rows are never duplicated, reordered, or overwritten.
- [ ] No rendered row exceeds the terminal width at any size in the golden set.

## Plan, queue, jobs, responder

- [ ] `Ctrl+H` toggles the tasks panel.
- [ ] `Ctrl+P` opens full plan detail.
- [ ] Task state, dependencies, owner chips, notes, progress, and the active task are
      visible.
- [ ] Draft plan confirmation supports implement, discard, suggest, dismiss, and view.
- [ ] `/implement` uses the shared plan lifecycle and compaction behaviour.
- [ ] Queue shows pending prompts and supports send-now, edit, reorder, and remove.
- [ ] Queue drains after completed and aborted turns.
- [ ] `Ctrl+J` and `/jobs` open the jobs panel.
- [ ] Jobs show status, elapsed, command, and ownership; support stop, tail, live view.
- [ ] Responder strip reflects foreground and background responder state.
- [ ] Responder completion refreshes plans without duplicate notifications.

## Panels

- [ ] Picker supports filtering, active row, descriptions, two-line and history styles, row
      actions, and an empty state.
- [ ] Confirm supports tool, pentest, reset, continue, switch, and plan variants with the
      shared prompt strings.
- [ ] Delete confirm previews the file without resolving.
- [ ] Plan confirm views detail without resolving.
- [ ] Secret input masks, sanitizes control and mouse sequences, supports cancel, and never
      persists plaintext anywhere.
- [ ] Scope editor adds, removes, resets, and saves multiple targets; empty save disables
      scoping.
- [ ] Keys editor supports multiple rows, add, remove, reset all, and the sticky active
      marker; the endpoint variant reveals full URLs.
- [ ] Prompt actions support copy, resend, and edit.
- [ ] Pager over confirm and pager over jobs restore the suspended overlay on close.
- [ ] Closing an overlay restores the previous focus region.
- [ ] No key is handled by two active surfaces.
- [ ] Opening a second blocking overlay resolves safely instead of hanging.

## Pager

- [ ] Opens tool output, plan, help, shortcuts, provider info, key status, file previews, and
      job tails.
- [ ] Line, page, half-page, top, and bottom navigation.
- [ ] Search, next match, previous match.
- [ ] Formatted markdown and raw views.
- [ ] Live job follow and pause.
- [ ] Copy.
- [ ] Export to scrollback.
- [ ] Export to `$EDITOR`, restoring the UI even when the editor fails.
- [ ] Bounded paging and search for large artifacts.
- [ ] Syntax and diff gutters preserved without width overflow.

## Status, theme, layout

- [ ] Status shows mode, provider/model, activity, elapsed, queue, plan, context usage and
      limit, and active toggles at the appropriate density.
- [ ] Shift+Tab cycles ask → agent → plan and persists the mode.
- [ ] Ctrl+T and Ctrl+O update their status indicators.
- [ ] Ctrl+G and `/help` open commands; `/shortcuts` opens the generated key reference.
- [ ] The context limit is editable and persists.
- [ ] API-key rotation shows one replaceable toast.
- [ ] Toasts never reflow the feed.
- [ ] Dark and light hints, truecolor, 256, 16, `NO_COLOR`, and ASCII fallback all render
      legibly.
- [ ] Layout is correct at 40, 48, 68, 80, 96, 120, and 200 columns and at 8, 12, 24, and 50
      rows.
- [ ] CJK, emoji, combining marks, long paths, and ANSI-bearing tool output never overflow.
- [ ] No frame writes into the terminal's final cell.

## Commands

Every catalogue command dispatched in a classic harness with its service-state or overlay
outcome asserted, not merely name resolution:

- [ ] `/ask` `/agent` `/plan` `/implement` `/discard`
- [ ] `/model` `/models` `/provider` `/use`
- [ ] `/set` `/unset` `/keys` `/info`
- [ ] `/search` `/search-provider`
- [ ] `/effort` `/reasoning`
- [ ] `/clear` `/new` `/clean` `/reset`
- [ ] `/history` including delete
- [ ] `/save` `/compact` `/context`
- [ ] `/cwd` `/allow` `/disallow` `/permissions`
- [ ] `/think` `/thinking` `/output`
- [ ] `/jobs`
- [ ] `/freeonly` `/fallback` `/scope` `/privacy`
- [ ] `/update` `/help` `/shortcuts` `/exit` `/quit`

## Shortcuts

`defaultKeymap` is the source of truth. No handwritten shortcut list in classic.

- [ ] Every binding in `defaultKeymap` has a decoder path proven by
      `test/classic/input/chord-table.test.ts`.
- [ ] Ctrl+C, Esc, Ctrl+G, Ctrl+H, Ctrl+P, Ctrl+J, Ctrl+T, Ctrl+O, Shift+Tab, Ctrl+D, Tab
      behave as specified per context.
- [ ] Every composer, picker, modal, plan, pager, and jobs binding is exercised.
- [ ] Trapping contexts swallow unbound chords instead of firing global actions.

## Non-interactive

- [ ] `clai "prompt"` and `clai --mode agent "prompt"` render assistant text, tool cards,
      diffs, and the final answer.
- [ ] The answer appears only on stdout; all progress only on stderr.
- [ ] `--show-thinking`, `--verbose`, `--quiet` behave as documented.
- [ ] Non-TTY output contains no ANSI and no `\r`.
- [ ] The spinner clears before any stdout write and never appears on a non-TTY stderr.
- [ ] Confirmations work on a TTY and fail fast, rather than hanging, on a non-TTY without
      `-y`.
- [ ] Exit codes 0 / 130 / 1 per [06-ONESHOT.md](06-ONESHOT.md) §5.

## Performance

- [ ] Streaming does not re-render the whole feed per token.
- [ ] A scripted 60-second turn with 200 tool-output lines and 8,000 deltas produces fewer
      than 400 frame writes.
- [ ] CPU stays under 5 % of one core during that turn.
- [ ] A 10,000-item hydrated history remains interactive.
- [ ] Resize and spinner ticks never duplicate subscriptions or command handlers.
- [ ] No listener, timer, subscription, or raw-mode reference leaks after unmount.
- [ ] Committed block line arrays are released after `<Static>` renders them.

## Cleanup

- [ ] `src/repl.ts`, `src/repl/`, and `src/agent/classic-renderer.ts` no longer exist.
- [ ] `writesDirectly` no longer appears in `src/agent/runner.ts`.
- [ ] `@inquirer/prompts` is absent from `package.json` and the lockfile.
- [ ] Every file in [11-CLEANUP.md](11-CLEANUP.md) is deleted or justified.
- [ ] npm package size and POSIX binary sizes decreased; numbers recorded.
