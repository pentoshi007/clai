# Behavior-preserving refactor program

Status: **planning milestone**. This directory defines the program; it does not authorize unplanned production changes. Production refactoring starts with [Phase 0](plan/phase-0.md) only after this milestone is reviewed, validated, committed, and pushed from `refactor/codebase`.

## Mission

Make the TypeScript CLI easier to understand, debug, maintain, and contribute to without changing observable behavior. The program covers the whole repository, not only the largest files, and protects the agent loop, LLM protocols, tool safety, persistence, terminal sessions, renderer parity, MCP, release behavior, and supported operating systems.

The baseline is anchored at commit `35e4b3529433a3419f11d2b5f35ce740f8d94826`; see [baseline.md](baseline.md). The rules in [instructions.md](instructions.md) are binding for every phase and commit. [tasks.md](tasks.md) is the durable execution ledger.

## End-state gates

| Gate | Required end state |
|---|---:|
| Cyclomatic complexity | `< 22` per function-like unit |
| Cognitive complexity | `< 22` per function-like unit |
| Halstead difficulty | `< 80` per function-like unit |
| Source file length | `< 500` physical lines per ordinary production file |
| Test coverage | `100%` statements, branches, functions, and lines in the defined production scope |
| CRAP | `< 25` per measured function |
| Mutation | `0` surviving and `0` no-coverage mutants |
| Dead code | `0` reported production symbols/files/dependencies |
| Duplicate/redundant code | `0` reportable clones and `0` unresolved reviewed findings |
| Explicit `any` | `0` |
| Unsafe or unjustified `unknown` | `0`; validated boundary `unknown` remains allowed and must be narrowed |
| Unsafe casts/suppressions | `0` unresolved findings |

The current architecture check's `1,000`-line ceiling is an intermediate remove-only ratchet, not the final file-size definition of done. Generated outputs, behavior-bearing prompt Markdown, and contractual fixtures are governed separately; they may not be split or reflowed merely to satisfy a line count.

## Program map

| Phase | Scope | Principal outcome |
|---:|---|---|
| [0](plan/phase-0.md) | Baseline and quality foundation | Deterministic test command, locale/TZ characterization, pinned report-only tooling, reproducible metrics, export inventories, evidence format |
| [1](plan/phase-1.md) | Agent turn orchestration | `src/agent/runner.ts` becomes a small compatibility facade over explicit, cohesive turn modules |
| [2](plan/phase-2.md) | LLM transport and routing | Payloads, streams, errors, retry/rotation, and routing are separated without wire changes |
| [3](plan/phase-3.md) | Tool registry, definitions, jobs, files, shell | Stable aggregate tool contracts over cohesive handlers and lifecycle modules |
| [4](plan/phase-4.md) | Persistence and durable state | History, plans, config, keys, and scope are separated by codec, storage, recovery, and policy |
| [5](plan/phase-5.md) | Parsing, policy, safety, web, interactive sessions | Protocol parsers and high-risk execution boundaries become explicit and testable |
| [6](plan/phase-6.md) | App, UI core, renderers, noninteractive output | Renderer-neutral semantics and parity are preserved across OpenTUI, Classic, and streams |
| [7](plan/phase-7.md) | Repository-wide structural/type/comment closure | Remaining line, complexity, type, architecture, and reviewed comment debt is closed |
| [8](plan/phase-8.md) | Quality and platform closure | All terminal quality gates and the complete CI/release/platform matrix pass |

Phases are sequential. Small preparatory characterization commits may be shared with a later phase, but implementation from a later phase must not be pulled forward simply because it is nearby.

## How to execute a phase

1. Read [instructions.md](instructions.md), the current phase plan, and all earlier phase evidence.
2. Re-run the canonical baseline and confirm a clean worktree.
3. Add or strengthen characterization tests before moving behavior.
4. Extract one cohesive seam at a time. Land pure moves/re-exports before cleanup.
5. Apply changed-code gates immediately and never worsen a repository baseline.
6. Run targeted checks after each seam and the complete phase validation before closure.
7. Record commands, results, metrics, changed contracts, and rollback boundary in [tasks.md](tasks.md) and the phase evidence.
8. Commit one coherent concern using Conventional Commits; push only from the feature branch.

A phase cannot close because a metric was not run. `unmeasured`, `not configured`, and `timed out` are evidence states, not passing states. Gates are satisfied by locally reproducible commands on the execution host; a contract that cannot be exercised on this host is recorded as out of local scope rather than claimed as passed, and it does not block phase closure.

## Non-negotiable behavior contracts

Every phase must preserve, or explicitly characterize before touching:

- safety classification, confirmation, block, scope, and engagement rules;
- SSRF, redirect, DNS-rebinding, credential-forwarding, redaction, and output bounds;
- exact LLM request shapes, headers, omission/default rules, stream ordering, EOF, usage, retry, and terminal semantics;
- agent compaction, loop guards, tool protocol repair, evidence gates, responder ownership, cancellation, and finalization;
- history, plan, job, session, key, and config durability, recovery, permissions, and retention;
- PTY ownership, detach/reattach, process-tree cleanup, input safety, and secret-redaction ordering;
- semantic and transcript parity across Classic, OpenTUI, and noninteractive output;
- MCP discovery, auth, validation, redirect, namespace, lifecycle, and untrusted-data handling;
- Linux, macOS, Windows, Node, Bun, package, build, and release behavior.

If a pre-existing defect is discovered, document it. Fix it only in a separately approved behavior-change commit with its own tests; never conceal it inside extraction or cleanup.

## Document authority

When documents disagree, use this order:

1. Repository behavior and tests at the recorded green anchor.
2. `CONTRIBUTING.md`, architecture tests, CI/release workflows, and generated-file scripts.
3. [instructions.md](instructions.md).
4. The numbered phase plan.
5. [tasks.md](tasks.md) status notes.

Update the plan in a dedicated documentation commit when new evidence invalidates an assumption. Do not silently improvise around a protected invariant.
