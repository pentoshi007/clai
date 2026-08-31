# Phase 7 evidence — repository-wide structural closure

Branch `refactor/codebase`. Environment: Linux x64, Node 24, canonical locale/TZ.

## Measured state

`npm run quality:report` (deterministic, committed to
`refactor/evidence/phase-0/reports/metrics.json`):

| Metric | Phase 0 anchor | Now |
|---|---:|---:|
| Files measured | 630 | 883 |
| Functions measured | 9,039 | 9,559 |
| Files >= 500 physical lines | 81 | **47** |
| Functions cyclomatic >= 22 | 154 | 155 |
| Functions cognitive >= 22 | 322 | 319 |
| Functions Halstead difficulty >= 80 | 15 | 11 |
| Explicit `any` | 40 | 40 |
| `src` total physical lines | 162,417 | 152,900 |
| Architecture legacy oversized entries | 19 | 3 |

`quality:ratchet`: 532 legacy findings held, 247 improvements, **0 regressions**.

## What closed

Every hotspot named in Phases 1-6 is now a small facade over cohesive modules,
and 253 new modules were created, nearly all under 500 lines. The architecture
legacy baseline shrank from 19 entries to 3 by removal only; no entry was ever
added.

## Comment review (P7-06)

Performed with `scripts/refactor/strip-comments.mjs`, which is token-aware rather
than regex-based:

* candidate ranges come from `ts.createSourceFile` trivia, so `//` and block
  markers inside strings, template literals, regular expressions, JSX text and
  agent prompt text are never touched;
* after rewriting each file its **leaf token stream is compared with the
  original's**, both taken from the real parser; any difference aborts the entire
  run and writes nothing;
* comments that carry behavior are kept: shebangs, `@license`/copyright/SPDX,
  `@jsxImportSource` and other pragmas, triple-slash directives, `@ts-*`,
  eslint/prettier/biome/coverage/stryker directives, and security-invariant
  wording (plaintext/keychain/credential/redaction/SSRF);
* generated outputs (`src/prompts/embedded.ts`, `src/version.generated.ts`) are
  excluded.

Result: **5,889 comments removed from 523 of 883 files, 11,259 fewer lines, 161
behavior-bearing comments kept**, token streams identical in every file.

Two real defects were caught during this work and fixed before the final run:

1. A first pass deleted `/** @jsxImportSource @opentui/react */` because the keep
   pattern used `@jsx\b`, which does not match `@jsxImportSource`. Typecheck
   failed with 543 errors; the tree was restored from the pushed commit and the
   pattern corrected. Token equality alone cannot catch this — a pragma is a
   comment whose text changes compilation — which is why the gate set includes
   typecheck and build.
2. `test/keys-messaging.test.ts` asserts that `src/store/keys.ts` documents the
   restricted-permission plaintext fallback. The first pass removed that comment.
   Security-invariant wording is now in the keep list and the whole strip was
   re-run rather than patched per file.

## Not closed, with reasons

* **Explicit `any` remains 40.** Untouched deliberately: the instructions forbid
  replacing `any` with `unknown` plus a cast, so each site needs a real decoder or
  domain type. That is behavior-adjacent work and was not attempted blind.
* **47 files remain >= 500 lines.** The largest are single classes
  (`JobManager` 1,946, `InteractiveSessionManager` 1,455, `LoopGuard` 1,081,
  `SessionController` 936, `SessionRuntimeHost` 847, `McpRuntime` 767) and single
  functions or React components (`openAiCompatibleStream` 882, `runTurnRounds`
  877, `TranscriptView` 908, `Pager` 844, `ComposerEditor` 821). Splitting a class
  requires per-method dependency records because the members are private and
  widening them changes an exported class's public type; splitting a React
  component changes the component tree and hook order. Both are real work with
  real risk, and neither is a mechanical move.
* **`src/index.ts` (785) is deliberately intact**: `test/classic/no-opentui.test.ts`
  statically asserts that this file gates the interactive flow behind
  `resolveUiChoice`. An extraction was reverted rather than edit a guard for a
  Bun/OpenTUI/Windows contract that cannot be exercised on this host.
