# P0 — Baseline and contract lock

Status: TE-001–TE-003 verified; TE-004 delivery pending commit/push. Implementation authorized by the owner on 2026-10-16.

## Baseline and hypothesis

- Implementation base: `e450cebf4b51749bdd6c4a0de00a86390cd04e58`; audit source base: `ada38924a499a568e69984b35f99b75c375ecb98`.
- `git diff ada38924 -- src scripts test package.json package-lock.json` is empty before implementation. Branch is `audit/token-efficiency-roadmap`, initially clean and tracking origin.
- Host: Linux arm64, Node 24.20.0, npm 11.19.0; Bun is installed. No dependencies changed.
- All 15 existing audit files were read. The stopped historical subagent has no report; no delegated evidence is used.
- Reproduced both supplied measurement utilities. Baseline measurement and all eight route records are identical. Canonical ordered catalog digest remains `02631147c616726c7fb421b355e359a09828eb56190036e282073db641b3c6c7`.

Hypothesis: current simplified fixtures omit material dynamic context. Controlled fixtures using the runner's section builder, message composer, accounting service and final serializer will expose that contribution without changing application behavior. Expected optimization benefit in P0: **zero**; its deliverable is reliable attribution and regression protection.

Risks: configuration leakage, nondeterministic environment/workspace/scope input, conflating serialized characters with provider tokens, or silently reducing selected tools. Keep fixtures synthetic, isolate storage, mock only environmental inputs, and assert component accounting, catalog order, immutable source artifacts and repeated-run equality. Never contact a provider in P0.

## Verification and delivery

- Added an offline `--assembled` measurement mode with 64 production-pipeline fixtures; no `src/`, prompt, schema, lockfile or dependency changes. Includes the runner's session-state refresh before final accounting/serialization. No hot-path hooks or telemetry.
- [Responsibility ledger](../contracts.md): all 31 source headings, section/paragraph spans and digests, exact renderer source, all 47 ordered canonical/wire tool contracts with parameter digests and flags. Existing test/scenario ownership is explicit; natural-model behavioral proof remains P1.
- Focused Vitest checks: **18 files / 199 tests passed**, including the original 108 tests, new 69 checks, existing request accounting and section-composition tests. Existing nested-`vi.mock` warnings in `request-accounting.test.ts` were observed; no tests were muted or changed.
- `npm run typecheck`, `tsc -p tsconfig.token-audit.json`, `npm run embed-prompts:check`, and `git diff --check`: passed. New harness/test files are included in their own strict typecheck because the app tsconfig excludes scripts/tests.
- The original measurement remains byte-identical. Two independent CLI invocations of the full-assembly fixtures produced byte-identical reports: SHA-256 `5888ddc14631b31371957cd4b1dcd53867e2808e2fbd83a11ebd9f1fda28dd34`. Counts/digests only are committed in [assembly-baseline.json](assembly-baseline.json).
- Development failures were diagnosed rather than snapshot-updated: first the absent new helper, then an incomplete scope-loader mock, then a non-pentest-classified synthetic prompt and the pre-existing read-only MCP subset (three controls, not seven). Fixtures now use the production classifier and preserve that subset; no runtime contracts were changed.

| Full native / no MCP / no image | Canonical estimated tokens | Final wire character estimate | Dynamic content chars |
| --- | ---: | ---: | ---: |
| Coding | 24,096 | 24,162 | 6,219 |
| Security | 24,930 | 25,001 | 8,940 |
| Read-only question | 22,918 | 22,967 | 2,350 |
| Plan | 27,856 | 27,946 | 18,578 |

These richer synthetic fixtures are not comparable one-to-one with the earlier minimal 22,374 fixture. They expose omitted context, not a regression or claimed savings. Startup/task savings in P0 are **zero**. Exact provider tokens, costs, cache hits, model quality and latency remain unknown. A build is not needed for offline-only additions; build/package gates remain P3/P6.

All fixture workspaces/config are isolated by the existing test setup; no server or remote request was started. Raw logs remain under the active session scratch. The commit and verified remote receipt will be recorded in the next phase evidence entry, as required by the implementer protocol.
