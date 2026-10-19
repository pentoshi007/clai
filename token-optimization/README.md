# clai Token-Usage Optimization — Audit & Reduction Plan

This folder is a **self-contained engineering package** for reducing the per-request
token cost of the `clai` agent **without breaking prompt caching, changing agent
behavior, or increasing tool-call errors**.

It was produced from a direct, measured audit of the current `main` tree (see
[`01-audit.md`](./01-audit.md) for the raw numbers and how they were measured).

## TL;DR of the problem

On the **first agent-mode turn** the model already receives **~21,988 estimated
tokens** of fixed overhead before the user's task does anything useful:

| Component | Chars | Est. tokens | Share |
|---|---:|---:|---:|
| Stable system prompt (`message[0]`) | 37,740 | **11,437** | 52% |
| Native tool-schema payload (`tools` field) | 34,820 | **10,552** | 48% |
| **Total fixed prefix** | 72,560 | **21,988** | 100% |

*(Measured on route `nvidia / openai/gpt-oss-20b`, native tools, no MCP, no vision,
default `slimNativePrompt=true`. Estimator = `ceil(chars / 3.3)`, the repo's own
estimator. This is why `/context` shows ~17k–23k before the user does anything.)*

The repo's own guard `test/token-overhead.test.ts` asserts this prefix is
`< 22,000` tokens — we are **sitting at 21,988, i.e. 12 tokens under the ceiling.**

## The goal

- **North star:** roughly halve the fixed prefix.
- **Hard floor (non-negotiable):** every change must be **cache-safe, behavior-neutral,
  and tool-error-neutral**. Token savings are *never* a reason to break those.
- **Realistic honest commitment:** the fully-safe, no-quality-loss reductions in this
  plan target **~15,000–17,500 tokens** combined (a **20–32% cut**). Getting closer to
  "half" (~11k) is pursued **only** in the optional, A/B-gated phases and **only if the
  live evaluation harness proves no regression**. We do **not** promise 50% at the cost
  of quality — the user explicitly forbade that, and so does this plan.

## How to read this folder (in order)

1. **[`01-audit.md`](./01-audit.md)** — Where every token comes from. Measured
   breakdowns of the system prompt (per section) and the tool schema (per tool),
   root-cause analysis, and the exact commands to reproduce the numbers.
2. **[`02-invariants.md`](./02-invariants.md)** — The **safety contract**. The precise
   list of things that must stay stable (cache prefix, behavior, tool errors), *why*,
   and the one mental model that makes every optimization provably safe. **Read this
   before touching anything.**
3. **[`03-roadmap.md`](./03-roadmap.md)** — The phased reduction strategy. For each
   phase: what to change, which exact files/functions, expected savings, the downstream
   edits required to avoid residue, and the pass/fail gate.
4. **[`tasks.md`](./tasks.md)** — The **executable checklist**. This is what the
   implementing agent works through, phase by phase, checking boxes and pushing after
   each phase.

## Operating protocol for the implementing agent

> **You (the implementing agent) MUST follow this loop. Do not freelance.**

1. **Work one phase at a time, in order.** Phases are ordered by safety and dependency.
   Do not start Phase N+1 until Phase N is merged-ready (all its tasks checked and its
   gate green).
2. **Before every change**, re-read [`02-invariants.md`](./02-invariants.md). Each task
   in [`tasks.md`](./tasks.md) names the invariants it touches.
3. **Make the smallest change the task describes.** Do not opportunistically refactor,
   rename, or "improve" unrelated code. This is a surgical, token-only effort.
4. **Run the gate after every task** (see the gate definition in
   [`03-roadmap.md`](./03-roadmap.md) §"The regression gate"). The gate is:
   - `npm run typecheck`
   - `npm run embed-prompts:check` (if you touched any `src/prompts/*.md`)
   - `npm run test:deterministic -- test/token-overhead.test.ts test/context` (and any
     other test the task names)
   - The **offline measurement** showing the prefix got smaller (command in the audit).
   - Where NVIDIA credentials are available, the **online A/B harness**
     `scripts/evaluate-token-overhead.ts` showing **no** increase in tool calls, rounds,
     tool errors, or blocked calls, and a **stable** system/tools prefix hash.
5. **Mark the task done** in [`tasks.md`](./tasks.md): change its `- [ ]` to `- [x]`,
   fill in the "Result" line with the measured before/after token numbers, and record
   any residue you cleaned up.
6. **Commit and push after each completed phase** (not each task) with a Conventional
   Commit message, e.g. `perf(prompt): compress BACKGROUND/LONG-RUNNING section (-620 tok)`.
   Keep generated artifacts (`src/prompts/embedded.ts`) in the same commit as their source.
7. **Update the SHA locks and the `< 22_000` ceiling intentionally** whenever a task
   changes a hashed/locked artifact — see each task's "Downstream / no residue" list.
   Never "make the test pass" by weakening an assertion beyond what the task authorizes;
   ratchet the ceiling **down** to lock in the win.
8. If a task's gate **fails** (regression in behavior, tool errors, or a broken prefix),
   **revert that task** and record why in [`tasks.md`](./tasks.md). A phase that cannot
   pass its gate is reported as blocked, not forced through.

## Non-goals (explicitly out of scope)

- Removing `http.fetch` (it is kept deliberately — see [`01-audit.md`](./01-audit.md)
  §"Tools we keep and why").
- Any change that makes the stable prefix vary **turn-to-turn within a session**.
- Conditionally dropping the `subagent.*` tools when orchestration is off (this would
  break the cache prefix the instant a user runs `/orchestrator on` mid-session — see
  [`02-invariants.md`](./02-invariants.md) §"Why we do NOT conditionally remove tools").
- Merging tools whose failure modes differ (`fs.edit` / `fs.replaceLines` / `fs.append`).
- Reducing quality, coverage, or security capability to save tokens.
