# Evaluation collection and gates

Status: P1 proof harness and limited-route baseline are verified. No optimized profile is enabled. See [phase-1.md](evidence/phase-1.md) for passed and failed trials and explicit release gaps; a baseline model pass is not candidate-quality or cache equivalence.

## Safe collection interface

`scripts/evaluate-token-overhead.ts` reuses each selected checkout's runner and provider adapter. Nonsecret JSON selects built-in provider/model, native/text protocol, thinking settings, fixtures, repetitions, scratch root and a whole-run generation-admission budget. No model/budget downgrade or evidence-cap reduction is part of a comparison.

```json
{
  "version": 1,
  "routes": [{
    "provider": "SELECT_BUILTIN_PROVIDER",
    "model": "SELECT_EXACT_DEPLOYED_MODEL",
    "toolCalling": "native",
    "thinking": { "enabled": true, "effort": "medium" },
    "auth": "stored"
  }],
  "fixtures": ["search-edit-natural", "independent-reads-natural", "security-s01-natural"],
  "repeats": 3,
  "maxCalls": 100,
  "scratchRoot": "/ABSOLUTE/ACTIVE/SESSION/SCRATCH"
}
```

Place configuration and all synthetic artifacts under the active session scratch directory, never in real engagement workspaces. The placeholders above are not recommendations or live-validated routes. Existing application dependencies/settings are preserved.

```sh
node --import tsx scripts/evaluate-token-overhead.ts --dry-run "$SESSION_SCRATCH/evaluation.json" /absolute/baseline-checkout
node --import tsx scripts/evaluate-token-overhead.ts --baseline "$SESSION_SCRATCH/evaluation.json" /absolute/baseline-checkout
node --import tsx scripts/evaluate-token-overhead.ts --run "$SESSION_SCRATCH/evaluation.json" /absolute/baseline-checkout
```

- `--dry-run`: validates the paired plan, reads no credentials and sends zero requests.
- `--baseline`: one baseline lane, not an A/B experiment; useful for validating the corpus without doubling paid work.
- `--run`: isolated counterbalanced A/B and B/A pairs. A failed fixture stops that run rather than resampling until it passes.
- `maxCalls`: hard run-wide generation-admission bound, including failed requests, retries and capability probes. Each trial receives only its remaining allowance. Admission interception covers custom generation URL spellings as well as standard endpoint patterns. Unrecorded probe usage is explicitly incomplete, never free/zero.

`auth` is `environment` by default; it requires the provider's existing environment variable and does not consult stored keys. Explicit `stored` reads the selected enabled slot in memory in the coordinator, never prints it or writes it to configuration/evidence. Refresh metadata is transferred only through the private child environment. `none` is restricted to keyless/local routes. Local Ollama requires an explicit `endpoint`; optional remote endpoints must be HTTP(S) without URL credentials/query/fragment. Selection of a collector is not proof that the live route works.

**Isolation starts before module imports.** Child HOME/USERPROFILE, XDG, config/history/log/artifact/job/scratch roots and temp directories are private; keychain is disabled. Only selected credentials and necessary platform variables are inherited. All other API keys, endpoint overrides, proxy hooks and NODE_OPTIONS are excluded. This is necessary because the existing fallback secret store uses `homedir()/.clai/keys.json`, not `CLAI_CONFIG_DIR`. A real fresh-process test proves an unrelated provider cannot see the owner's stored credentials.

The coordinator pins all tracked and untracked source/harness files plus package, lockfile and TypeScript configuration digests before collection and checks them around every child. Each child also compares its checkout snapshot before imports and after cleanup. Changed snapshots stop collection, and missing/changed snapshots make paired reports ineligible. Independent documentation/test-review work is excluded; do not modify executable source during collection or treat pre-guard exploratory runs as frozen comparisons.

Reports store counts, digests, usage and settings, not raw prompts/wires/tool arguments/model answers or response headers/bodies. Failed provider responses retain only a bounded redacted JSON error message and a digest of the bounded inspected error body. Synthetic fixture artifacts remain in private scratch. A mode-0600 `fixture-diagnostics.json` retains redacted synthetic answers/tool receipts for failure localization and re-evaluation without resampling; it is never committed as public report evidence. Selected credentials and the synthetic PTY secret are redacted. Do not run the corpus against private source or real engagement data.

## Coverage and independent assertions

The six original tool-directed fixtures remain. Natural counterparts plus focused fixtures cover C01–C10: hidden numeric/boundary assertions; immutable non-target files/tests/package scripts; CRLF/Unicode/stale evidence; read-only questions after builds; persistence/reload/invalid/IO paths; batched partial reads; finite/persistent/Responder jobs; PTY masked input/cursors/cleanup; intermediate versus complete roadmap boundaries; failed attempts/recovery.

Process verifiers need real receipts and independent owned job state. A bare answer, fake wait, different ID, duplicate launch, missing ready probe/cleanup or unacknowledged Responder receipt fails. PTY assertions reject secrets in ordinary arguments/output, input resend, missing prompt evidence and cursor rewinds. Partial-read checks retain both successes and the missing-file failure rather than retrying every entry. Hidden tests execute outside model-visible fixture tests; edited tests/package scripts cannot manufacture a pass.

S01–S10 fixture definitions use owned ephemeral loopback HTTP/TLS and synthetic source/scanner/job data:

| IDs | Independent evidence |
| --- | --- |
| S01–S03 | Raw comments/attributes/headers, repeated redirect cookies, actual per-hop credential stripping/explicit forwarding, real statuses/request counts. |
| S04 | Real self-signed certificate rejects normally; explicit per-request bypass records disabled verification. No global TLS weakening. |
| S05–S06 | Correct decoded capture digest, early/late evidence, capture/display distinction; flawed owner endpoint versus patched denial/404 controls. |
| S07–S08 | Scanner path/status/size/calibration preserved, no duplicate scan; actual failed exploit regression before safe fix and passing hidden negative cases. |
| S09–S10 | One owned scan across pause/continue; retrieved instruction injection cannot broaden scope or authorize source tampering. |

These are model-invocable fixtures with independently tested verifiers. Definitions and deterministic controls alone do not establish that a model passes them. All model trials must be reported separately. Lab listeners and owned jobs/PTY sessions are closed on completion or error.

## Accounting and acceptance

Opt-in, non-model-visible diagnostics report logical round attempts (including failure/recovery), protocol repairs, turn-setup and request-assembly time. Provider invocations, transport admissions, successful callbacks and auxiliary invocations remain separate. The default application path does not persist/upload diagnostics or read instrumentation files.

Reports retain every settled usage record, exactness/provenance and unknowns, full-task known subtotals, first primary input, output/reasoning/cache-write/read tokens, first-visible-token and verified-task time, CPU/RSS, fingerprinting overhead, setup/assembly samples, tool errors/blocks/retries and corrective rounds. First-attempt execution reliability is a conservative trial-wide score: any execution/block/protocol failure fails it, including expected negative-input work; those cases cannot silently excuse a candidate regression. It is not a per-schema parser proof. Cost stays unknown without versioned pricing. Baselines lacking diagnostics retain unknown logical counts.

Cold/warm lineage is recorded separately from provider eligibility. Cache summaries include misses, known-usage eligible denominators, unknown temperature/eligibility/usage and cold writes. Eligible-prefix reuse is unknown unless all eligible unchanged-prefix denominators are independently established. Neither a stable hash nor reported cached input alone proves comparable cache eligibility.

Static and historical prefix controls reject early prompt changes, ordered-description/schema changes, removed or rewritten previously submitted history and unknown fingerprints. Provider-specific supported breakpoint/compaction/replay transitions are additionally checked by existing adapter/conformance tests; the generic strict historical gate is conservative and cannot excuse unsupported transitions. Missing metrics/coverage always prevent release eligibility.

P6 owns staged pilot/expanded/holdout distributions and uncertainty, not a single A/A smoke. No global model/provider-quality, latency, cost or cache improvement is claimed by the collector. Official [OpenAI prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching) was fetched on 2026-10-16; exact-prefix behavior is not permission to infer cache hits or undocumented subscription eligibility.
