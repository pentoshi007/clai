# Phase 5 — Parsing, policy, safety, web, and interactive sessions

Status: **planned**
Depends on: Phase 4 complete
Primary hotspots: agent parser/plan/evidence/loop modules, safety classifier, HTTP/web pipeline, interactive-session manager

## Objective

Decompose the repository's highest-risk protocol and execution boundaries without weakening validation, authorization, scope, redaction, output bounds, or lifecycle guarantees. Separate pure parsing/decoding from policy and side effects so each security invariant is directly testable.

## Scope

In scope:

- `src/agent/tool-call-parser.ts` (audit: 2,235 lines);
- `src/agent/plan-tool.ts` (1,682), `task-evidence.ts` (1,153), and `loop-guard.ts` (1,081);
- `src/safety/classifier.ts` and closely coupled engagement/scope classification helpers;
- `src/tools/http.ts` (1,086), `src/tools/web/fetch-core.ts` (1,620), and focused web validation/redirect/redaction/output helpers;
- `src/interactive-session/manager.ts` (1,497) and its registry, lifecycle, policy, output, artifact, redaction, and platform seams;
- MCP tests when shared HTTP/auth/untrusted-data behavior is affected.

Out of scope:

- loosening or redesigning security policy;
- new attack/recon capabilities, parser protocols, plan semantics, or terminal features;
- renderer presentation (Phase 6);
- provider transport (Phase 2) and generic process ownership already handled in Phase 3;
- behavior fixes mixed with extraction.

## Protected contracts

### Tool-call parsing

Preserve:

- native and text-fence protocols, incremental/partial parsing, JSON repair limits, argument normalization, occurrence order, IDs, and duplicate handling;
- malformed/truncated/ambiguous input behavior, diagnostics, salvage rules, and no execution from untrusted commentary;
- protocol-history repair and model-specific compatibility;
- distinction between parser result, validation error, and executable call.

### Plan, evidence, and loop policy

Preserve:

- plan mode/approval gates, create/replace/rearrange/dependency normalization, single-active plan, reminders, and transactional task updates;
- evidence requirements, completion/partial/block/fail outcomes, task sync, finalization gates, and no unsupported “done” claim;
- loop-domain keys, thresholds, read-range behavior, continuation, recovery, and user-facing stop reason;
- separation between policy decisions and runner orchestration established in Phase 1.

### Safety and engagement

Preserve or, in a separately approved behavior change, make stricter:

- safe/confirm/block outcomes and monotonic composition for batches;
- destructive command/pattern blocking, delete confirmation/preview, privilege rules, and classifier no-exec property;
- authorized/excluded targets, phases, expiry, redirect escape, DNS-rebinding defense, rate/concurrency limits, and loopback exceptions;
- exact target/port/phase accumulation for interactive inputs;
- no network/process/file side effect during classification.

### HTTP and web

Preserve:

- URL/input validation, allowed schemes/methods, DNS resolution, private/special address rules, scope checks, and rebinding protection;
- redirect count/order, cross-origin credential/header stripping, and out-of-scope escape handling;
- timeout/single-attempt behavior, decompression, binary/text decisions, charset/content handling, and status/error mapping;
- header/cookie/body/metadata/output limits, truncation markers, artifacts, readable extraction, audit logging, and redaction;
- search-provider key precedence/masking and no secret leakage;
- untrusted remote text never becoming instructions or executable data.

### Interactive sessions

Preserve:

- conversation ownership, session IDs, registry isolation, PTY/pipe selection, process-tree lifecycle, resize, interrupt, close, and recovery;
- input policy re-evaluation at delivery time, accumulated security context, and plan/scope gates;
- incremental/cursor-addressed output, offsets, bounds, status, artifacts, and telemetry;
- prompted secret detection and redaction **before** transcript/artifact persistence;
- cleanup races, legacy isolation, Bun/node-pty/platform behavior, and restrictive resource ownership.

### MCP regression boundary

Preserve OAuth/PKCE/token storage, auth discovery, redirect credential isolation, config validation/interpolation, namespaced tools, selection, bounded results, manager lifecycle, and treatment of server text as untrusted.

## Required characterization

Run and strengthen:

```sh
npx vitest run \
  test/agent-parser.test.ts \
  test/tool-args-snapshot-repair.test.ts \
  test/agent/tool-history.test.ts \
  test/loop-guard.test.ts \
  test/loop-guard-domain.test.ts \
  test/loop-guard-read-ranges.test.ts \
  test/task-evidence.test.ts \
  test/evidence-governor.test.ts \
  test/plan-gate-enforcement.test.ts \
  test/plan-mode-policy.test.ts \
  test/plan-create-normalize.test.ts \
  test/plan-transactional.test.ts \
  test/safety.test.ts \
  test/engagement-policy.test.ts \
  test/scope.test.ts \
  test/security \
  test/http-policy.test.ts \
  test/web \
  test/interactive-session \
  test/mcp \
  --reporter=dot
```

Add property/fuzz fixtures for parser chunking and malformed data, classifier monotonicity/no-exec, URL canonicalization/DNS changes/redirect credentials, all output bounds, and interactive redaction/scope ordering. Use local fake transports/servers; no live third-party requests.

## Intended module boundaries

### Parser family

Separate protocol detection, native parsing, text-fence parsing, incremental scanner state, JSON/argument repair, occurrence normalization, and diagnostic formatting. Parsers return typed results and never execute tools.

### Plan/evidence/loop policy

Separate plan command decoding, normalization, domain transitions, persistence ports, evidence evaluation, final-answer policy, and loop-domain state. Keep policy functions pure where possible and runner integration behind explicit interfaces.

### Safety

Separate tool-argument target extraction, shell command parsing, pure risk rules, batch composition, engagement/scope evaluation, and confirmation projection. Classification code must not call execution APIs.

### HTTP/web

Separate:

1. input and URL normalization;
2. DNS/address/scope decision;
3. redirect policy and credential projection;
4. transport/timeout;
5. content decoding/decompression;
6. bounds/truncation/artifacts;
7. readable extraction;
8. redaction/audit;
9. stable tool facade.

Revalidate DNS/scope on every redirect/connection decision as current behavior requires. Do not merge provider search behavior into raw fetch.

### Interactive sessions

Separate registry/identity, process/platform adapter, lifecycle state machine, input-policy enforcement, output model/store, artifact writer, redaction, recovery/cleanup, and manager facade. Exactly one registry and process owner must remain.

## Work sequence

1. Freeze parser/policy/security/network/session outcomes and error text with fixtures and property tests.
2. Extract pure protocol parsers and repair helpers one protocol at a time.
3. Extract plan normalization/transitions, evidence evaluation, and loop-domain policy without changing gates.
4. Extract safety target/command parsing, then pure rules, then scope/batch composition.
5. Split HTTP/web input/DNS/redirect policy before transport/content/output modules.
6. Model interactive-session state/ownership; extract input policy and redaction before lifecycle/platform mechanics.
7. Run the complete MCP suite after every shared HTTP/auth/redaction utility migration.
8. Reduce facades below 500 lines and remove each frozen oversized entry in the same qualifying commit.
9. Perform naming/type/comment cleanup only after equivalent behavior is proven.

## Acceptance criteria

- [ ] Parser outputs/order/repair/errors and plan/evidence/loop decisions are unchanged.
- [ ] Safety outcomes never weaken; classifier remains side-effect free.
- [ ] SSRF, DNS rebinding, redirect, scope, credential, redaction, and all bound contracts pass property/security tests.
- [ ] Interactive identity/lifecycle/input/output/redaction/recovery ordering is unchanged on supported platforms.
- [ ] MCP auth/redirect/untrusted-data/lifecycle behavior has no regression.
- [ ] All scoped ordinary files are `<500`; applicable legacy entries are removed without additions.
- [ ] Changed functions meet complexity/Halstead/CRAP/type ratchets; scoped mutation has zero survivors/no-coverage mutants.
- [ ] No live external request or unsafe cast was introduced for test convenience.
- [ ] Targeted, architecture, canonical full-suite, build, PTY/platform-relevant, and quality checks pass.

## Validation

The `test:deterministic` and `quality:*` scripts below are Phase 0 deliverables and must exist before this phase begins; use the final names recorded by Phase 0.

After each parser/policy/boundary seam:

```sh
npm run typecheck
npx vitest run test/agent-parser.test.ts test/task-evidence.test.ts test/loop-guard.test.ts --reporter=dot
npx vitest run test/safety.test.ts test/security --reporter=dot
npm run test:arch -- --reporter=dot
npm run quality:changed
```

At phase close:

```sh
npm run typecheck
npm run embed-prompts:check
npm run test:arch -- --reporter=dot
npx vitest run test/agent-parser.test.ts test/agent/tool-history.test.ts test/loop-guard.test.ts test/task-evidence.test.ts --reporter=dot
npx vitest run test/safety.test.ts test/engagement-policy.test.ts test/scope.test.ts test/security --reporter=dot
npx vitest run test/http-policy.test.ts test/web --reporter=dot
npx vitest run test/interactive-session --reporter=dot
npx vitest run test/mcp --reporter=dot
npm run test:deterministic -- --reporter=dot
npm run build
npm run quality:ratchet
npm run quality:mutation -- --scope policy-boundaries
# Supported POSIX host
npm run test:classic:pty
git diff --check
```

Interactive platform integration and Windows privilege/process evidence must run on their target hosts before closure.

## Commit and rollback plan

Use one protocol, policy evaluator, network stage, or session lifecycle concern per commit. Keep stable facades and existing state owners until callers migrate. A security outcome change, credential leak, reordered redaction, duplicate session owner, or changed redirect/DNS decision is an immediate stop/revert condition. Security fixes require their own reviewed behavior commit; never hide them in a move.
