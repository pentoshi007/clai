# W16 — Delete the line REPL

## Result

W16 removes the legacy line-oriented frontend and its renderer-only support cluster. `src/index.ts` no longer imports or calls `startRepl`; no source file imports the removed `src/repl` tree. No alternate interactive input mode was restored. A no-argument noninteractive launch reads a piped stdin prompt through `src/noninteractive/read-stdin.ts`; an empty noninteractive launch still reports `No prompt supplied; pass a prompt or pipe one on stdin.`

## Migrations

- Persisted classic-shaped transcript contracts moved to `src/app/ports/transcript-item.ts`; app adapters, session controller, persistence port, history store, transcript hydration, and the redaction-cache test use the app port.
- The old classic transcript reducer, serializer, and test were removed. Normalized live transcript reducer, hydration, and compaction tests remain authoritative.
- `src/agent/runner.ts` now aliases `sanitizeDisplayText` from `src/ui-core/rendering/sanitize-display.ts` and no longer registers legacy output-pane viewports. Tool output remains in the shared event/spool path.
- Composer helper tests now target `src/ui-core/composer/history-nav.ts` and `src/ui-core/composer/newline-hint.ts`.
- Transcript export tests now target `src/ui-core/rendering/transcript-export.ts`.
- The app-port test no longer exercises the deleted terminal adapter; the issues sweep no longer imports deleted classic key helpers. Legacy spinner and output-pane tests were removed in favor of noninteractive spinner and current pager/renderer coverage.

## Deleted legacy sources and tests

- `src/repl.ts`, `src/repl/prompt-line.ts`
- `src/agent/classic-renderer.ts`
- `src/ui/ansi-box.ts`, `src/ui/banner.ts`, `src/ui/intro-card.ts`, `src/ui/keys.ts`, `src/ui/output-pane.ts`, `src/ui/spinner.ts`, `src/ui/task-pane.ts`
- `src/tui-v2/bootstrap/disable-native-selection.ts`
- `src/tui-v2/composer/history-nav.ts`, `src/tui-v2/composer/newline-hint.ts`
- `src/tui-v2/rendering/transcript-export.ts`
- `src/app/adapters/current-terminal-adapter.ts`, `src/app/controllers/job-controller.ts`
- `src/tools/reducers/generic.ts`, `src/safety/path-permissions.ts`
- `test/classic-renderer.test.ts`, `test/classic-lifecycle.test.ts`, `test/repl.test.ts`, `test/slash-vs-path.test.ts`
- `test/output-pane.test.ts`, `test/spinner.test.ts`, `test/spinner-sgr-leak.test.ts`, and the old classic transcript reducer test

The two deprecated candidates were checked before removal: `src/tools/policies/output-policy.ts` selects explicit reducers and does not reference `genericReducer`; `src/safety/classifier.ts` does not reference `path-permissions`, `PathGrant`, `hasPathGrant`, or `addPathGrant`.

## Architecture proof

The repository-wide guard in `test/app/architecture-guard.test.ts` walks `src/` and rejects static, side-effect, or dynamic imports resolving to `repl.ts` or `repl/`. The final source/test search for the deleted module paths returned no matches. The ui-core guards explicitly allow the existing ANSI markdown renderer and the injected pager export port, while continuing to reject renderer-framework imports and unauthorized terminal writes.

## Measured line counts

- Current `src/**/*.ts` and `src/**/*.tsx`: **120,140 lines**.
- W16 deleted source paths represented **5,093 lines** from the pre-migration source set, including the 643-line original `src/tui/state.ts` that had been staged as the classic transcript move.
- New W16 helper/port files add **85 lines** (`read-stdin.ts`: 9; `transcript-item.ts`: 76).
- `src/agent/plan-decision.ts` was reduced from 117 to 25 lines, a **92-line reduction**, retaining the two live exports required by ui-core plan lifecycle and tests.

These figures describe the W16 cleanup against the already-in-progress W14/W15 working tree; they are not a claim that all earlier migration changes are attributable to W16.

## Validation

- `npm run typecheck` — passed.
- Replacement-focused migration tests — **9 files, 64 passed**.
- `npx vitest run test/classic test/ui-core test/noninteractive test/app test/tui-v2` — **152 files, 1,742 passed, 10 skipped**.
- `npm run build` — passed.
- `npx vitest run` — **402 files, 3,764 passed, 10 skipped**.
- `git diff --check` — passed.

Windows Terminal, PowerShell, cmd.exe/conhost, VS Code Windows terminal, Windows one-shot startup, and native OpenTUI/Process Monitor probes remain unverified on this macOS host. Those gates stay open in W17/W15 and are not represented as completed here. The final automated validation and measurements are recorded in [W18-RELEASE.md](W18-RELEASE.md).
