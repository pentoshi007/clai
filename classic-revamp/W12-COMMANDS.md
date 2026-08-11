# W12 — Command parity (record)

## Scope

Prove every catalogue command works against the classic frontend without touching a single
handler body, and close the one W09/W11 finding that would have shipped a visible dead
shortcut.

## File map

| File | Change |
| --- | --- |
| `test/classic/commands.test.ts` | **New.** 35 tests. Every catalogue command dispatched in a classic harness with a state, config, transcript, or overlay assertion. |
| `test/classic/app/queue-actions.test.ts` | **New.** 6 tests. The four queue chords advertised in the queue header now resolve and act. |
| `test/classic/app/harness.ts` | Options gained `commands`, `requestExit`, `updates`, `agent`; `attachCommandHandlers` runs when `commands` is set. |
| `src/ui-core/actions/action-id.ts` | Added `queue.select-prev`, `queue.select-next`, `queue.send-now`, `queue.edit`, `queue.remove`. |
| `src/ui-core/actions/keymap.ts` | Bound those five in the `global` context: `ctrl+alt+up/down/enter/e/backspace`. |
| `src/classic/app/action-handlers.ts` | New `handleQueue` group; `ClassicActionHost` gained four queue members. |
| `src/classic/app/app-wiring.ts` | Implemented `moveQueueSelection`, `sendQueuedNow`, `editQueued`, `removeQueued` over the existing `SessionController` queue API. |
| `test/classic/input/chord-table.test.ts` | `bytesForChord` learned modified CSI final-byte and CSI-tilde forms (`\x1b[1;7A`) and `backspace` as CSI-u 127, so the new chords are covered by the existing round-trip table. |

**No `src/ui-core/commands/*` file changed.** That is the W12 gate's central constraint: the
classic frontend works with the handlers exactly as W02 moved them, so no OpenTUI re-check
was required. `git status` confirms no modification under `src/ui-core/commands/` in this
package.

## Command coverage

`test/classic/commands.test.ts` registers each command it exercises in a `covered` set, and
a final test diffs that set against `slashCommands`, so a new catalogue entry fails the suite
until it is exercised. All 45 catalogue entries (40 canonical + 5 aliases) are covered.

| Command | Assertion |
| --- | --- |
| `/ask`, `/agent` | `session.mode` and `config.defaultMode` |
| `/model <name>` | `session.model` |
| `/models` | sticky `models-fetch` toast raised (the cross-provider fetch itself is network-bound, so the deterministic assertion is the toast contract) |
| `/provider`, `/use` | alias resolves to `provider`; `session.provider` |
| `/set`, `/unset` | picker overlay opens |
| `/keys` | pager titled `Credential status` |
| `/info` | pager titled for the active provider |
| `/search`, `/search-provider` | alias resolves; search picker opens |
| `/effort`, `/reasoning` | alias resolves; `config.thinking.enabled` / `.effort` |
| `/clear` | transcript empty, session id unchanged, `Context cleared` toast |
| `/new` | new session id, plan approval reset, `Fresh session` |
| `/clean` | new session id, `plan.clear` called |
| `/history` | picker opens with `__current__` first |
| `/save` | empty → `nothing to save yet`; with history → `saved session <id>` |
| `/reset` | `history cleared` against the sandboxed store |
| `/cwd` | reports cwd, chdirs, rejects a missing directory |
| `/allow`, `/disallow` | `session.allowedTools()` |
| `/think`, `/thinking` | alias resolves; `expandThinkingGlobal` toggles both ways |
| `/output` | empty → `no tool output yet`, `expandOutputGlobal` untouched |
| `/jobs` | overlay kind `jobs` |
| `/freeonly`, `/fallback` | `config.freeOnly`, `config.providerFallback`, status notice |
| `/compact` | `nothing to compact yet` |
| `/context` | `context: 2 messages` |
| `/plan` | plan mode on, `off` returns to agent, `view` pages |
| `/implement` | inert with no plan: no plan, no approval, mode unchanged |
| `/discard` | `no active plan to discard` |
| `/scope` | scope-editor overlay opens; `clear` disables scoping |
| `/privacy` | `config.privateMode` on/status/off |
| `/permissions` | `config.permissions`, then the `Permissions` picker |
| `/update` | the injected updates port produces a notice |
| `/exit`, `/quit` | alias resolves; `requestExit` called once |
| `/help` | pager `Commands`, body contains `/model` **and** `/jobs` |
| `/shortcuts` | pager `Keyboard shortcuts` with a non-empty body |

### Store sandboxing

`/reset`, `/save`, `/history`, `/scope`, and `/set` all reach the real store. The suite
redirects `CLAI_DATA_DIR`, `CLAI_HISTORY_DIR`, `CLAI_CONFIG_DIR`, `CLAI_SCOPE_FILE`,
`CLAI_PLAN_FILE` to a `mkdtemp` directory and sets `CLAI_DISABLE_KEYCHAIN=1` for the whole
file, restoring every variable and the process cwd afterwards. No test touches the
developer's real history.

### Async handlers

`attachCommandHandlers` registers several handlers as `void handleX(...)`, so `dispatch`
resolves before the handler settles. Those cases assert through `vi.waitFor` rather than
sleeping.

## Queue chords (W09/W11 finding closed)

04-UI-SPEC §4.4 renders `^⌥↑↓ select · ^⌥⏎ send now · ^⌥E edit · ^⌥⌫ drop` in the queue
header, and 09-PARITY requires the queue to support send-now, edit, reorder, and remove.
Until this package those hints had no bound action — a visible dead shortcut, which the
tracker forbids. The five new action ids map onto the queue API that
`SessionController` already exposed (`sendQueuedNow`, `takeQueued`, `removeQueued`), so no
new session behaviour was invented:

| Chord | Action | Effect |
| --- | --- | --- |
| `^⌥↑` / `^⌥↓` | `queue.select-prev` / `queue.select-next` | wraps the selection over the queue |
| `^⌥⏎` | `queue.send-now` | `sendQueuedNow(selected)` — steers a running turn, submits when idle |
| `^⌥E` | `queue.edit` | `takeQueued(selected)` into the composer draft |
| `^⌥⌫` | `queue.remove` | `removeQueued(selected)` |

An empty queue answers with a `no queued prompts` toast instead of acting on nothing.
Reorder is covered by select + send-now (promotion), which is the only reordering the header
advertises; `reorderQueued` stays available but unbound, matching OpenTUI, which offers no
reorder affordance either.

## Verification

| Command | Result |
| --- | --- |
| `npm run typecheck` | clean |
| `npx vitest run test/classic/commands.test.ts` | 35 passed |
| `npx vitest run test/classic/app/queue-actions.test.ts` | 6 passed |
| `npx vitest run test/classic test/ui-core test/app` | 106 files, 1319 passed, 10 skipped |
| `npx vitest run test/tui-v2` | 36 files, 217 passed |

## Findings for later

- `/models` cannot be asserted end-to-end offline: `collectAllModels` fans out to every
  configured provider. W14 should give it an injectable catalogue source if the
  non-interactive surface needs it.
- `session.sendQueuedNow` submits immediately when no turn is running, so the classic
  harness needs a stub agent for that path. Noted for W13's session tests.
- Status row 3 still passes `permissions: []` and the branch segment is still `undefined`
  (carried from W09; both are W18 polish, not parity gaps).

## Deviations

None. No new row in the deviation log.
