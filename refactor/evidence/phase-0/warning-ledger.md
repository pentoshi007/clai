# Baseline warning ledger

Every non-failing message emitted by the canonical suite at the refactor anchor
(Phase 0, P0-08), classified so a new warning is visible instead of lost in
familiar noise.

Anchor: branch `refactor/codebase`, canonical command
`npm run test:deterministic -- --reporter=dot`
(`LC_ALL=C LANG=C LC_COLLATE=C LC_NUMERIC=C LC_TIME=C TZ=UTC`).
Result at the anchor: 557 files passed, 5,695 tests passed, 12 skipped.

Classification:

- **contract** — expected behavior with an assertion that proves it;
- **environment** — depends on a documented host prerequisite;
- **debt** — actionable, with owner phase and removal condition.

## W-01 · OS keychain unavailable → plaintext fallback

- **Class:** environment
- **Message:** `clai: OS keychain unavailable (…); using restricted-permission
  plaintext file at <path>/keys.json`
- **Emitted by:** `src/store/keys.ts` (surfaced via `src/commands/providers.ts`,
  `src/commands/search-providers.ts`)
- **Prerequisite:** a reachable OS keyring. Absent on headless Linux CI and in
  this audit VM (`Secret Service: no result found`).
- **Expected in:** any environment without a keyring; every hosted CI job here.
- **Action:** none. The fallback path is deliberate and writes with restricted
  permissions. macOS/Windows keychain behavior is a **target-host release gate**
  and is not claimed from Linux evidence.
- **Removal condition:** never — this is a supported degraded mode.

## W-02 · Provider declares temperature not modifiable

- **Class:** contract
- **Message:** `Warning: <provider> declares temperature is not modifiable for
  <model>; the requested value was dropped.`
- **Emitted by:** `src/llm/request-plan.ts`
- **Why it is correct:** the provider profile marks sampling as fixed for that
  model, so the request omits the value rather than sending a rejected field.
- **Assertion:** covered by request-plan/profile tests that assert the parameter
  is dropped from the outgoing request. Phase 2 (P2-01) freezes this in the wire
  contract snapshots.
- **Action:** keep. Phase 2 must not change the message text or the omission.
- **Removal condition:** never while any provider profile declares fixed
  sampling.

## W-03 · Nested `vi.mock` hoisting warning

- **Class:** debt
- **Message:** `Warning: A vi.mock("…") call in
  "test/context/request-accounting.test.ts" is not at the top level of the
  module. … This will become an error in a future version.`
- **Occurrences (3):** `../../src/llm/router.js`, `../../src/tools/registry.js`,
  `../../src/commands/providers.js`
- **Impact:** none today; the mocks are hoisted and applied. It becomes a hard
  error in a future Vitest release, which would break the suite on a routine
  dependency bump.
- **Owner phase:** Phase 2 (P2-01) — the same phase that rewrites this file's
  router/registry characterization.
- **Removal condition:** the three `vi.mock` calls are moved to module top level
  and the suite runs warning-free.
- **Constraint:** moving them is a test-only change and must not alter the
  assertions.

## W-04 · Skipped tests (12)

- **Class:** environment
- **Sources:**
  - `test/interactive-session/platform.integration.test.ts` — skipped when the
    platform is unsupported or `python3` is unavailable;
  - `test/interactive-session/bun-pty-resize.test.ts` — POSIX-only;
  - `test/process-tree.test.ts` — skipped on Windows;
  - `test/classic/input/windows-fixtures.test.ts` — skipped for fixtures without
    a recorded capture;
  - `test/conformance/provider-conformance.test.ts` — skipped per unsupported
    provider capability, with the reason in the test title.
- **Action:** keep. Each skip states its reason and is covered by a
  platform-specific CI job.
- **Removal condition:** none. A skip that loses its guard must fail review;
  Phase 8 (P8-07) requires the matching platform job to actually run rather than
  accepting the skip as coverage.

## W-05 · Analyzer output noise (tooling, not product)

- **Class:** environment
- **Detail:** `jscpd` prints promotional footer lines; Stryker downgrades its
  `progress` reporter to `progress-append-only` on a non-TTY console.
- **Action:** none. Machine-readable JSON reports are the reviewed artifact; the
  console text is incidental.
- **Removal condition:** none.

## Rules

1. A new warning class that is not in this ledger is a review blocker.
2. A `contract` warning without an assertion is `debt`, not `contract`.
3. An `environment` warning must name its prerequisite and the platform that
   does exercise the path.
4. A crashed, timed-out or skipped **analyzer** is never a warning — it is a
   failure (see [quality-metrics.md](../../quality-metrics.md#comparison-rules)).
