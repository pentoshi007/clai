# Phase 4 — Persistence and durable state

Status: **planned**
Depends on: Phase 3 complete
Primary hotspots: `src/store/history.ts` (1,931 lines), `src/store/plan.ts` (1,187 lines)

## Objective

Separate durable state by domain, codec, backend, recovery, retention, redaction, and atomic-write responsibility while preserving every on-disk format, migration, permission, ordering, and recovery behavior. Reduce type uncertainty at decode boundaries without casting untrusted persisted data into domain types.

## Scope

In scope:

- `src/store/history.ts`, `src/store/plan.ts`;
- high-line/type-debt stores such as `src/store/keys.ts`, `config.ts`, and `scope.ts`;
- narrowly shared store paths, codecs, locking, permission, atomic-write, retention, scrub, and recovery helpers;
- existing JSONL and SQLite history paths and their indexes/migrations;
- tests under `test/store` and root history/plan/config/key/scope/session/retention suites.

Out of scope:

- changing storage locations, formats, schemas, retention defaults, encryption/keychain policy, or migration outcomes;
- destructive data migration or cleanup outside temporary test roots;
- renderer history UI (Phase 6);
- session-runtime process decomposition;
- broad generic repository abstractions that erase domain invariants.

## Protected contracts

Preserve:

- OS-specific config/data/cache paths and project/session scoping;
- JSON/JSONL/SQLite bytes and fields, schema versions, ordering, IDs, timestamps, and omission/default behavior;
- append, save, autosave, compaction, index, read, purge, clear, and retention semantics;
- single-active plan, task dependency/order/status, revisions, transactions, resilience, and session-plan linkage;
- config precedence/defaults/unknown-key behavior/cache invalidation;
- multi-key ordering, active/disabled state, masking, keychain fallback, and restrictive file modes;
- scope authorization/exclusion/phases/expiry/rate/concurrency persistence and session isolation;
- atomic replacement, fsync/rename behavior where implemented, lock/transaction boundaries, and write amplification bounds;
- corrupt/truncated/legacy record recovery, partial reads, error messages, and non-destructive fallback;
- redaction/scrubbing before data reaches disk, indexes, logs, caches, or artifacts;
- retention cutoff and deletion ordering;
- no change to user data during tests outside isolated temporary roots.

## Required characterization

Run and strengthen:

```sh
npx vitest run \
  test/store \
  test/history-safety.test.ts \
  test/history-autosave.test.ts \
  test/history-compaction-quit.test.ts \
  test/history-index.test.ts \
  test/history-purge-session.test.ts \
  test/history-redaction-cache.test.ts \
  test/history-write-amplification.test.ts \
  test/plan-store.test.ts \
  test/plan-jsonl-resilience.test.ts \
  test/plan-transactional.test.ts \
  test/plan-single-active.test.ts \
  test/plan-revision-replace.test.ts \
  test/config.test.ts \
  test/config-cache.test.ts \
  test/keys-messaging.test.ts \
  test/scope-store.test.ts \
  test/engagement-store.test.ts \
  test/scope-session-isolation.test.ts \
  test/retention.test.ts \
  test/store-paths.test.ts \
  --reporter=dot
```

Add golden fixtures for every supported legacy/current record version, corruption boundary, recovery result, file mode, redaction path, transaction rollback, and retention boundary. Golden data is behavior-bearing; review fixture changes manually.

## Intended module boundaries

### History

Separate:

1. domain records and validated codecs;
2. JSONL reader/writer and truncation recovery;
3. SQLite backend/index/query/migration behavior;
4. backend selection/composition;
5. session index/model mapping;
6. scrub/redaction;
7. retention/purge;
8. stable history facade.

### Plans

Separate plan/task domain mapping and normalization from record codecs, transactional writes, session association, revision/replacement, and read/recovery. Keep single-active and dependency invariants in a domain service, not duplicated across backends.

### Config, keys, and scope

Create narrow stores/codecs for each domain. Decode raw JSON/environment/keychain data from `unknown`; reject or default exactly as before. Keep key masking and secret material out of diagnostics. Do not merge stores merely because they use JSON files.

### Shared primitives

Share path, permission, lock, and atomic-write helpers only after characterization proves identical semantics. Domain facades own policy; primitives own mechanics.

## Work sequence

1. Freeze record bytes, queries, errors, modes, and recovery outcomes with isolated fixtures.
2. Extract pure record codecs/validators without changing defaults or permissiveness.
3. Split JSONL mechanics, then SQLite mechanics, behind the current history facade.
4. Split indexes/session mapping, redaction, retention, and purge one concern at a time.
5. Split plan domain/codec/transaction/recovery/session concerns.
6. Split config/key/scope codecs and stores, preserving caches, precedence, and keychain behavior.
7. Consolidate only proven-identical atomic/path primitives in a separate cleanup commit.
8. Migrate callers mechanically, reduce facades below 500 lines, and remove legacy entries in the same qualifying commits.

## Acceptance criteria

- [ ] Existing and legacy fixtures round-trip or recover exactly as before.
- [ ] Paths, bytes/records, queries, order, IDs, defaults, errors, file modes, locks, atomicity, and retention are unchanged.
- [ ] Redaction occurs before every durable/index/cache sink.
- [ ] No unsafe persisted-data cast, explicit `any`, secret diagnostic, or broad suppression is introduced.
- [ ] History/plan facades and all changed ordinary files are `<500`; legacy entries are removed without additions.
- [ ] Changed functions meet complexity/Halstead/CRAP gates and scoped mutation has no survivors/no-coverage mutants.
- [ ] Store/history/plan/config/key/scope/session, architecture, canonical full-suite, and build checks pass.

## Validation

The `test:deterministic` and `quality:*` scripts below are Phase 0 deliverables and must exist before this phase begins; use the final names recorded by Phase 0.

After each backend/domain seam:

```sh
npm run typecheck
npx vitest run test/store test/plan-store.test.ts test/history-safety.test.ts --reporter=dot
npm run test:arch -- --reporter=dot
npm run quality:changed
```

At phase close:

```sh
npm run typecheck
npm run embed-prompts:check
npm run test:arch -- --reporter=dot
npx vitest run test/store --reporter=dot
npx vitest run test/history-safety.test.ts test/history-autosave.test.ts test/history-index.test.ts test/history-redaction-cache.test.ts test/history-write-amplification.test.ts --reporter=dot
npx vitest run test/plan-store.test.ts test/plan-jsonl-resilience.test.ts test/plan-transactional.test.ts test/plan-single-active.test.ts --reporter=dot
npx vitest run test/config.test.ts test/config-cache.test.ts test/scope-store.test.ts test/engagement-store.test.ts test/retention.test.ts --reporter=dot
npm run test:deterministic -- --reporter=dot
npm run build
npm run quality:ratchet
npm run quality:mutation -- --scope store
git diff --check
```

Run keychain/file-mode and OS-path checks on their supported hosts before closure.

## Commit and rollback plan

Use codec, backend, recovery, redaction, retention, and facade migrations as separate commits. Never combine a format migration with extraction. Preserve old facade entrypoints until callers migrate. If fixture bytes, modes, recovery, retention, or redaction ordering changes, revert the seam before proceeding; never rewrite user fixtures to match an unintended result.
