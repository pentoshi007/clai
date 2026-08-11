# W13 — Session, history, persistence (record)

## Scope

Test-only package. No production file changed: the session path is entirely shared
(`SessionController`, `current-store-adapter`, `transcript-hydrate`,
`ui-core/commands/picker-commands.ts`), and classic already routes through it. W13 proves it,
in both directions, against the real store.

## File map

| File | Owns |
| --- | --- |
| `test/classic/session.test.ts` | **New.** 12 tests: save shape, tool-output bodies, autosave, `--no-history`, private mode, no-user-turn skip, `/history` resume, live-session no-op, shutdown flush ordering, wiring disposal. |
| `test/classic/cross-renderer-history.test.ts` | **New.** 4 tests: OpenTUI→classic, classic→OpenTUI, both-renderers-same-kinds, tool-output bodies round trip. |

Both files redirect `CLAI_DATA_DIR`, `CLAI_HISTORY_DIR`, `CLAI_CONFIG_DIR`, `CLAI_PLAN_FILE`
into a `mkdtemp` sandbox and set `CLAI_DISABLE_KEYCHAIN=1`, restoring every variable
afterwards. The developer's real history is never read or written.

## What is asserted

### Save

`persistNow(name)` calls `PersistencePort.saveSession` exactly once with the model history,
the session id, the given name, and a **visual transcript snapshot** that contains the tool
cards. The snapshot carries each tool's captured output body (`42 passed` from the scripted
turn), which is what makes click-to-pager work after a resume.

### Autosave and the write guards

| Condition | Behaviour |
| --- | --- |
| history has a user turn | writes, always under the current session id |
| `noHistory: true` (`--no-history`) | zero writes, including a named `/save` |
| `config.privateMode` on | zero writes; turning it back off restores writing immediately |
| history has no user turn and no compaction memory | skipped, so an assistant-only state cannot mint a junk row |

Private mode is driven through `/privacy on|off` rather than by poking config, so the test
exercises the command path a user actually takes.

### `/history` resume

A session is written to the real (sandboxed) store with `upsertSession`, carrying a
`serializeForHistory` snapshot of the W07 scripted turn. The test then dispatches `/history`,
takes the picker's own `onSelect`, and asserts the resumed state:

- session id rebinds to the stored id, title restored
- model messages restored in order
- tool cards present, including `fs.edit`
- at least one tool carries `fileChanges` (the diff survives)
- a `thinking` item is present
- a `compacted` card is present

Selecting `__current__` closes the picker and leaves the session id untouched.

### Shutdown flush ordering

`RendererLifecycle` runs disposers **newest-registered first**, awaits each one, and destroys
the handle only after all of them. `start-classic.tsx` registers `persistNow` first, so it
runs *last* among the disposers and still before `handle.destroy()` — the history flush is the
final write before the terminal is torn down. Two tests pin the order, one pins idempotency
(two concurrent `shutdown()` calls produce exactly one flush and one destroy), and one runs
the real `persistNow` in that position and asserts the write landed.

`ClassicAppWiring.dispose()` is asserted to detach every subscription, so a shutdown-time
session notice cannot schedule a repaint after unmount.

## Cross-renderer equivalence

Both shells assemble the same composition root; the classic side additionally attaches
`ClassicAppWiring` so its subscriptions and repaint scheduler take part in the resume exactly
as in the real shell. A fingerprint (item kinds, `name:status` per tool, diff paths, thinking
bodies, compaction summaries, model messages) is compared across the boundary.

| Direction | Result |
| --- | --- |
| write OpenTUI → resume classic | fingerprints equal |
| write classic → resume OpenTUI | fingerprints equal |
| one stored session → resume in both | identical item kinds, tools, diff paths |
| write OpenTUI → resume classic | tool output bodies present in the spool |

One deliberate normalisation: `serializeForHistory` settles a tool that was still `running`
or `queued` when the snapshot was taken into `ok`. A live `running` card and its resumed `ok`
card are the same tool, so the fingerprint applies that same mapping. This is shared-layer
behaviour, identical for both renderers — not a classic deviation.

## Verification

| Command | Result |
| --- | --- |
| `npm run typecheck` | clean |
| `npx vitest run test/classic/session.test.ts` | 12 passed |
| `npx vitest run test/classic/cross-renderer-history.test.ts` | 4 passed |
| `npx vitest run test/classic` | 46 files, 775 passed, 10 skipped |

## Findings for later

- `session.spool` is cleared by `loadHistory`, so any test or code path that seeds tool
  bodies must do so *after* loading history. Worth remembering for W14's non-interactive
  golden comparison.
- `maybeRefreshTitle` calls a provider to generate a session title. It is guarded by
  `noHistory`/`privateMode` but not otherwise injectable; W14 should keep the
  non-interactive surface away from it or inject a title generator.

## Deviations

None.

## Manual gate (deferred)

`Manual: start in OpenTUI, resume with --classic, tools and diffs present` stays unchecked in
12-TASKS.md. It needs an interactive terminal and must not be signed off from automated
evidence.
