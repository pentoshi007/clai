# clai token-usage audit and reduction roadmap

Status: audit complete; implementation not started.

- Audited: 2026-10-16, clai 4.15.2.
- Source baseline: `ada38924a499a568e69984b35f99b75c375ecb98`.
- Working branch: `audit/token-efficiency-roadmap`.
- Scope of this delivery: audit, reproducible local measurements, design, phased implementation instructions and tasks. No runtime, prompt, schema, dependency, or cache-policy changes.
- This folder is outside ignored `docs/` and `audit/` directories so it can be versioned normally.

## Objective and priority

Reduce first-request context and total tokens per successfully completed task, ideally toward half of the current baseline. Preserve coding and security capability, first-attempt tool correctness, evidence fidelity, task completion quality, latency and cache continuity. A smaller safe reduction is preferable to a larger regression. No reduction is acceptable if those conditions cannot be demonstrated.

The local synthetic native fixture measures **22,374 estimated tokens**; with MCP controls and vision it measures **23,784**. These are character-based estimates, not provider token counts or a reproduction of the user's exact session. The current compact native fixture measures 13,928, but that is not evidence of behavioral equivalence and must not simply become the default.

## Critical cache boundary

**Do not edit an established prefix to make it shorter.** Tool descriptions and schemas are part of the provider-rendered prefix too. Keeping a hash or affinity key unchanged does not make changed content cache-compatible.

This roadmap has two explicitly separate lanes:

1. **Strict continuity:** preserve the current prompt, ordered schemas and sent history byte-for-byte; improve measurement, avoid redundant future context/model rounds, and optimize equivalent local work. This lane does not promise to halve startup context.
2. **New-session profile experiment:** only after explicit owner approval, evaluate a new immutable prompt/schema profile in isolated new sessions. It necessarily starts a different cache prefix; it must never replace a profile inside an existing/resumed session. Approval of this audit is not approval to incur that transition.

If “never break cache” means no new prefix even for a deliberately new session, lane 2 remains blocked. Continue lane 1 and report the attainable reduction honestly. Provider eviction, TTL, routing and model changes also prevent any client from guaranteeing a cache hit on every request.

## Reading order

1. [Implementer instructions](IMPLEMENTER.md): constraints, completion and phase commit/push protocol.
2. [Audit](audit.md): measured baseline, architecture, findings and limits.
3. [Cache-safe design](cache-design.md): invariants and version-transition boundary.
4. [Tool decisions](tool-catalog.md): retain/optimize decisions, including `http.fetch`.
5. [Roadmap](roadmap.md): exact work packages, dependencies, touched contracts, cleanup and rollback.
6. [Validation](validation.md): coding/security scenarios and release gates.
7. [Tasks](tasks.md): executable checkbox ledger; update it while implementing.
8. [Evidence](evidence/README.md): reproduction, data and checks already run.

## Success must be measured three ways

- **Context:** actual input tokens and their provenance, separated into prompt, tools, dynamic context and history.
- **Efficiency:** total input/output/cache-write tokens, model rounds, tool calls, first-attempt errors, latency and local resource usage per verified outcome.
- **Quality:** unchanged or better independent acceptance results for coding and security scenarios, including negative/boundary cases and recovery.

A lower UI number, shorter description, passing hash snapshot, or one successful model run is not sufficient.

## Delivery versus implementation

The audit's 108 selected tests passed, typecheck passed, and generated prompts matched source. No live model A/B evaluation, real cache-hit measurement, full-suite execution, or optimized runtime is claimed. Future tasks remain unchecked on purpose.

Implement phase by phase. Close each phase with evidence, update `tasks.md`, commit the coherent phase and push its branch using the protocol in `IMPLEMENTER.md`. Do not ship an unproven candidate merely to reach 50%.
