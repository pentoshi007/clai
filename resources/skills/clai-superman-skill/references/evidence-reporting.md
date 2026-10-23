# Evidence, false-positive challenge and closure

Use when a lead becomes a finding, an exploit chain is claimed, or the engagement is approaching closure. Scale the artifact to the task. A narrow answer may belong in chat; create a report file when requested or when the engagement deliverable calls for it, not as an automatic side effect of a question.

## Evidence ladder

Keep these levels separate:

1. **Signal:** banner, scanner alert, reflection, crash, unusual response, graph edge or suspicious source pattern.
2. **Mechanism:** the input/state reaches the responsible component and the suspected validation/authorization/state assumption fails.
3. **Security consequence:** an attacker under the stated capabilities crosses a protected boundary or violates a security property.
4. **Bounded impact:** the effect is independently observed and contextualized; potential broader harm is explicitly inferred or untested.
5. **Reproducibility:** another operator can reproduce the claim under documented conditions without guessing missing prerequisites.

A source-level finding can establish a real defect while remote deployment remains unverified. An interrupted exploit can establish a partial chain. Report those accurately instead of promoting them to demonstrated compromise or discarding useful evidence entirely.

## Capture only what proves the claim

For HTTP preserve method/URL, relevant headers, body, status, redirect chain, cookies/auth context by secure reference, raw response and actual state/callback evidence. Avoid browser-readable extraction when comments, scripts or exact headers matter. Record disabled TLS verification and how routing/virtual-host/SNI was established.

For native/mobile/runtime work preserve artifact hash/build, platform, input/state, principal/process context, minimal trace/stack and observed effect. For cloud/AD preserve actual identity/session and effective policy context. For stochastic AI tests record relevant history/configuration, retrieved artifacts, exact tool calls and successes/trials.

Record timestamp/timezone, environment/version, tool options, capture truncation, relevant sampling and artifact path/hash. Screenshots illustrate; raw transactions, inputs, state and traces make reproduction possible. Never fabricate missing output, exit status, privilege, callbacks or data.

Use secure storage and redacted report excerpts. Do not put secrets in command arguments, public reports, reusable instructions or model context. A unique canary or metadata proof is usually preferable to real sensitive data. Respect retention and do not upload client artifacts to public sandboxes without permission.

## False-positive challenge

Before confirming, answer the questions relevant to this mechanism:

- Is this the intended target/service/build, not a proxy, challenge, error template or stale local replica?
- Does the attacker actually control the triggering input/state and reach the path under the reported privilege?
- Is the claimed boundary supposed to hold, or is this an intentionally granted feature/admin power?
- Did the valid baseline work and the negative control behave differently?
- Could caching, shared state, redirects, reflection, test instrumentation or preexisting data explain the signal?
- Was the security effect independently observed, not just claimed by the tool/model or inferred from a response code?
- Do sanitization, a dominating check, a transaction, permissions, mitigation or unreachable feature defeat the path?
- Can a fresh controlled state reproduce the effect? If nondeterministic, are the observed conditions and trial counts stated?
- Does the conclusion depend on an unproved chain edge, unrealistic capability, unavailable role or destructive assumption?

Seek the strongest counterexample, not just confirming variations. Refute the narrow mechanism when contradicted; don't relabel every failed attempt as evidence the system is secure.

## Minimal safe PoC

A PoC should include setup, controlled identities/objects, exact input/sequence, expected legitimate behavior, observed unauthorized behavior and cleanup. It should do only enough to demonstrate the property. Prefer one owned record, one harmless execution marker, one canary file or a read-only identity/capability check to dumping data or modifying production controls.

Include negative and legitimate controls and describe external callbacks or test infrastructure. Prevent retries from multiplying state changes. Document rate/concurrency and stop conditions for stateful tests. If execution would exceed scope or allowed impact, supply the established evidence and label the remaining consequence untested rather than executing it anyway.

For chains, document each edge's input capability, preconditions, action, result and proof. Show that adjacent edges are compatible. Clearly mark where a chain stops; a plausible endpoint is not a demonstrated endpoint.

## Severity and classification

Explain likelihood/preconditions and business/technical impact separately. Distinguish exposure, weakness, exploitability and risk. Use the engagement's requested scoring standard; if none is specified and a score is useful, use the current applicable CVSS guidance and a verified calculator rather than guessing a number.

When publishing CVSS, provide version, nomenclature/metric groups, score, vector and rationale for non-obvious metrics. CVSS is owned by FIRST and used by permission. A Base score communicates intrinsic severity, not the organization's complete risk; incorporate environment and threat context separately. Do not transfer a vendor score unchanged when the demonstrated conditions differ.

Use specific CWE and framework identifiers only after checking their definitions and fit. ATT&CK/ATLAS describes behavior; OWASP lists/control standards guide relevant tests; neither proves exploitability. Novel behavior may need a narrative instead of a forced identifier.

Group manifestations by root cause and remediation while preserving materially different impacts. Don't inflate severity or finding count because several tools reported the same issue. Hardening opportunities and architectural trust assumptions should not be disguised as confirmed exploit findings.

## Report contract

For each confirmed finding provide:

- Title, affected asset/interface/build and status/confidence.
- Attacker prerequisites and violated security boundary.
- Reproduction with minimal inputs and expected versus actual behavior.
- Evidence references and relevant redacted excerpts.
- Demonstrated impact, clearly separated inferred consequences and limits.
- Severity rationale and verified classification if used.
- Root cause, concrete remediation and verification criteria.
- Related variants/chains, cleanup and retest status.

At engagement level provide objective/scope, assessment period/vantages, tested identities and material surfaces, sampling rationale, findings, control observations, limitations, unresolved leads and next actions. A truthful negative assessment says “no issue demonstrated within these tests,” not “no vulnerabilities exist.”

## Cleanup and retest

Reconcile all test-created accounts/files/objects, listeners/processes, credentials/certificates, ACL/config changes, test AP/device state and external infrastructure. Remove/revoke only engagement-owned state according to the agreed procedure; preserve audit trails and evidence. Record what was actually cleaned and what an owner must still do.

Retest the original case on the remediated build with comparable identity, state and vantage. Test a legitimate baseline plus relevant sibling/alternate path. Distinguish **fixed**, **partially fixed**, **still reproducible**, **not reproducible under current conditions**, and **blocked/untested**. Failure to reproduce without the original prerequisites does not prove a patch.

## Final reconciliation

Compare scope and objectives against the ledger: assets, services, identities, tenants, features, states, trust boundaries, versions, observed anomalies and chain edges. Every material unresolved item needs a disposition and reason. Make budget exhaustion, absent credentials/hardware, unavailable services and forbidden impact visible.

Declare completion only for the stated assessment boundary and evidence. If stopped early, use an honest status such as `partial`, `blocked` or `paused_budget`, name remaining work and preserve a concrete resumption point. Never hide unfinished testing behind a polished report.
