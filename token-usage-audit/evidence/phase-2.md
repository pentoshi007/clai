# P2 — Strict-prefix profiling and retain-baseline decision

Status: TE-011–TE-015 verified as a measured no-op. No runtime context, prompt, schema, ordering or history change; incremental startup/task token savings are **zero**. Phase delivery receipt follows in P3.

## Previous delivery receipt

P1 `1f9ad72d756adad690fd5c832724422030c9eff2` was pushed to `origin/audit/token-efficiency-roadmap`; `git ls-remote` returned the identical ref and clean tracking status was observed.

## Hypothesis and measurement

Additional repeated-state suppression or local memoization might save future context/assembly work. Inspected actual `composeTurnMessages`/`dropSectionsAlreadyInHistory`, keyed/session/plan upserts, complete plan rendering, result deduplication, tool selection and stable prompt derivation. The starting implementation already suppresses exact repeats; historical content must not be rewritten.

`scripts/profile-token-context.ts` exercises the production functions with private HOME/config/data roots, a 60-task plan containing all criteria/dependencies, 20 warmups and 1,000 timed samples. Command: import `profileTokenContext` with `node --import tsx --input-type=module`, emit its JSON under session scratch. Observed Node 24.20.0, Linux arm64; raw small report `p2-profile.json` in session scratch. These are local microbenchmarks, not provider token/latency measurements.

| Operation | p50 ms | p95 ms |
| --- | ---: | ---: |
| Existing keyed/session/plan upserts | 0.00120 | 0.00160 |
| Existing section filtering | 0.00092 | 0.00148 |
| Full stable native prompt rendering | 0.12972 | 0.35656 |
| Ordered route tool selection | 0.03004 | 0.04372 |
| Complete 60-task plan rendering | 0.03096 | 0.06176 |

- Repeating identical authoritative state added **0 messages / 0 bytes**. No new suppression can claim those existing savings.
- Changed scope, clear, then re-add appended exactly **3** messages, leaving every prior message byte-identical. A negative control proves global “seen these bytes before” suppression would lose the re-added live authority.
- Existing section filtering removed the already-represented project block while retaining MCP/orchestration availability and the current outcome. Those retained blocks are intentional current authority, not permission to suppress them using unrelated substring identity.
- Complete plan output retained 60 tasks and 13,120 bytes. Dropping criteria/dependencies or old history to reduce it is rejected.
- Measured full native prompt: 38,016 bytes; existing vision+MCP route selects 45 tools. Its ordered digest is `5ae8343fac23cfff9d8beb8c65f2c7e1c45c80a46ce8bfe04d4b0c805512eb77`; the complete canonical catalog still has its unchanged 47-tool P0 digest `02631147c616726c7fb421b355e359a09828eb56190036e282073db641b3c6c7`. The initial profiler assertion confused the selected route with the canonical superset; correcting that test did not change either catalog.

## Decisions and proof

- **TE-012: reject additional suppression.** No redundant no-change emission was found in these paths; changing changed-state/re-add semantics would weaken authority. No historical deletion, summary or model-visible byte change is implemented.
- **TE-013: reject new memoization.** The measured operations are sub-millisecond and adding a cache saves zero provider tokens. Mutable config/reliability/tool/vision/project/skill/plan inputs require complete keys and defensive copies; extra retention/invalidation is not justified by this profile. No new cache, disk read, hot-path allocation or performance regression is introduced.
- **TE-014: retain existing batching.** Per-entry missing-file/success/Unicode/range/cursor and dependency-safe independent-read concurrency checks pass. P1 actual natural receipts cover two independent reads, one multi-file partial-failure request, background wait, persistent ready/probe/stop and Responder ownership. No universal dispatcher or fewer verification steps are introduced.
- Final focused command: strict profiler/state/64-assembly locks, context trimming, system/prompt/session-state, token overhead, multi-file read/concurrency, natural fixture verifiers and compaction fidelity: **12 files / 140 tests passed**, exit 0. Audit-script typecheck passed. No unit timing threshold is used to disguise noisy performance claims.
- No new live A/B is warranted for unchanged runtime bytes. Existing P1 baselines and failures remain applicable; P6 still owns broader rollout gates. A no-op cannot establish new cache benefits and none are claimed.

Rollback/cleanup: only reusable offline profiler, tests and evidence are added. No runtime flag, cache or alternate execution path needs rollback. Continue into durable compatibility work; do not treat this phase as completion of the full program.
