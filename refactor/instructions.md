# Refactor instructions

These rules are binding for every change executed under this program. Their purpose is to make structural improvement reviewable, reversible, and behavior-preserving.

## 1. Scope and authority

- Audit and improve the entire production repository, including `src/agent`, `src/llm`, `src/tools`, `src/safety`, `src/store`, `src/app`, `src/ui-core`, `src/classic`, `src/tui-v2`, `src/noninteractive`, `src/session-runtime`, `src/interactive-session`, `src/mcp`, commands, OS adapters, build scripts, and relevant tests.
- Follow the ordered plans in `refactor/plan/phase-0.md` through `phase-8.md`.
- Do not begin production refactoring before the planning milestone is committed and pushed. Phase 0 may add tests, scripts, pinned quality dependencies, configuration, CI wiring, and reports; any production behavior change requires separate approval and a separate commit.
- Existing behavior at the recorded anchor is the default contract, including awkward behavior. Tests may clarify that contract; they may not redefine it silently.

## 2. Mandatory workflow

For every extraction seam:

1. **Establish entry evidence.** Confirm the expected branch, clean worktree, prior phase status, generated-file synchronization, and canonical green baseline.
2. **Map the seam.** Record callers, exports, side effects, mutable closure state, singleton identity, I/O, environment dependencies, errors, event ordering, and platform branches.
3. **Characterize first.** Add tests for observable success, failure, cancellation, retry, boundary, ordering, durability, and redaction behavior that is not already protected.
4. **Move mechanically.** Extract or relocate one cohesive concern while preserving public names, signatures, import behavior, error text, event order, serialization, and timing semantics where timing is observable.
5. **Keep compatibility.** Re-export through the old module until callers can be migrated in a later mechanical commit. Do not create a second implementation or a second stateful singleton.
6. **Validate immediately.** Run the narrowest relevant suite, typecheck, architecture checks, and changed-code quality checks.
7. **Clean up separately.** Rename, simplify, remove stale comments, tighten types, or optimize only after the move is proven equivalent. A cleanup commit must remain independently revertible.
8. **Close with evidence.** Run the phase matrix, capture metrics and command results, update the task ledger, and identify the exact rollback commit.

If characterization is impractical, stop and make the dependency or test seam explicit. Do not use confidence or code review as a substitute for executable evidence.

## 3. Commit discipline

- One coherent concern per commit. Use Conventional Commits.
- Prefer this order: `test(...)` characterization, `refactor(...)` pure extraction/re-export, `refactor(...)` caller migration, then `refactor(...)` cleanup.
- Never combine a mechanical move with a behavior fix, dependency upgrade, formatting sweep, broad rename, or unrelated test rewrite.
- Pure moves should remain recognizable as moves. Avoid reflowing, renaming, and logic edits in the same diff.
- A required remove-only baseline update belongs in the same commit as the structural change that makes the entry obsolete. This does not permit a behavior change in that commit.
- Stage named files, preserve hooks, do not amend unless explicitly authorized, and never push directly to `main` or `master`.
- Push coherent milestones from `refactor/codebase`; use `git push -u origin refactor/codebase` for the first push.

Suggested subjects include:

```text
test(agent): characterize turn finalization
refactor(agent): extract turn output emitter
refactor(llm): separate openai stream decoder
build(quality): add pinned report-only metrics
```

## 4. Protected behavior

### Agent and orchestration

Preserve `runAgentLoop` and `runAgentTurn` public signatures, tool-call ordering, event IDs and ordering, output channels, usage accounting, compaction thresholds and summaries, loop-guard decisions, evidence gates, responder claims, queued-prompt behavior, cancellation, abort outcomes, and exactly-once finalization. Keep `test/agent/runner-no-direct-writes.test.ts` green.

### LLM transport and routing

Preserve exact request paths, methods, headers, auth shapes, JSON omission/default/null behavior, tool schemas, system-message placement, prompt caching, reasoning controls, image payloads, stream chunk interpretation, thinking/tool delta ordering, usage aggregation, EOF handling, error classes/messages, retry counts, backoff, key and endpoint rotation, provider fallback, and sticky selection.

Snapshots are contracts. Review every snapshot diff. Never update snapshots merely to make a refactor pass.

### Tools, safety, and network boundaries

Preserve tool names, descriptions, schemas, aggregate order, normalization, result envelopes, truncation, artifacts, and confirmation behavior. Preserve monotonic risk classification, delete previews, shell/process controls, scope phases, rate and concurrency limits, redirect and DNS-rebinding checks, SSRF protection, scheme allowlists, header/cookie bounds, credential stripping, audit records, and redaction-before-persistence.

### Persistence and sessions

Preserve paths, formats, schema versions, migrations, JSONL/SQLite behavior, ordering, atomicity, file modes, corruption recovery, retention, session-plan linkage, key masking, job IDs, singleton identity, process ownership, PTY detach/reattach, replay bounds, cleanup, and secret-input redaction order.

### UI and CLI surfaces

Preserve command names and aliases, stdout/stderr separation, exit codes, transcript semantics, streaming order, status text, key/mouse routing, focus/scroll behavior, pager content, diffs, plan state, history restore, sign-off output, terminal mode restoration, and semantic parity across Classic, OpenTUI, and noninteractive rendering.

### MCP and untrusted data

Preserve configuration precedence, interpolation, namespaced tool order, safe-tool policy, OAuth/PKCE/token handling, redirect credential isolation, bounded results, lifecycle, refresh/reconnect, and treatment of server text as untrusted data.

### Platforms and release

Do not normalize away Linux, macOS, Windows, Node, Bun, POSIX PTY, ConPTY, path, permission, process, or keychain differences. Host-specific behavior needs host-specific evidence. Preserve package contents, built entrypoint behavior, prompt embedding, version synchronization, installers, and release verification.

## 5. Locale, timezone, randomness, and time

- The audit host uses `LANG=en_IN.UTF-8`; the unqualified suite renders `120000` as `1,20,000` in two expectations that require `120,000`.
- The canonical test command must be made explicit in Phase 0, with locale and timezone set before Node starts. The baseline command is `LC_ALL=C LANG=C TZ=UTC npm test -- --reporter=dot` once Phase 0 verifies `TZ=UTC` does not alter contracts.
- Canonicalization does not authorize changing product formatting. Add separate subprocess characterization for supported locale-sensitive formatting and collation, including job ordering, file-list ordering, and number/token/byte rendering.
- If the product contract is changed from host-sensitive to fixed formatting, treat that as an independently approved behavior change.
- Tests that involve clocks, random IDs, retry jitter, or scheduling must use explicit clocks/seeds or bounded assertions without weakening the behavior contract.

## 6. Generated and behavior-bearing files

Never hand-edit generated outputs:

- `src/prompts/embedded.ts` is generated by `scripts/embed-prompts.mjs` from `src/prompts/system.agent.md` and `src/prompts/system.ask.md`.
- `src/version.generated.ts`, Homebrew/Scoop version fields, and root lockfile version fields are synchronized by `scripts/sync-version.mjs` from `package.json`.

Run the generator and review its diff when a source changes. `npm run embed-prompts:check` must pass.

Treat these as behavior-bearing and exempt from arbitrary line splitting or reflow:

- `src/prompts/system.agent.md` and `src/prompts/system.ask.md`;
- protocol/wire snapshots, fixtures, golden transcripts, and generated artifacts;
- files whose layout is consumed by a release or compatibility check.

An exemption prevents cosmetic splitting; it does not exempt executable code from quality gates.

## 7. Architecture and file boundaries

- `test/architecture/legacy-baseline.json` is remove-only. Never add an oversized file or runtime-policy exception.
- New source files must satisfy the existing architecture gate immediately and the program's terminal `<500` target. Aim below 400 lines to leave review headroom; Classic source must follow the contributor guideline of at most 400 lines.
- When a frozen oversized file reaches 1,000 lines or fewer, remove its entry in the same change. Continue to `<500`; removal from the legacy baseline is only an intermediate milestone.
- Prefer cohesive folders with a small facade, explicit dependency types, pure helpers, and directional imports. Do not replace one god module with a barrel that hides cycles or a context object containing unrelated mutable state.
- Preserve ESM conventions, including explicit `.js` relative import suffixes.
- Architecture exception removal that changes the exact expected edge set must update the remove-only baseline in the same structural commit.

## 8. Quality measurement and ratchets

### Definitions

Phase 0 must pin one compatible toolchain and record exact package versions, commands, scope, exclusions, formulas, and JSON report locations. Until then, audit complexity values are prioritization proxies, not pass/fail evidence.

The terminal definitions are:

- cyclomatic maximum per function-like unit `<22`;
- cognitive maximum per function-like unit `<22`;
- Halstead difficulty maximum per function-like unit `<80`;
- CRAP maximum per measured function `<25`, with the formula and coverage mapping recorded by the toolchain;
- ordinary production source files `<500` physical lines under the Phase 0 definition;
- coverage `100%` for statements, branches, functions, and lines in the declared production scope;
- mutation has zero survived and zero no-coverage mutants;
- dead-code/dependency and duplicate/redundancy reports contain zero unresolved production findings.

### Rollout

1. Add exact-pinned tools in report-only mode; commit lockfile changes with no production refactor.
2. Generate a machine-readable baseline from a green anchor.
3. Reject new findings and regressions immediately.
4. Require changed/new code to meet terminal limits wherever the analyzer can attribute it reliably.
5. Ratchet baseline counts and maxima downward as findings are removed; never raise a baseline to make a change pass.
6. Make a gate blocking only after it is stable and reproducible.
7. Use bounded module mutation runs during phases; run repository-wide mutation in scheduled/phase-close jobs once runtime is practical.

A missing, crashed, timed-out, or skipped analyzer is not green. Temporary infrastructure failure must be recorded and rerun.

### Exclusions

Exclusions must be path-specific, justified, reviewed, and as narrow as possible. Generated outputs and non-executable contractual fixtures may be excluded from code metrics. Do not use blanket directory, file-type, test, mutation, coverage, or duplication ignores to manufacture compliance.

## 9. Type safety

- End state: zero explicit `any` in production code. Do not replace `any` with `unknown` plus a cast.
- `unknown` is correct at untrusted boundaries such as JSON, provider payloads, MCP results, environment/config decoding, and caught errors. It must be narrowed through predicates, schemas, discriminated unions, or decoders before domain use.
- Phase 0/7 reporting must classify `unknown` as boundary-valid, narrowing-required, or internal-imprecision. The enforced gate is zero unsafe/unjustified cases, not a blindly minimized raw count.
- Do not add double assertions, broad `as` casts, `@ts-ignore`, unscoped `@ts-expect-error`, disabled checks, or assertion helpers that merely hide uncertainty.
- Suppressions require a focused test, issue/reference, reason, and removal condition. The terminal target is no unresolved suppressions.
- Prefer narrow domain types, exhaustive switches, `satisfies`, branded validated values, and result types over casts.

## 10. Comment policy

Use parser/token-aware discovery and manual review. Never perform regex-only bulk comment deletion.

Preserve licenses, generated markers, public API documentation, security invariants, protocol references, non-obvious rationale, compatibility notes, and operational constraints. Delete a comment only when it narrates syntax, duplicates the code, is contradicted/stale, or contains commented-out implementation. Comment cleanup follows, never accompanies, the behavior-preserving move it describes.

## 11. Dependencies and tooling

- Add dependencies only in Phase 0 or a separately approved tooling change.
- Use exact versions in `package.json`; no `^`, `~`, `*`, tags, or open ranges. Commit `package-lock.json`.
- Match coverage integration to the pinned Vitest version (`4.1.10` at the audit anchor) unless an independently validated toolchain upgrade is approved.
- Run compatibility and runtime-cost spikes before making a new analyzer blocking.
- Do not transmit source, secrets, fixtures, or reports to third-party services. Quality tooling must run locally or in trusted CI.

## 12. Validation and evidence

After each seam, run targeted tests. Before every phase-close commit, run at minimum:

```sh
npm run typecheck
npm run embed-prompts:check
npm run test:arch -- --reporter=dot
LC_ALL=C LANG=C npm test -- --reporter=dot
npm run build
git diff --check
```

Use the phase plan for additional suites such as conformance, admission, security, Bun, PTY, package, release, and platform jobs. Before Phase 0 establishes `TZ=UTC`, compare its result with the recorded `LC_ALL=C LANG=C` baseline.

Every evidence record must contain:

```text
phase/task:
git commit and branch:
environment (OS, architecture, Node/Bun, locale/TZ):
command:
exit status:
result counts or metric values:
report/artifact path:
expected warnings/skips:
changed public contracts: none | details
rollback boundary:
reviewer/date:
```

A checked task needs concrete evidence, not “covered by tests” or “looks equivalent.”

## 13. Stop and rollback conditions

Stop the current seam when:

- an observable payload, output, ordering, error, exit code, persistence format, permission, or platform behavior changes unexpectedly;
- a test requires broad mocking or snapshot replacement to pass;
- a singleton, process, session, key rotation, or responder identity is duplicated;
- architecture edges worsen or a baseline would need to grow;
- a changed function exceeds a terminal complexity limit without a documented immediate decomposition step;
- generated outputs differ without an intentional source change;
- the full phase suite is flaky or cannot be reproduced.

Revert the smallest extraction commit, keep valid characterization tests where possible, document the failed seam, and redesign dependencies before continuing. Do not stack speculative fixes on a broken move.
