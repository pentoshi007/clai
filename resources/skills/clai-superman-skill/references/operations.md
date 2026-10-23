# Engagement control and efficient persistence

Use for substantial assessments and long investigations. Adapt the amount of state to the task. Do not create a bureaucracy before a single useful test.

## Objective and system model

Translate the objective into an observable outcome: demonstrate cross-tenant read/write, evaluate a control, validate a reported issue, assess material exposed boundaries, test a specified adversary path, or resolve an incident hypothesis. A red-team objective reached does not imply a full vulnerability assessment; an audit with no findings does not imply no attack path.

Identify the operating constraints that change the next action: production versus clone, allowable state changes, tested identities, third parties, address ranges, egress, test window, physical access, rate/concurrency limits, account lockout, evidence retention and cleanup. Resolve scope-changing ambiguity before acting on the uncertain asset; continue independent known-in-scope work. Discovery of an address, credential, subsidiary or vendor does not itself expand authorization.

Draw the smallest useful graph:

`actor/capability -> entry -> transformation/decision -> privileged action -> asset`

Add transport/identity/state labels to edges. Include both control and data planes: UI to API; API to queue; queue to worker; client to local service; federated identity to tenant; pod to node; Wi-Fi client to wired network. Ask which component believes which other component already checked authorization or canonicalized input.

## A lightweight working ledger

Reuse an engagement's existing artifacts. For multi-stage work, keep these records in an appropriate engagement directory or durable task state, not global project instructions. Store sensitive captures separately from redacted summaries. A compact Markdown table or JSONL file is enough; do not build a database unless needed.

| Record | Minimum useful content |
| --- | --- |
| Objective | desired effect/control, proof condition, exclusions, budget |
| Surface | stable ID, asset/interface, version/vantage, principal/role, operation/object/state, boundary, source of discovery |
| Hypothesis | linked surface, invariant, mechanism, preconditions, confirming/refuting signal, next experiment, priority rationale |
| Experiment | input/command, baseline/control, timestamp/timezone, tool version, context, artifact pointers, observation, interpretation |
| Finding | attacker path, consequence, confidence, reproduction, root cause, sibling/chain links, cleanup |
| Gap | untested boundary, reason, impact on confidence, access or experiment needed to resolve |

Use dispositions precisely:

- **Queued/active:** a candidate with a specific next experiment, not a vulnerability.
- **Observed:** behavior recorded; mechanism or impact not yet established.
- **Confirmed:** security consequence demonstrated under the recorded preconditions.
- **Refuted for this case:** a stated mechanism contradicted by a discriminating test; not the whole vulnerability class ruled out.
- **Parked:** currently low-yield; preserve evidence and what would make it worth reopening.
- **Blocked:** missing access, hardware, approval, availability or another prerequisite.
- **Not applicable:** architecture or product behavior gives a defensible reason, with evidence.
- **Untested:** discovered but no adequate assessment yet. Never relabel this “passed.”

A negative result has an envelope: build, vantage, principal, operation, representation, state and experiment. Reopen it when a material part of the envelope changes. Deduplicate by that envelope and hypothesis, not just URL or function name.

## Cover the boundary, not just the inventory

For each material family, consider actor/role/tenant, object ownership, operation, lifecycle state, entrypoint/protocol, representation and deployment. Select equivalence classes based on shared enforcement, not superficial naming. If REST and GraphQL share a service but authorize in separate resolvers, they are not one tested surface. If one shared middleware is verified, representative checks can support broader coverage with an explicit sampling rationale.

Discovery channels complement each other:

- Black box: observed traffic, linked resources, DNS/TLS, service negotiation, documentation, errors, normal workflows.
- Authenticated: each role's routes, exports/imports, lifecycle transitions, admin/support, APIs behind the UI.
- Artifacts/source: manifests, routes, generated clients, schemas, workers, configs, build metadata, changelogs.
- Runtime: actual process/IPC/network/file behavior, traces, logs and policy evaluation.

Reconcile differences: documented but unexposed, deployed but undocumented, UI-hidden but server-callable, main path patched but worker still vulnerable. Breadth comes from finding meaningful boundaries, not indiscriminate enumeration.

## Choose the next experiment

Use a qualitative comparison, not invented arithmetic:

- **Impact:** Which protected asset or invariant would fail? How valuable is the next edge?
- **Evidence:** Does observed behavior support the precondition, or is it merely imaginable?
- **Reachability:** Can the actual attacker reach it under the engagement's identity and network conditions?
- **Information gain:** Will the result separate competing explanations or unlock many sibling tests?
- **Cost and risk:** How much setup, runtime, noise, state change or collateral risk is involved?
- **Coverage debt:** Which important boundary has been neglected while a deep lead consumed attention?

Prefer tests that distinguish hypotheses. Example: if an export may ignore tenant context, another injection scanner adds little. Two controlled tenants and an export created before membership revocation can distinguish per-request checks from a worker's stale authorization.

Do the fast prerequisite test before an expensive exploit. Preserve promising anomalies even when temporarily blocked; do not let them trigger speculative full chains. Do not invent fixed percentages, tool-derived certainty, or priorities solely from a CVSS banner.

## Escalation ladder for a promising anomaly

1. Verify target, routing, session, request and artifact are the intended ones.
2. Reproduce against baseline/control and remove accidental variables.
3. Localize the responsible component or state transition using one changed dimension.
4. Research implementation, patch history, protocol guarantees or source code.
5. Build the smallest harness/PoC that observes the security invariant directly.
6. Challenge with a benign explanation, boundary case and alternate observation channel.
7. Establish bounded impact, then examine siblings or a supported chain.

Enter wherever evidence permits. This is not a requirement to execute seven steps for every lead.

## Stalls, failures and pivots

| Observation | Decision-changing next move |
| --- | --- |
| Identical status/body across nonexistent and interesting paths | Fingerprint the catch-all before more discovery; retain meaningful size/status/redirect differences |
| Every request is challenged | Distinguish edge/WAF response from application behavior; acquire legitimate session or approved alternate vantage |
| PoC fails before reaching vulnerable logic | Fix prerequisite, version, feature flag, encoding or harness; record path reachability separately |
| Same payload produces unstable timing | Interleave baseline/control, inspect queue/caching/network effects, use a direct state or callback oracle |
| Static taint path stops at a wrapper | Trace runtime dispatch, validator order, transformations and downstream interpretation |
| Fuzzer is busy but no meaningful coverage grows | Check harness reachability, seed validity, dictionaries, state reset and gate conditions |
| Repeated changed inputs yield no new distinction | Park this mechanism with its envelope; advance a different unresolved boundary |
| One finding explains many alerts | Group the root cause, verify representative variants; don't inflate counts |
| New credential or role appears | Revalidate scope and capability, add new identity-boundary tests; don't automatically spray or dump secrets |

A retry needs a new reason and a distinct predicted result. A tool installation problem is not a target vulnerability. A blocked experiment is not a failed security control. Don't route around permission denials, and don't treat removing a control in a clone as proof that production is exploitable.

## Concurrency and long-running work

Use only available, authorized orchestration. Delegate genuinely independent investigations with explicit surfaces and expected evidence; keep final causal verification with the owner. Do not have multiple workers duplicate scans, mutate the same state, or contaminate each other's timing/cache experiments. Schedule race tests deliberately rather than accidentally.

Use clai's actual job lifecycle: long finite jobs belong to the supported durable/Responder mechanism; interactive logins need an owned terminal; servers/watchers are not finite analysis jobs. Track artifacts and read terminal results before drawing conclusions. Parallelize research or another surface while a job runs; don't poll repeatedly or relaunch a live equivalent.

A checkpoint should preserve scope, versions, verified facts, working identities by secure reference, exact artifact paths, open/parked/blocked hypotheses, running job IDs, changed state and the next discriminating experiment. Resume from evidence rather than redoing the engagement. Never persist client credentials or sensitive findings in a reusable skill or public memory.

## Closure decision

Close the requested boundary when its proof conditions hold and material feasible work would no longer change the result. For a comprehensive assessment, this requires reconciling the surface ledger and important sibling/alternate paths—not just reaching one goal. If a budget or prerequisite prevents this, stop honestly at that limit and describe the frontier. A clean result can be valid; inventing a vulnerability to satisfy a motivational instruction cannot.
