# Phase 6 evidence — app, UI core, renderers

Branch `refactor/codebase`. Environment: Linux x64, Node 24, canonical locale/TZ.

## Entry

`test/ui-core test/tui-v2 test/classic test/noninteractive test/app` green before
movement: 206 files, 2,187 passed, 10 skipped.

## Result

| Module | Entry | Now |
|---|---:|---:|
| `src/ui-core/rendering/syntax-highlight.ts` | 1,368 | 179 |
| `src/ui-core/commands/picker-commands.ts` | 1,342 | 534 |
| `src/ui-core/rendering/markdown.ts` | 1,138 | 783 |
| `src/ui-core/state/transcript-reducer.ts` | 877 | 3 (facade) |
| `src/ui-core/state/transcript-hydrate.ts` | 810 | 336 |
| `src/ui/mentions.ts` | 811 | 323 |
| `src/noninteractive/stream-blocks.ts` | 677 | 345 |

New modules: `rendering/syntax/` (language table, keywords, language
highlighters), `rendering/markdown/tables.ts`, `commands/pickers/` (history,
custom-provider, output-pager, search-reasoning), `state/transcript/`,
`state/hydrate/`, `ui/mentions/`, `noninteractive/blocks/`.

Legacy baseline size entries removed: `picker-commands.ts`, `markdown.ts`,
`syntax-highlight.ts`. Three remain: `loop-guard.ts`, `interactive-session/manager.ts`,
`tools/jobs.ts`.

## Two architecture constraints that shaped this phase

1. **ANSI containment.** `test/ui-core/architecture-guard.test.ts` allows raw
   terminal control sequences only in `ports/pager-export-port.ts` and
   `rendering/markdown.ts`. The first table split moved SGR-emitting helpers into
   `markdown/tables.ts` and failed that guard. Rather than widen the allowlist, the
   ANSI-emitting declarations were returned to `markdown.ts` and `tables.ts` was
   left ANSI-free — verified by grep (0 occurrences) and by the guard passing.

2. **No new runtime-policy exception.** Splitting the provider picker out of
   `picker-commands.ts` created a second `ui-core -> src/llm/router.ts` edge, which
   `legacy-baseline.json` is remove-only about. Adding an entry was rejected; the
   router-dependent code (`handleProvider`, `activateProvider`,
   `ensureModalCredentials`, `resolveModelsForProvider`, `persistSessionModel`)
   therefore stays in `picker-commands.ts`, and only the router-free pickers were
   extracted. That is why the facade is 534 lines rather than under 500 — it is a
   held improvement from 1,342, not an unreviewed miss.

## Close matrix

| Command | Result |
|---|---|
| `npm run typecheck` | clean |
| ui-core/tui-v2/classic/noninteractive/app | 2,187 passed, 10 skipped |
| `npm run test:arch` | 5 passed |
| `npm run test:deterministic` | 599 files, 6,002 passed, 12 skipped |
| `npm run build` | dist emitted |
| `npm run quality:contracts` | unchanged |
| `npm run quality:changed` | 0 failures |
| `npm run quality:ratchet` | 548 held, 208 improvements, 0 regressions |
| `git diff --check` | clean |

## Deferred, with reason

`TranscriptView` (833 lines), `Pager` (824) and `ComposerEditor` (798) are single
React components. Splitting a component's body into child components changes the
component tree and hook order, which can alter focus, scroll and mouse behavior —
precisely the properties this phase protects and which cannot be verified on this
host for OpenTUI/Bun. They are left intact and recorded for Phase 7/8 review.
`SessionController` (853-line class) is deferred with the other single-class
modules.

Not runnable here: `npm run test:classic:pty` (interactive POSIX PTY), OpenTUI/Bun
rendering, Windows console behavior.
