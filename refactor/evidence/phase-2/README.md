# Phase 2 evidence — LLM transport and routing

Branch `refactor/codebase`. Environment: Linux x64, Node 24, canonical `LANG/LC_*=C`
and `TZ=UTC` through `scripts/run-tests.mjs`.

## Entry

Characterization suites named in the plan ran green before any movement:
`test/conformance test/admission test/llm test/profiles` plus the stream, vision,
system-message, sampling, reasoning-degradation, nvidia-payload, custom-provider,
modal-rotation, provider-pairing and fallback-gate suites — 89 files, 1,203 passed,
2 skipped, exit 0.

## Result

| Module | Entry | Now |
|---|---:|---:|
| `src/llm/http.ts` | 2,646 | 91 |
| `src/llm/router.ts` | 1,868 | 388 |
| `src/llm/capabilities.ts` | 991 | 409 |
| `src/llm/provider.ts` | 909 | 182 |
| `src/llm/custom-provider-profile.ts` | 772 | 177 |
| `src/llm/provider-profile.ts` | 765 | 412 |
| `src/llm/reasoning-artifacts.ts` | 620 | 424 |
| `src/llm/adapters/anthropic-tools.ts` | 600 | 321 |
| `src/llm/token-usage.ts` | 582 | 260 |
| `src/llm/responses-stream-events.ts` | 566 | 423 |
| `src/llm/provider-model-layers.ts` | 549 | 161 |
| `src/llm/tool-protocol.ts` | 529 | 443 |

New module families: `wire/` (response errors, stream framing, chat body, reasoning
payload/artifacts, capability errors, model catalog, openai complete/stream),
`routing/` (provider selection, error classification, failure report, attempt
request/complete/stream, key rotation), `profile/`, `capability/`, `artifacts/`,
`usage/`, `model-layers/`, `responses/`, `tool-wire/`.

`src/llm/http.ts` and `src/llm/router.ts` were removed from
`test/architecture/legacy-baseline.json` in the commits that took them under
1,000 lines.

## Wire-contract evidence

`quality:contracts` compared 405 exports across the 20 hotspot modules:
**0 structural changes, 0 removed, 0 added**; 10 declarations were reported as
relocated (identical structure at a new declaration path) and the reviewed
inventory was refreshed in the same commits.

## Close matrix

| Command | Result |
|---|---|
| `npm run typecheck` | clean |
| `npm run embed-prompts:check` | 2 prompts match |
| `npm run test:arch` | 5 passed |
| `npm run test:deterministic` | 599 files, 6,002 passed, 12 skipped |
| `npm run build` | dist emitted |
| `npm run quality:contracts` | public contracts unchanged |
| `npm run quality:changed` | 0 failures |
| `npm run quality:ratchet` | 556 held, 65 improvements, 0 regressions |
| `git diff --check` | clean |

## Analyzer precision fixes (separate commits, each with tests)

1. `fix(quality): classify re-exported contracts by resolved kind` — the inventory
   reported the program's own mandated compatibility re-export as
   `function -> alias`. Kinds are now read from the resolved declaration. The
   committed baseline needed no loosening; 20 pre-existing alias entries became
   their concrete kinds.
2. `fix(quality): separate relocated declarations from changed contracts` — a moved
   type declaration changed only the module qualifier inside its type text. Such
   cases are now reported as `relocated:` and excluded from drift, while a
   structural change at the same path still fails. Proven by tests in both
   directions.
3. `fix(quality): count changed-code type findings instead of line attribution` —
   the changed-code gate flagged surviving `unknown` sites whose lines shifted
   during a pure deletion. Findings are now compared as per-file
   (category, detail) multisets; an injected new `unknown` narrowing was verified
   to still fail the gate.

## Known remaining debt

`src/llm/wire/openai-stream.ts` (967 lines, one relocated 889-line function) and
`src/llm/provider-info-text.ts` (586 lines, a provider help-text data table) carry
relocated legacy size from `http.ts` and `provider.ts`. Both are registered in
`RELOCATED_LEGACY_FILES` with baseline entries and are owned by Phase 7 closure.
