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
| Coverage | 100% statements/branches/functions/lines | **not measured this session** |
| CRAP | < 25 per measured function | not measured (needs coverage) |
| Mutation | 0 survived, 0 no-coverage | not run |
| Dead code / duplication | 0 unresolved findings | not re-run |
| Files < 500 lines | all ordinary production files | 47 files remain |
| Explicit `any` | 0 | 40 |
| Cyclomatic / cognitive < 22 | all functions | 155 / 319 functions remain |

Coverage and mutation runs are long-running jobs; they were not executed in this
session, so their status is `unmeasured`, which the program defines as *not*
passing. The structural prerequisites for them are in place: the analyzers are
pinned and wired (`quality:report`, `quality:mutation`), and the ratchet holds
every legacy finding.

## Out of local scope (never claimed as passed)

Node 22, Bun/OpenTUI rendering, macOS, Windows Terminal/PowerShell/ConPTY, OS
keychain success paths, interactive POSIX PTY (`npm run test:classic:pty`), and
trusted-host release verification cannot be exercised on this Linux/Node 24 host.
