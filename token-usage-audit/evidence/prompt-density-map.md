# Prompt-density obligation ownership

`density-v1` changes only three full-agent sections. It keeps all native/text guidance, tool definitions and names, security methodology, query/directive boundaries, instruction authority, confirmations, scope, continuation and task lifecycle outside those sections byte-identical. Compact rendering is unchanged. There is no per-task/domain switch.

Source: `src/prompts/system.agent.md`. Candidate: `src/prompts/candidate-density-sections.md`; generated counterpart: `candidate-density-embedded.ts`. The numbered ownership below follows the original section's bullet/step order, not line numbers.

| Original responsibility | Candidate owner | Deterministic assertion / behavioral scenario |
| --- | --- | --- |
| Building 1: destination, absolute paths, project root, agent-tree exclusion | Building bullet 1 | `build-1`; C05 |
| Building 2: targeted discovery, lockfile package manager, sensible empty-project default | Building bullet 1 | `build-2`; C02/C05/C06 |
| Building 3: existing project, empty subfolder scaffolding, cancellation, no temp-tree merge, fallback | Building bullet 2 | `build-3`; C05 |
| Building 4–5: actual feature, starter removal, explicit/implicit and empty/duplicate/error/reload criteria | Building bullet 3 | `build-4-5`; C01/C05 |
| Building 6–8: inspect complete contracts, whole writes, checks then runtime, truthful passes | Building bullets 1/3/4 | `build-6-8`; C01/C02/C03 |
| Building 9–10: secure inputs/SQL/secrets/endpoints, real root, known dependencies/versions | Building bullets 1/3 | `build-9-10`; C02/S08 |
| Building 11: tracked tasks/server, readiness, leave running, report URL/job, no port thrashing, CLI exception | Building bullet 4 | `build-11`; C07 |
| Building 12: remote-target evidence, no local pentest substitute, no reopening completed work | Building bullet 4 | `build-12`; S06/C09 |
| Style introduction: project/user overrides, working code over metric chasing | Style introduction | `style-intro`; C02 |
| Style 1–2: small functions, complexity/nesting ceilings, genuine extraction, no dead logic/mutants | Style bullet 1 | `style-1-2`; C01/C02 |
| Style 3: why-only comments, names instead of narration, no stale/commented-out code | Style bullet 2 | `style-3`; C02 |
| Style 4: precise types, no any/cast laundering, immediate edge narrowing | Style bullet 3 | `style-4`; C02/S08 |
| Style 5–8: delete branches, early returns, named conditions, no dead abstraction/type-impossible guards, match file | Style bullets 1/3 | `style-5-8`; C01/C02 |
| Debug 1–4: reproduce, localize, hypothesize, inspect cause | Debug sequence | `debug-1-4`; C01/C03/C10 |
| Debug 5–7: minimal root cause, original failure, fail-before/pass-after regression, nearby checks, change approach | Debug sequence | `debug-5-7`; C01/C03/C10/S08 |
| Debug final: apply known correction, reject symptom suppression, check environment before app rewrite | Debug final sentences | `debug-final`; C01/C10 |

`test/context/token-density-profile.test.ts` asserts each mapped phrase, detects intentional deletion for every ownership entry, and verifies all untouched section bytes/order. `token-assembly-baseline.test.ts` independently compares all 64 assembled routes: identical tools, history, dynamic context, project rules, skills, scope and plan; no extra mode-guidance insertion; only the selected full core changes. `token-evaluation-trial.test.ts` verifies actual runner selection and profile/digest provenance with a mocked transport, not a model-quality pass.

These assertions catch structural/obligation omissions. They cannot prove equivalent model interpretation. Live quality, first-attempt reliability, latency and comparable warm-cache evidence remain mandatory; the candidate is not a released default.
