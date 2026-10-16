# P1 — Falsifiable evaluation gates

Status: in progress (TE-005–TE-010); no runtime optimization or live-model pass claimed.

## Previous delivery receipt

P0 commit `fe80e61101e72ab626e86a18c3d037c3f68b6601` was pushed to `origin/audit/token-efficiency-roadmap`; `git ls-remote` returned the identical commit and the worktree was clean. The TE-004 completion receipt is carried in this phase's ledger update.

## Hypothesis and risks

The old background verifier accepts a bare answer containing `42`, and mutable visible tests can conceal incorrect implementations. Independent hidden assertions plus actual tool/job receipts should reject false successes without prescribing tools in natural prompts. Attempt-aware metrics and explicit route/budget configuration should prevent failed requests, unknown cache data and unverified performance from silently passing.

Keep instrumentation in offline/explicit evaluation processes, reuse existing provider adapters, isolate configuration and synthetic workspaces, and commit only redacted counts/digests. Expected startup savings in P1: zero. Do not change application prompts, tools or provider transport to make a fixture pass.

## Live prerequisites

The presence-only check found none of `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY` or `NVIDIA_API_KEY` set in the evaluation environment. Stored/keychain credentials were not read. No deployment route/model or paid-call budget has been selected. Live trials and cache/latency conclusions remain unrun; these gaps do not excuse skipping available offline checks.

## Results

Verified partial checkpoint (not P1 delivery):

- Refactored the implicit NVIDIA-only, stored-key/raw-capture evaluator into explicit configuration, isolated counterbalanced trials and an admission budget guard. It reuses the selected checkout's runner/provider adapters; no application transport, prompt or schema changed. Only NVIDIA/OpenAI/Anthropic/Gemini collector routes are currently implemented; other collector paths fail validation. No route is live-validated.
- Added six natural fixture counterparts and question-after-build; independent inline assertions and immutable package/non-target files reject weakened visible tests or hardcoded fixes. Replaced the `/42/` verifier with actual launch/wait/owned terminal-state/output proof. A real process integration test passes; inspection showed `shell.wait` has no embedded background receipt, so its job state is captured separately instead of fabricating one.
- Collected complete observed attempt lifecycles (including failures/auxiliary usage), final-body fingerprints, tool errors/blocks, first-visible-token/task latency, CPU/RSS and explicit unknowns. Total model rounds, repair/first-attempt classification, full assembly overhead and warm eligible-prefix denominators are intentionally unknown. Unknown/incomplete data cannot accept a candidate.
- Added nine actual ephemeral loopback HTTP cases for S01/S02/S03/S05/S06 evidence primitives and negative controls: raw hidden/comment/header evidence, cookies/redirects, default credential stripping versus explicit forwarding, true error statuses/request counts, decoded gzip capture/digests and flawed versus patched endpoints. Servers close on completion. These do not prove model-level security reasoning.
- **22 focused files / 212 tests passed**, including unchanged legacy cache/schema/prompt tests and failed-attempt/HTTP tests. **16 conformance files / 788 tests passed, 2 existing skips**. The five new P1 files contain 23 tests (included in the focused result).
- App typecheck, strict harness typecheck, generated-prompt consistency and `git diff --check` pass. The original simplified measurement remains byte-identical; `src/`, dependency and packaged/runtime artifacts are untouched.
- CLI dry-run planned six trials, made zero requests and read no credentials. A controlled missing-environment-credential run exited 1 before any trial. A synthetic transport + actual-runner/filesystem integration verified collection/redaction; it is not a live model pass. No paid/provider requests were made.
- Fault controls caught fake background success, missing waits, mismatched job IDs, wrong code fixes, deleted/modified immutable files, question-time side effects, early prompt changes, description changes, catalog reorder, extra requests, missing evidence, budget exhaustion, unknown usage and incomplete cache gates. One failed control exposed that chat's leading system message is in the history field, not a top-level instructions field; the gate now checks the actual earliest serialized history boundary too. Readable-only testing initially hit the existing raw fallback for an all-hidden document; adding neutral visible content made the intended evidence-loss control meaningful without changing runtime.

## Reconciliation and next work

See [evaluation.md](../evaluation.md) and [bounded check record](p1-checkpoint.json). TE-005–TE-010 stay unchecked: the full natural C01–C10/S01–S10 matrix, all D03–D13 state/history/serializer transitions, supported additional collectors, reliable first-attempt/round/assembly attribution and matched live cache/performance baselines still need work. P2–P6 cannot be claimed or activated from this partial checkpoint.

Next implementation work is completing the remaining P1 offline matrix and attribution, then selecting actual supported live routes/settings and an explicit paid-call budget with environment credentials before running pilot trials. No runtime token savings are claimed. This coherent tested tooling checkpoint may be committed/pushed without labelling the phase complete; its remote receipt is recorded after verifying delivery.

## Checkpoint delivery receipt

Commit `5aed3ac762c38bb2fd45791bfff82c32c2535472` (`test(tokens): harden isolated evaluation checkpoint`) was pushed to `origin/audit/token-efficiency-roadmap`. `git ls-remote` returned that exact commit and clean tracking status was observed. This is a **partial tooling checkpoint**, not TE-010/P1 completion. The separate receipt update also corrects the P0 original-file count from 15 to 14; all original files were read, and no technical result changes.
