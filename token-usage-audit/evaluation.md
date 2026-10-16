# Evaluation tooling checkpoint

Status: **P1 partial, not a release gate pass**. The collector and targeted negative controls are implemented; the complete C01–C10 / S01–S10 model matrix, all D03–D13 transitions and live route/cache baselines are not complete. Keep TE-005–TE-010 unchecked until their full acceptance criteria pass.

## Safe collection interface

The old implicit NVIDIA/keychain/raw-request evaluator has been replaced by explicit configuration and isolated subprocess trials. It uses each checkout's existing runner and provider adapter, not a new HTTP protocol or NVIDIA monkeypatch. Raw prompts, wire bodies, responses, headers, credentials and model answers are not serialized into evaluation reports. Synthetic workspaces and tool artifacts stay under the active session scratch directory; do not run this against real engagement content.

Create a nonsecret configuration under the active session scratch directory:

```json
{
  "version": 1,
  "routes": [{
    "provider": "nvidia",
    "model": "REPLACE_WITH_EXPLICITLY_SELECTED_MODEL",
    "toolCalling": "native",
    "thinking": { "enabled": false, "effort": "medium" }
  }],
  "fixtures": ["search-edit-natural", "independent-reads-natural", "background-wait-natural"],
  "repeats": 3,
  "maxCalls": 100,
  "scratchRoot": "/ABSOLUTE/ACTIVE/SESSION/SCRATCH"
}
```

The placeholder is not a recommended/validated model. Select the actual deployment routes/settings and a budget before a paid run. Both variants use the same fixed configuration and installed dependencies. `maxCalls` is the entire run's hard generation-admission budget, including failures/probes/retries; remaining budget is enforced before each child dispatch. A failed outcome stops collection rather than repeatedly sampling until it passes.

```sh
node --import tsx scripts/evaluate-token-overhead.ts --dry-run "$SESSION_SCRATCH/evaluation.json" /absolute/baseline-checkout
node --import tsx scripts/evaluate-token-overhead.ts --run "$SESSION_SCRATCH/evaluation.json" /absolute/baseline-checkout
```

`--dry-run` reads no credentials and makes no provider requests. This checkpoint accepts explicit NVIDIA/OpenAI/Anthropic/Gemini routes whose generation endpoints are recognized by the admission guard; this is implemented collector scope, not a live validation claim. Other gateway, subscription and local collector paths remain unimplemented and fail configuration validation rather than bypassing the call budget. The application's actual provider support is unchanged. `--run` requires the selected provider's existing environment credential; it never retrieves the owner's stored/keychain credentials. Use the normal secure environment setup, never put a key in JSON, command arguments or committed files. No live route is validated by the offline smoke test.

Each route/fixture/repetition gets separate before/after workspaces/config/history/session scratch. A/B and B/A order alternate by repetition; neither variant deletes the other's workspace. Configuration records intentionally contain no credentials. Trial reports retain every instrumented attempt's outcome, known/unknown usage, status and final-body fingerprints, along with tool errors/blocks, verified outcomes and resource timings. The CLI prints small receipts, not answer/request dumps. Changes to provider/model during a trial fail before sending the changed route.

## Verifiers and negative controls

- Preserve the six original tool-directed fixtures and add six natural-language counterparts plus a question-after-build continuation.
- Regression fixtures run independent inline assertions outside the model-visible tests. All original non-target fixture files and package scripts must remain unchanged. A hardcoded subtotal that passes the visible examples fails hidden fractional/zero-quantity cases.
- Read-only checks reject observed mutation, plan, terminal and non-inspection shell calls, including a later unsafe shell call following a safe read. File reads need successful tool evidence, not just guessed values in the answer.
- Background verification needs exactly one actual pollable launch, a subsequent wait on the same ID, an independently inspected terminal job state with exit 0, captured `READY_CHECK: 42` and the matching answer. A bare `42`, missing wait or different ID fails. An actual process/tool integration test proves this against the production job manager; `shell.wait` does not itself contain a background receipt, so the observer inspects the owned job state.
- Wire controls reject changed early instruction bytes, reordered tools and changed descriptions even on failed admissions. Unknown fingerprints are not successful continuity evidence.
- Paired gate helpers reject extra calls/rounds, unverified outcomes, worse measured latency, non-improved tokens, missing/exactness-unknown usage and missing/regressed warm-cache data. The partial collector intentionally returns `releaseEligible:false`; passing deterministic metrics does not establish live equivalence.

## Synthetic security lab

`startTokenSecurityLab` opens two owned ephemeral loopback HTTP servers and closes both on test completion. Tests independently verify S01 raw/comment/hidden/header evidence (with readable-only negative control), S02 every redirect/cookie and default-versus-explicit credential forwarding, S03 all 401/403/404/500 statuses with exact request counts, S05 gzip transfer decoding/capture truncation/body hashes and S06 a known synthetic authorization flaw versus a patched/404 control.

These are evidence-tool/fixture tests, **not model-level security reasoning passes**. S04 real TLS/private-scope transitions, S07 fuzz evidence, S08 code exploit/fix, S09 interruption and S10 adversarial mixed-task model fixtures still need their complete evaluation paths. Existing HTTP-policy, filesystem, provider and job tests remain required and are not weakened.

## Explicit unknowns and remaining work

- Successful core model rounds are counted separately from provider and auxiliary invocations. Total rounds including failed/recovered agent cycles remain `null` until independent attribution is implemented; do not equate invocations with rounds.
- Per-attempt input/output/cache-write/cache-read usage remains separate; absent usage/cache fields are `null`, not zero. Partial known totals are labelled separately and cannot pass the token gate. Pricing/cost, first-attempt-validity and repair classification remain unknown.
- Warm/cold request classification, eligible-prefix denominator, cache-hit/reuse metrics, long-history byte-prefix checks and per-provider permitted breakpoint transitions need the P1/P3 route baseline. A stable hash alone never means a cache hit.
- First-visible-token and verified-task time, CPU and peak RSS are captured. The reported observer overhead times fingerprinting only, not full runner assembly overhead. No performance improvement is claimed. Percentile/uncertainty/holdout analysis remains P6.
- Offline conformance coverage does not validate this collector on every live provider. Broader natural C05/C08/C09/C10 and complete security/negative-control trials remain required. No candidate/default activation exists here.

Official OpenAI documentation was fetched on 2026-10-16: [prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching). It confirms rendered tools/settings are part of exact-prefix matching and that sessions alone do not guarantee hits. No new provider API options or model-specific caching assumptions were introduced.
