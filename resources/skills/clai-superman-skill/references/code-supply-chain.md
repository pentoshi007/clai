# Source audits, changes and supply-chain trust

Use for security code review, repository audits, dependencies, CI/CD and release pipelines. A code audit is not an invitation to edit, install or execute the repository; preserve the user's requested mode. Treat untrusted repositories and build hooks as attacker-controlled input.

## Build a causal model before searching

Identify entrypoints, privilege domains, data models, authoritative state, trust boundaries and sensitive sinks. Follow one representative normal operation end-to-end. Record version/commit, relevant configuration and deployment assumptions. Tests and comments express intent; actual call sites and runtime behavior determine the contract.

Search to navigate; read the code that proves a claim. Trace attacker control through parsing, normalization, validation, policy, serialization, persistence, workers and the final interpreter. Include indirect calls, registries, generated routes, plugins, FFI and conditional compilation when applicable. An unchecked value becomes a vulnerability only if it reaches a security-relevant operation under the attacker model.

## Audit from both directions

- From exposed inputs, ask what authority they can influence and where checks can be skipped.
- From privileged sinks, ask every caller, transformation and assumed precondition.
- From invariants, ask which operations can create a forbidden state and which failure/retry paths escape enforcement.
- From identity transitions, ask where authority is cached, copied, delegated, revoked or reconstructed.

Reconcile forward and backward paths. A source pattern with no reachable sink and a dangerous sink with only trusted input need different dispositions from an end-to-end vulnerability.

## Language/runtime families

| Surface | Useful hypotheses |
| --- | --- |
| JS/TS | Prototype mutation and reachable gadgets, coercion/null/undefined, own versus inherited properties, path/URL resolution, DOM/IPC sinks, async state races, dynamic import/eval and unsafe deserialization |
| Python/Ruby/PHP | Template/evaluation/deserialization reachability, shell/argument boundaries, dynamic dispatch, path handling and framework authorization/order |
| JVM/.NET | Deserialization/XXE where enabled, expression/template sinks, reflection, unsafe type resolution, security context propagation and framework configuration |
| Go/Rust | Parser/state/concurrency mistakes, path and numeric conversions, unsafe/FFI, ownership assumptions, cancellation/deadline behavior, resource/authorization logic |
| C/C++ | Bounds/arithmetic/lifetime, type confusion, concurrency, parser state, format strings and system-call privilege boundaries |
| SQL/config/IaC | Row/tenant policy, parameter binding, trigger/procedure authority, policy evaluation, defaults/fallbacks, secret references and drift |

These are search directions, not findings or an exhaustive language inventory. Research unfamiliar runtime semantics and exact dependency versions. Safe languages still permit logic and trust-boundary vulnerabilities.

## Differential review

For a change, establish the old invariant, the new behavior and affected callers. Inspect removed/relocated validation, changes in defaults, privilege/identity propagation, error handling and parsing order. Read nearby history or security patches when they explain a non-obvious constraint. Line count is not risk: a small key-selection or authorization change can cross a large boundary.

Assess transitive impact through callers, shared helpers, API/schema compatibility, generated consumers and background jobs. A refactor can change enforcement order without changing the nominal API. Test the original supported path and an alternate/error path; don't label missing tests themselves an exploitable vulnerability or inflate severity for absence of coverage alone.

## Static analysis that earns its cost

Use CodeQL, Semgrep or other analyzers when a modeled family benefits from scale. Configure languages, build modes, generated/excluded files and dataflow assumptions deliberately. Preserve machine-readable results and actual coverage limitations.

For a custom rule, start with a real seed and positive/negative fixtures; confirm the known instance hits. Broaden the root-cause pattern along meaningful axes and triage all candidate classes. Tune against false positives without excluding a plausible variant merely for convenience. A SARIF record or taint path is a hypothesis until reachability, guards and impact are checked.

Use [novel research](novel-research.md) for properties, differential testing and variants. Do not claim the entire repository audited when only changed files or reachable service paths were examined.

## Dependencies and build/release chains

Trace untrusted contribution/package/artifact -> execution context -> credentials/signing authority -> published artifact. Examine lockfiles and resolved transitive versions, optional/platform dependencies, postinstall/build scripts, private/public namespace resolution, registries, vendoring, generated code and update channels.

Version-match advisories to the installed artifact and configuration; check vendor backports and reachable feature paths. Distinguish vulnerable dependency presence, reachable vulnerable functionality and demonstrated exploit impact. Package popularity, staleness and concentration are risk signals, not proof of compromise.

For CI, inspect events, permissions, untrusted contexts expanded into scripts, privileged checkout, reusable workflows, runner reuse, artifact/cache trust, environment approvals and OIDC subject/audience conditions. A workflow triggered by an untrusted PR may have different privilege than one triggered in the base repository. Never execute an adversarial PR on a runner holding production secrets to validate a suspicion.

For releases, check source/artifact binding, signer/key access, immutable action/dependency references, provenance, promotion, rollback and verification at installation. Signing a compromised artifact doesn't make its source trustworthy. A tag pin and a full immutable commit pin have different guarantees.

## Proof and remediation

Write a minimal regression case that exercises the actual caller and violated invariant. Show attacker control, path, guard failure and consequence. If permitted to fix, change the root cause, preserve legitimate behavior and test siblings and negative cases. If the task is review only, deliver the evidence and fix recommendation without mutating the project.

Report exact files/lines/commit and configuration, not unsupported deployment claims. A code-level defect can be confirmed while remote exploitability remains untested. Keep that distinction in severity and reproduction, and state the repository/deployment areas not assessed.
