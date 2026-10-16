# Instructions for the implementing agent

## Scope and authority

This folder is an audit and implementation roadmap. Reading it does not itself authorize runtime changes: begin implementation when the owner directs you to implement the roadmap or a named phase. Preserve that boundary. The current audit delivery changed no runtime code.

Start with `README.md`, this file and `tasks.md`; then read the selected phase in `roadmap.md` and its linked design/validation sections. Read `cache-design.md` before any request/prompt/schema change and `tool-catalog.md` before tool work. Use `audit.md` for the relevant finding and evidence rather than reloading the whole folder every turn. Reconcile the current repository commit with the recorded baseline; do not assume line numbers, installed models or old measurements still apply. These files are an implementation reference, not content to inject into clai's runtime prompt or skill catalog.

The user's priorities, in order, are unchanged correctness/capability, cache-prefix continuity, first-attempt tool reliability, no performance regression, and then token savings. Half is an aspiration, not permission to damage anything. Smaller savings or a documented no-op are valid decisions.

## Hard implementation constraints

- Preserve both software-engineering and security workflows. Do not trade away evidence, validation, recovery, authorization or task-state behavior for a shorter prompt.
- No established-prefix edit: prompt bytes, tool descriptions/schemas/order and already-sent history are protected. A content hash or cache key cannot excuse changed bytes.
- New prompt/schema profiles need the separate owner approval described in `cache-design.md`. Until then, legacy remains the default and all candidates remain inactive. Never auto-enable a candidate after a context-limit/config change.
- No universal tool dispatcher, dynamic core-tool pruning, forced text protocol, or shell-only replacement. Retain `http.fetch` and the complete accepted capability inventory.
- No lower model, reasoning/output budget, smaller evidence cap, skipped check, truncated user instruction or weakened test to manufacture savings.
- Match current repository versions and conventions. No unrelated dependency upgrades. New code has precise types, small cohesive functions and no code comments, consistent with project rules. Keep new files under 400–600 lines; split by responsibility rather than padding a large framework.
- Instrumentation is offline or opt-in and redacted. Do not add model-visible diagnostics, default telemetry uploads, secret-bearing captures, synchronous per-turn file reads, or unbounded caches.
- Keep generated prompt artifacts synchronized. Treat retained legacy compatibility content as intentional, explicitly referenced code—not as deletion fodder.

## Working loop

1. Open the earliest ready task in `tasks.md`. Check its dependencies, profile lane and approval state.
2. Inspect current types, callers, schema enrichment, validators, state/persistence and relevant tests before editing. Use symbols/paths from the roadmap as entry points, not permission for a broad rewrite.
3. Record a falsifiable hypothesis, expected full-request/task benefit and regression risks in a phase evidence note.
4. Add a regression test or negative control that would catch the relevant failure. Confirm it can fail for the intended defect.
5. Make the smallest coherent change. Attribute prompt and schema experiments separately before combining them.
6. Run focused checks, independent outcome assertions and applicable broader/live gates. Inspect failures; do not update snapshots blindly, mute tests or rerun until a flaky candidate happens to pass.
7. Remove superseded candidate paths, stale references, dead flags/exports and duplicate test logic. Search old names and classify every intentionally retained compatibility path.
8. Update the task ledger only after reading the evidence. Record blocked/failed/rejected decisions explicitly. A command launch or character-count reduction is not completion.

## Updating tasks.md

Use `[ ]` for unfinished tasks and `[x]` only for satisfied acceptance criteria. Keep phase headings and IDs stable. Annotate in-progress/blocked work beneath its task; do not erase completed history or silently renumber dependencies.

A task record needs: status, concise result/decision, source/test references, measured before/after where relevant, evidence location and residual gaps. For a rejected candidate, mark the evaluation task done only when rejection and baseline retention are documented; do not mark release/activation done.

At each phase boundary update the phase table and its delivery task. Technical work may be verified while pushing is blocked; state those separately. Tasks whose gate was never approved stay blocked, not checked as if implemented.

If new evidence adds required work, append a clearly named task with dependencies and acceptance criteria in the correct phase. Preserve completed tasks. Do not broaden a phase-specific user request or stop between phases when the user explicitly requested the complete authorized roadmap.

## Phase-by-phase commit and push protocol

Work on `audit/token-efficiency-roadmap` or an owner-approved implementation branch based on it. Never push directly to `main` as part of this roadmap.

For each phase:

1. Inspect `git status --short` and the branch. Preserve unrelated user changes.
2. Finish the phase's gates and cleanup, update `tasks.md` and add a compact sanitized phase evidence report under `token-usage-audit/evidence/`. Keep bulky/raw logs in session scratch or an approved artifact store.
3. Run `git diff --check` and inspect the exact source/generated/documentation diff. Confirm no secrets, accidental ignored files or unrelated edits are staged.
4. Stage only explicit phase paths, then commit with a specific message such as `test(tokens): establish provider-wire baseline` or `perf(context): avoid redundant new state notices`.
5. Verify the commit and push the current branch using `git push -u origin <current-branch>` for the first push, then the normal branch push. Inspect configured remotes before pushing. Use no force push, history rewrite or automatic conflict resolution.
6. Read the push result and verify the remote branch points to the intended commit before reporting it pushed. If access, upstream or network blocks delivery, record the exact blocker; keep the local commit and never claim remote success. Do not bypass a denial or embed credentials in a command.
7. Record the phase commit/push receipt in the next phase evidence entry or final delivery report. Do not create an infinite chain of amendments merely to put a commit's own hash inside itself.

Do not bundle several unverified phases into one end-of-roadmap commit. Do not commit failing runtime work as a completed phase. Independent local work may continue after a non-destructive push failure only if the user permits it and its status remains explicit.

## Final reconciliation

Before saying implemented/released:

- Compare every requested outcome with `tasks.md`, phase evidence and any approved scope changes.
- Prove legacy wire equality and restart/upgrade compatibility; separate new-profile cold starts from regressions.
- Report per-route initial/full-task token reductions and exact-versus-estimated provenance.
- Report coding/security quality, first-attempt errors, model/tool rounds, latency and cache observations, including failures and unknowns.
- Confirm all required tests/jobs are complete and owned fixtures are cleaned up.
- Confirm build/package output contains the intended profiles and no stale generated artifacts.
- Confirm the expected phase commits and remote refs, or explicitly report push blockers.
- State release/retain-baseline/blocked and remaining coverage; never conceal a shortfall behind “optimized.”

If evidence cannot establish a safe reduction, stop the candidate, retain the working baseline and explain the limiting constraint. That is correct execution of this plan.
