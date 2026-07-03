# UI v2 Phase 0 baseline

Date: 2026-07-03

## Scope

Completed the first Phase 0 implementation slice on branch `ui/v2-opentui` in
the sibling worktree `/Users/aniketpandey/Desktop/clai-v2`.

No v2 UI framework, OpenTUI dependency, or feature implementation was added in
this phase.

## Original worktree proof

Original worktree: `/Users/aniketpandey/Desktop/clai`

- Branch: `main`
- HEAD: `f401fd5cd0f564769108083129aed7ea2977af8a`
- Status before v2 worktree creation:

```text
 M .gitignore
 D debug-test.ts
 M src/agent/loop-guard.ts
 M src/agent/plan-tool.ts
 M src/agent/progress.ts
 M src/agent/runner.ts
 M src/agent/tool-call-parser.ts
 M src/prompts/index.ts
 M src/prompts/system.agent.md
 M src/safety/classifier.ts
 M src/tools/fs.ts
 M src/tools/registry.ts
 M src/tui/App.tsx
 M src/tui/render-lines.ts
 M src/ui/intro-card.ts
 M src/ui/plan-pane.ts
 M test/fs-write-many.test.ts
?? src/tui/components/PlanSidebar.tsx
```

The original worktree remained dirty with the same unrelated user changes after
the v2 worktree was created.

## V2 worktree

- Path: `/Users/aniketpandey/Desktop/clai-v2`
- Branch: `ui/v2-opentui`
- Base HEAD: `f401fd5cd0f564769108083129aed7ea2977af8a`
- Local Node: `v26.4.0`
- Local npm: `11.17.0`
- Local Bun: `1.3.14`
- OS: `Darwin 25.5.0 arm64`

## Implemented

- Added `src/store/paths.ts` as the single path resolver for data, history,
  plan, logs, artifacts, and jobs roots.
- Preserved `CLAI_CONFIG_DIR` behavior for config.
- Added injectable roots:
  - `CLAI_DATA_DIR`
  - `CLAI_HISTORY_DIR`
  - `CLAI_PLAN_DIR`
  - `CLAI_LOG_DIR`
  - `CLAI_ARTIFACT_DIR`
  - `CLAI_JOBS_DIR`
- Added a Vitest-safe fallback under the system temp directory when tests do
  not provide roots and `HOME` is not already a temp test home.
- Updated history, plan, logs, shell artifacts, pentest recon artifacts, and
  background jobs to use injected roots.
- Added `test/store-paths.test.ts` covering path injection for history, plan,
  logs, artifact cleanup, shell artifacts, and background job artifacts.
- Added `.github/workflows/ci.yml` with:
  - Node 20 typecheck and semantic test job.
  - Bun placeholder job for the future v2 path.

## Verification

Commands run in `/Users/aniketpandey/Desktop/clai-v2`:

```text
npm test -- test/store-paths.test.ts
1 file passed, 4 tests passed

npm test -- test/history-autosave.test.ts test/store-paths.test.ts
2 files passed, 8 tests passed

npm run typecheck
passed

npm test
97 files passed, 717 tests passed

npm run build
passed

git diff --check
passed
```

The first non-escalated `npm run build` attempt failed only because the managed
sandbox blocked writes to `../clai-v2/dist`. The same build passed after running
with the required filesystem permission.

## Roadmap status

- V2-000: complete.
- V2-001: complete.
- V2-002: complete for config/history/artifact/plan/log roots.
- V2-003: complete for current clean-environment baseline; full suite is green.
- V2-004: complete for current Node path and a Bun/v2 placeholder CI path.

Phase 0 gate status: passed locally.

## Next step

Start Phase 1 with V2-010 in the v2 worktree: add pinned Bun/OpenTUI/Solid
dependencies and build config only after reviewing exact package versions and
license/runtime impact.
