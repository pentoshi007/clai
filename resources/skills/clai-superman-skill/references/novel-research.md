# Research beyond known templates

Use when observed behavior is unexplained, a mature system resists ordinary testing, a known issue needs variants, or the task explicitly calls for original vulnerability research. Novel research is a method for testing new hypotheses—not a promise to discover a zero-day. Age, popularity and a clean scan are not security proofs.

## Start with an invariant, not an exploit name

Describe the protected property in the target's own terms: identity stays bound to the action; a parser's validated object is the one later interpreted; a resource is consumed once; a lower-trust component cannot choose a privileged destination; a pointer remains valid until its last use; an upgrade cannot change who authorizes itself.

List assumptions each component makes about its neighbors. Prioritize assumptions enforced by convention, duplicated differently, invalidated asynchronously or invisible to normal tests. A useful hypothesis names a reachable input/state and predicts a security-relevant deviation. “There must be a zero-day here” has no predictive value.

## Discover where guarantees can diverge

| Research axis | Questions and useful experiments |
| --- | --- |
| Representation | Can two byte strings represent the same object, or one string mean different objects to validator and consumer? Compare normalization, encoding, duplicate fields, numeric precision and serializer behavior |
| Time | Is validation bound to execution time, resource version and identity? Reorder/replay/cancel/resume; change a controlled reference after approval; observe stale capabilities |
| Authority | Does a helper/worker/plugin act for the caller or itself? Follow delegated identity, tenant and consent across one edge at a time |
| Failure | What happens after timeout, partial commit, retry, parser error or unavailable verifier? Inject controlled failures in a safe replica and inspect state, not just error text |
| Composition | Do individually correct controls disagree when combined? Compare cache key versus authorization context, router versus origin, signature bytes versus interpreted object |
| Lifecycle | Does create/update/import/export/restore/migrate use the same enforcement? Test equivalent operations through distinct consumers |
| Concurrency | Is a request actually atomic? Identify sub-states, shared records, transaction scope, session locks, multi-process and worker interleavings |
| Boundary values | Empty/absent/null, zero/negative/extreme lengths, integer conversion, Unicode, recursion depth, container nesting and resource handles—only along a reachable path |
| History | What invariant did a previous patch restore? Inspect neighboring callers, old compatibility paths, partial fixes and backports for the same missing assumption |
| Deployment | Does the built/released/feature-flagged code differ from the reviewed source or test harness? Compare exact artifacts and runtime configuration |

Choose axes from system evidence. This table is a generator of questions, not a request to spray every encoding or sequence.

## Research a lead without anchoring

Write two competing explanations: the security hypothesis and the strongest benign explanation. Define a test whose outcomes differ. Before investing further verify the observed component, request, build, identity and instrumentation. Promote the lead when the result improves causal confidence or reveals a new boundary—not because it is exciting.

When unfamiliar, search by component/version + observed behavior + violated property. Prefer protocol/runtime documentation, vendor advisories and patches, original research, release notes and reproducible tests. Read the prerequisites and limitations, not just search snippets. Separate a technique that exists from a technique applicable to this configuration. Treat exploit repositories and sample binaries as untrusted; inspect and isolate before executing.

Do not overfit to a remembered CVE. The root cause might be a product-specific state machine or a novel composition. Conversely, an unfamiliar symptom can be a known bug with different packaging. Keep novelty separate from validity and impact.

## Choose the analysis engine from the question

- **Manual tracing:** best when authority, workflow or a small causal path matters more than input volume.
- **Static/dataflow analysis:** useful for scaling a known source/sink/root-cause family; validate guards and runtime dispatch.
- **Dynamic tracing/instrumentation:** useful when wrappers, generated code, IPC, binary dispatch or timing hide the real consumer.
- **Property/stateful testing:** useful when a compact invariant should hold over many sequences.
- **Differential testing:** useful when two implementations, versions, platforms or parsers should agree on a defined property.
- **Coverage-guided fuzzing:** useful when a reachable parser/state machine can be safely and repeatedly exercised.
- **Constraint/symbolic reasoning:** useful for a bounded difficult path with explicit constraints; model errors and path explosion can dominate.

Combine methods when each resolves a specific uncertainty. Running several engines without an oracle or a target model is expensive enumeration, not research.

## Construct an oracle that detects the real failure

An oracle answers whether the invariant failed. Examples: cross-tenant canary visibility; invalid state after a controlled transaction; sanitizer-detected out-of-bounds access; different acceptance of an authenticated object; an unauthorized tool action independently recorded.

Response status, timing, coverage and crashes are proxies. Explain what each proxy can and cannot distinguish. For timing use interleaved controls and enough bounded samples to assess noise; seek a direct effect where possible. For differential behavior identify which specification/invariant says the difference is wrong. Two implementations can disagree without either being exploitable.

Metamorphic relationships can supply oracles when outputs are hard to predict: a round-trip preserves the defined canonical object; irrelevant field order doesn't change authority; revoking a role doesn't expand access; a replay doesn't duplicate a one-time operation. Verify the relationship is actually promised by the target—don't report valid non-canonical behavior as a flaw.

## Fuzzing that reaches useful code

Use a safe harness/replica, not unconstrained production traffic. Record exact source/artifact revision, toolchain, sanitizer/instrumentation, harness, corpus, options, seed and limits.

A useful harness:

- Invokes the real target path with valid enough outer structure to reach interesting logic.
- Accepts empty, malformed and large inputs without failures caused only by the harness.
- Resets per-case state or deliberately models state sequences, including session/identity context.
- Avoids uncontrolled network, filesystem and external process side effects; joins/cleans resources per case.
- Is deterministic where feasible and fast enough for feedback to matter.
- Has a known valid seed and a deliberately failing oracle/control proving the detector works.

Choose mutation structure deliberately: dictionaries for magic/constants; grammar/schema-aware generation for nested formats; valid checksums/signatures for layers preceding the target; stateful action sequences for business protocols. If checks block coverage, use a dedicated analysis build to reach deeper logic but keep that altered precondition out of exploitability claims.

Inspect real code/edge/state coverage, corpus diversity and time spent in the intended target. Executions per second and fuzzer uptime alone are not progress. If plateaued, inspect barriers and update seeds/harness/oracle before merely extending runtime. State which code/behaviors were never reached.

## Minimize, explain, reproduce

For a failure preserve the original input/state, then minimize bytes, fields, operations and timing dependencies without losing the security effect. Reproduce in a fresh process/session and the relevant unmodified build. Separate harness/monitor defects, expected rejections and environmental failures from product bugs.

Produce a causal explanation: attacker-controlled input -> missing/wrong check or lifetime/state assumption -> forbidden operation -> demonstrated consequence. For memory corruption characterize the primitive and mitigations separately from speculative code execution. For logic bugs inspect persistent state independently from a success response.

## Variant search from a root cause

Extract the missing invariant rather than a vulnerable function's spelling. Validate a search against the known instance. Expand along distinct meaningful relationships: shared validator/sink, sibling interfaces, callers/overrides, alternate types/encodings, async paths, versions and platforms. Broaden one causal axis at a time so noise can be explained.

For every candidate check attacker control, reachability, dominating guards, context and consequence. Record why a candidate is refuted or blocked. Don't count nearby code as a variant or duplicate multiple manifestations into inflated finding counts. If one root-cause fix covers them all, group them and name materially distinct impacts.

Search historical fixes for incomplete coverage and semantic substitutes: a removed exact pattern may still exist through another helper or representation. Conversely, don't endlessly re-run a broad query that only generates known benign matches. Preserve the envelope and reopen only on a meaningful change.

## Build only compatible chains

Represent an edge with input capability, exact preconditions, action, resulting capability, evidence and side effects. To compose edges, verify that the first result actually satisfies the next prerequisites under the same identity/network/state/version context. An SSRF that only performs GET cannot automatically invoke a POST-only control plane; a credential restricted to one resource doesn't imply account-wide compromise.

Use the minimum proof that resolves the objective. Discuss plausible untested consequences separately. Do not perform destructive or sensitive-data impact just to replace a safely demonstrated capability with a more dramatic screenshot.

## Exit, park or continue

Continue when a reachable unexplained anomaly, untested important invariant or promising new evidence offers a realistic gain. Pivot when repetitions no longer distinguish explanations, prerequisite access is absent, or another boundary has higher supported value. A well-recorded refutation is progress; sunk cost is not a reason to grind.

Before a long pause preserve exact artifacts, minimized case, competing explanations, failed experiments with envelopes, research sources and one next discriminating test. State budget/runtime limits honestly. Never call a bug “zero-day” merely because a search found no match; describe it as apparently undocumented pending vendor/advisory/history checks and coordinated disclosure through the agreed process.
