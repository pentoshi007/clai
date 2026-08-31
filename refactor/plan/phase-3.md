# Phase 3 — Tools, jobs, files, and shell

Status: **planned**
Depends on: Phase 2 complete
Primary hotspots: `src/tools/jobs.ts`, `registry.ts`, `definitions.ts`, `fs.ts`, and `shell.ts`

## Objective

Replace oversized tool modules with cohesive family definitions, handlers, and lifecycle services while retaining one stable aggregate registry and one owner for every stateful job/process resource. Preserve tool schemas, ordering, safety handoffs, result envelopes, persistence, and cross-platform process behavior.

HTTP/web tools remain for Phase 5 because their SSRF/redirect/scope boundaries need a dedicated security sequence.

## Scope

In scope:

- `src/tools/definitions.ts` (audit: 1,648 lines);
- `src/tools/registry.ts` (2,125 lines);
- `src/tools/jobs.ts` (2,589 lines);
- `src/tools/fs.ts` (1,471 lines);
- `src/tools/shell.ts` (1,042 lines);
- closely coupled job writer/process/path/result helpers;
- static tool aggregate exports and MCP append integration points;
- targeted tool, job, file, shell, package, process, and security tests.

Out of scope:

- HTTP/web implementation and safety classifier decomposition (Phase 5);
- persistence backend redesign (Phase 4), though existing job persistence contracts remain protected;
- adding, removing, renaming, or redesigning tools;
- changing confirmation/risk/scope policy;
- command execution optimization or altered timeout/output defaults.

## Protected contracts

### Definitions and registry

Preserve:

- canonical tool names, aliases, descriptions, JSON schema shape, required/default fields, enums, limits, and aggregate order;
- native/text tool-call compatibility and argument normalization;
- static built-ins first and selected MCP definitions appended in deterministic order;
- dispatch result envelopes, error text/codes, timing, artifacts, truncation, metadata, and audit hooks;
- ask/plan/agent availability and confirmation/safety calls;
- `tool.batch` child order, parallel policy, highest-risk inheritance, and `continue`/`cancel_pending` behavior;
- no duplicate registry, handler map, schema object, or registration side effect.

### Jobs and processes

Preserve:

- singleton identity and conversation/session ownership;
- job IDs, start timestamps, displayed order, status transitions, persistence/recovery, and bounded tail semantics;
- foreground/background selection, process group/tree ownership, detach behavior, signals, stop/cleanup, and orphan prevention;
- stdout/stderr capture order, decoder behavior, byte/line bounds, artifacts, writer flush/close, and errors;
- Windows, macOS, Linux, POSIX shell, and PTY-sensitive branches;
- resource cleanup after success, failure, abort, timeout, and process launch races.

### File and shell tools

Preserve:

- path resolution, safe cwd, symlink/directory handling, encoding, read bounds, numeric/name listing order, and output formatting;
- surgical edit/replace/append/writeMany behavior, newline preservation, atomic writes, modes/metadata, and partial-failure semantics;
- delete confirmation and preview behavior;
- shell command analysis, quoting, environment/cwd, no-match exits, timeout, bounded output, interactive detection, launch retry, elevated execution, and package-install idempotence;
- secret masking and redaction before events, persistence, or artifacts.

## Required characterization

Run and strengthen:

```sh
npx vitest run \
  test/tools \
  test/tools.test.ts \
  test/registry.test.ts \
  test/tool-normalize.test.ts \
  test/tool-batch.test.ts \
  test/batch-fail-policy.test.ts \
  test/jobs-durable.test.ts \
  test/jobs-resource-hygiene.test.ts \
  test/jobs-session-scope.test.ts \
  test/jobs-poll-bounding.test.ts \
  test/job-tail-pager.test.ts \
  test/fs-append.test.ts \
  test/fs-edit-delete.test.ts \
  test/fs-read-directory.test.ts \
  test/fs-read-smart.test.ts \
  test/fs-write-many.test.ts \
  test/shell-bounded.test.ts \
  test/shell-interactive.test.ts \
  test/shell-launch-retry.test.ts \
  test/shell-no-match-exit.test.ts \
  test/pkg-install-idempotent.test.ts \
  test/process-tree.test.ts \
  test/security \
  --reporter=dot
```

Add exact contract snapshots for the aggregate definition order/schema, registry dispatch envelopes, job state machine, list ordering under characterized locales, process cleanup, atomic-write metadata, and every cancellation/partial-failure path.

## Intended module boundaries

### Tool definitions

Split definitions by stable families (files, shell/jobs, network, HTTP/web, pentest, orchestration, plan/context, MCP bridge) while retaining one deterministic aggregate module. Family modules contain schemas/metadata only, not execution state.

### Registry

Split dispatch by family behind one aggregate registry facade. Each handler receives narrow dependencies for cwd, safety, scope, stores, jobs, terminals, and artifacts. Avoid a service locator containing the entire application.

### Jobs

Separate:

1. immutable job/process identity and state types;
2. in-memory/durable store adapter with one singleton owner;
3. output writer/buffer/artifact policy;
4. process launcher and platform adapter;
5. lifecycle transitions and cleanup;
6. tail/read/status projection;
7. command-facing facade.

Do not instantiate the store or process manager from family handlers. Inject or import the existing stable singleton through one composition point.

### Files

Separate path/validation and read/list concerns from atomic mutation/edit/delete concerns. Shared atomic-write primitives may later serve stores only after Phase 4 proves semantics are identical; do not prematurely generalize.

### Shell

Separate command classification/normalization, foreground execution, background-job integration, package installation, privilege/platform handling, and result formatting. Keep process creation in one platform-aware layer.

## Work sequence

1. Freeze aggregate definitions, registry order, and dispatch envelopes.
2. Move definition constants by family; keep aggregate exports byte/structure equivalent.
3. Move pure argument/result helpers and registry family handlers one family at a time.
4. Model job state transitions and singleton ownership before moving lifecycle code.
5. Extract job writer/tail, then launch/platform, then cleanup/status concerns.
6. Split file reads/listing from atomic mutations; characterize metadata and partial failures first.
7. Split shell analysis, foreground, background, package, and privilege paths in separate commits.
8. Migrate callers mechanically and reduce facades.
9. Remove each frozen oversized entry in the same commit that brings it to 1,000 lines or fewer; continue to `<500` for phase closure.

## Acceptance criteria

- [ ] Tool names, schemas, descriptions, aggregate order, MCP append order, and dispatch envelopes are unchanged.
- [ ] Exactly one registry, job store, process owner, and writer lifecycle exists.
- [ ] Job IDs/order/state/durability/tail and process-tree cleanup are unchanged.
- [ ] File ordering, bytes/newlines/modes/atomicity and shell result/exit/cancellation behavior are unchanged.
- [ ] Scoped ordinary files and new modules are `<500` and changed functions meet all Phase 0 complexity/type ratchets.
- [ ] Legacy entries for `definitions.ts`, `registry.ts`, `jobs.ts`, `fs.ts`, and `shell.ts` are removed without additions.
- [ ] Scoped mutation has zero survivors/no-coverage mutants; dead/duplicate reports do not regress.
- [ ] Targeted, security, architecture, canonical full-suite, build, and platform-relevant checks pass.

## Validation

The `test:deterministic` and `quality:*` scripts below are Phase 0 deliverables and must exist before this phase begins; use the final names recorded by Phase 0.

After each family/lifecycle seam:

```sh
npm run typecheck
npx vitest run test/tools test/registry.test.ts test/tool-normalize.test.ts --reporter=dot
npm run test:arch -- --reporter=dot
npm run quality:changed
```

At phase close:

```sh
npm run typecheck
npm run embed-prompts:check
npm run test:arch -- --reporter=dot
npx vitest run test/tools test/security --reporter=dot
npx vitest run test/jobs-durable.test.ts test/jobs-resource-hygiene.test.ts test/jobs-session-scope.test.ts test/process-tree.test.ts --reporter=dot
npx vitest run test/fs-append.test.ts test/fs-edit-delete.test.ts test/fs-read-directory.test.ts test/fs-read-smart.test.ts test/fs-write-many.test.ts --reporter=dot
npx vitest run test/shell-bounded.test.ts test/shell-interactive.test.ts test/shell-launch-retry.test.ts test/shell-no-match-exit.test.ts --reporter=dot
npm run test:deterministic -- --reporter=dot
npm run build
npm run quality:ratchet
npm run quality:mutation -- --scope tools-core
# Run on a supported POSIX host
npm run test:classic:pty
git diff --check
```

Cross-platform process and privilege jobs remain required evidence; a Linux-only pass cannot close those contracts.

## Commit and rollback plan

Use one family or lifecycle concern per commit. Keep aggregate facades and the existing singleton composition point until all callers migrate. If schema/order, job identity, process ownership, output order, or atomic-write metadata changes, revert the smallest seam immediately. Do not “repair” equivalence with a second registry/store or broader mock.
