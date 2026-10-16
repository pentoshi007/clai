# Audit evidence and reproduction

Captured 2026-10-16 against `ada38924a499a568e69984b35f99b75c375ecb98` (clai 4.15.2). Documentation and audit measurement utilities are the only additions. No optimized runtime was created.

## Committed artifacts

| File | Meaning |
| --- | --- |
| [baseline-measurement.json](baseline-measurement.json) | Unmodified output of the existing measurement script, comparing the checkout with itself. All savings fields are zero; this is not an optimization result. |
| [route-inventory.json](route-inventory.json) | Eight native route fixtures, prompt/tool lengths and exact SHA-256 digests; all 47 definitions' canonical digest. |
| [tool-inventory.csv](tool-inventory.csv) | Per-definition wire length, character-estimated tokens, structural length and description-field contribution. |
| [measure-inventory.mjs](measure-inventory.mjs) | Read-only local inventory utility; uses existing source renderers/adapters and makes no model or HTTP calls. |
| [checks.json](checks.json) | Checks actually executed and their scope/limits. |

No request text from real engagements, credentials, full system-prompt dump or captured security response bodies are stored here. Measurements contain only sizes/hashes and synthetic fixtures. Keep future evidence similarly bounded.

## Reproduce baseline

From the repository root, using its installed npm dependencies and current session scratch directory:

```sh
node --import tsx scripts/measure-token-overhead.ts "$PWD"
node --import tsx token-usage-audit/evidence/measure-inventory.mjs "$PWD"
```

The first script normally compares two checkouts. Passing the same checkout deliberately records a no-change baseline. For future A/B tests pass a separate immutable baseline checkout; do not overwrite or reset the user's working tree.

The inventory utility's `routes` correspond to `route-inventory.json`. Its `tools` correspond to the CSV, sorted by descending wire size. The route fixture uses the OpenAI adapter for schema sizing even when its offline provider label is NVIDIA; it is not a live provider token count.

The measured renderer used full native slim behavior, stable environment placeholders, no project/skill/plan/scope content and a synthetic Linux environment. Compact/full is forced by the fixture, not selected by runner heuristics. Installed configuration/capability data can influence rendering: compare the recorded hashes, and investigate drift instead of assuming every environment is identical. P0 adds fully isolated real-runner fixtures.

Estimation is `ceil(character count / 3.3)`. Per-tool estimates rounded separately do not necessarily sum to the route estimate. Description-field sizes include JSON keys/quoting removed by the utility's recursive `description` filter; they are not equivalent to safely removable text. Enclosing arrays and commas explain total-versus-per-tool serialization differences.

## Checks run during this audit

The following focused invocation passed **13 files / 108 tests**:

```sh
./node_modules/.bin/vitest run \
  test/token-overhead.test.ts \
  test/prompt-assembly-contract.test.ts \
  test/prompt-cache-prefix.test.ts \
  test/native-prompt-cache-cross-turn.test.ts \
  test/openai-prompt-cache-cross-turn.test.ts \
  test/agent/stable-catalog-cache-continuity.test.ts \
  test/llm/context-prefix-wire.test.ts \
  test/agent/compaction-cache-fidelity.test.ts \
  test/llm/adapters/anthropic-cache-breakpoints.test.ts \
  test/anthropic-cache-lookback.test.ts \
  test/llm/multi-provider-cache-continuity.test.ts \
  test/fs-read-multiple.test.ts \
  test/tools/definitions.test.ts \
  --reporter=dot
```

Also passed:

```sh
npm run typecheck
npm run embed-prompts:check
```

The second check reported that both embedded prompts match source. No build was run because this delivery does not change runtime/build inputs. Full deterministic, host/native and live model evaluations were not run and are not implied by these results.

A direct local probe confirmed `web.fetch` schema/validator drift:

```sh
node --import tsx -e 'import {getToolDefinition} from "./src/tools/definitions.ts"; import {validateArgs} from "./src/tools/web/validate-args.ts"; console.log(JSON.stringify({schema:getToolDefinition("web.fetch").parameters.properties.maxBytes, validation:validateArgs({url:"https://example.com",maxBytes:1800000})}));'
```

Observed: schema has integer type but no min/max; validation returns `ok:false`, kind `validation`, and allowed range `[1024, 1048576]`. The probe does not perform a network request. A research fetch during the audit also hit that error and succeeded after using the allowed maximum. No runtime fix is included.

## Provenance and limitations

Raw audit command outputs were kept in the session scratch directory `/tmp/clai/b84284-16-10-2026-08-32-38/`, not committed. That temporary directory is not a durable dependency: reproduction commands and bounded results are here.

Provider documentation used: [official OpenAI prompt caching guide](https://developers.openai.com/api/docs/guides/prompt-caching), fetched successfully on 2026-10-16. Only its exact-prefix/tool-content principles are used; no pricing, model ranking, guaranteed hit rate or new provider feature support is inferred.

No subagent findings contributed to this audit. Delegation was stopped at the user's request before a report was produced; subsequent investigation was direct.

## Implementation evidence (separate from the original audit)

- [P0 evidence](phase-0.md): checkout reconciliation, 64 isolated full-assembly fixtures and focused check outcomes.
- [assembly-baseline.json](assembly-baseline.json): per-component canonical/serialized character estimates and hashes; synthetic inputs only, no provider-exact usage.
- [legacy-contracts.json](legacy-contracts.json): immutable source/section/paragraph and ordered tool contracts, with responsibility/test/scenario ownership explained in [contracts.md](../contracts.md).

Reproduce full assembly with `node --import tsx scripts/measure-token-overhead.ts --assembled "$SESSION_SCRATCH/assembly.json"`, using the current session's absolute scratch path. The command runs the installed offline test harness and prints counts/digests only after every fixture assertion passes. Application runtime, prompt, schema and cache-policy bytes remain unchanged by P0.

- [P1 partial checkpoint](phase-1.md), [bounded check record](p1-checkpoint.json) and [collector documentation](../evaluation.md): offline evaluator/verifier improvements and exact remaining coverage. This checkpoint does not complete P1 or activate a profile.
