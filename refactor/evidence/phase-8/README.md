# Phase 8 evidence — terminal quality and platform closure

Branch `refactor/codebase`. Environment: Linux x64, Node 24.19, canonical
`LANG/LC_*=C`, `TZ=UTC`.

## Locally verified

| Command | Result |
|---|---|
| `npm run typecheck` | clean |
| `npm run embed-prompts:check` | 2 prompts match their sources |
| `npm run test:arch -- --reporter=dot` | 5 passed |
| `npm run test:deterministic -- --reporter=dot` | **599 files, 6,002 passed, 12 skipped** |
| `npm run build` | dist emitted |
| `npm run quality:contracts` | public contracts unchanged (405 exports over 20 hotspot modules) |
| `npm run quality:changed` | 0 failures |
| `npm run quality:ratchet` | 532 held, 247 improvements, 0 regressions |
| `npm run quality:report` | measured=true, deterministic |
| `git diff --check` | clean |

The suite grew from 5,758 tests at the Phase 0 close to 6,002, and no test was
weakened: the only test edits in the whole program are one added timeout on a
boot-heavy test and four added assertions for the analyzer precision fixes.

## Terminal gates NOT met

These remain open and are reported as measured facts, not as passes:

| Gate | Target | Actual |
|---|---|---|
| Coverage | 100% statements/branches/functions/lines | **measured: 70.58% statements, 62.68% branches, 73.43% functions, 73.04% lines** |
| CRAP | < 25 per measured function | not computed from this run |
| Mutation | 0 survived, 0 no-coverage | not run |
| Dead code / duplication | 0 unresolved findings | not re-run |
| Files < 500 lines | all ordinary production files | 47 files remain |
| Explicit `any` | 0 | 40 |
| Cyclomatic / cognitive < 22 | all functions | 155 / 319 functions remain |

Coverage was measured on this host with the pinned `@vitest/coverage-v8@4.1.10`:

```sh
LC_ALL=C LANG=C TZ=UTC npx vitest run --coverage --coverage.reporter=text-summary
```

599 files, 6,002 passed, 12 skipped, 306s. Statements 39,880/56,500 (70.58%),
branches 28,221/45,019 (62.68%), functions 7,007/9,542 (73.43%), lines
36,380/49,805 (73.04%). The 100% gate is therefore **not met**, and the gap is now
a number rather than an unknown.

Making the run possible required one test-infrastructure change: the runner
contract hard gate builds a whole TypeScript program, which takes about 9.9s under
V8 instrumentation and exceeded the 5s default timeout. It now declares a 120s
timeout; the asserted signatures are unchanged.

Mutation (`npm run quality:mutation`) was not run: whole-repository mutation over
9,559 functions is a scheduled job, and the phase plan itself scopes it
(`--scope llm`, `--scope tools-core`). Dead-code and duplication analyzers were
not re-run either. Both remain `unmeasured`, which the program defines as *not*
passing.

## Out of local scope (never claimed as passed)

Node 22, Bun/OpenTUI rendering, macOS, Windows Terminal/PowerShell/ConPTY, OS
keychain success paths, interactive POSIX PTY (`npm run test:classic:pty`), and
trusted-host release verification cannot be exercised on this Linux/Node 24 host.
