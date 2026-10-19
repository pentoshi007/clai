# tasks.md — Execution checklist

**How to use this file (implementing agent, read once):**

- Work **top to bottom, one phase at a time.** Finish and push a whole phase before
  starting the next.
- For each task: do the change → run **the gate** (see
  [`03-roadmap.md`](./03-roadmap.md) §"The regression gate") → if green, tick the box
  and fill the **Result** line with real before/after token numbers → move on.
- **After all tasks in a phase are ticked**, commit (Conventional Commit) and
  **`git push`** to this branch. Then start the next phase.
- If a task's gate fails, **revert that task's diff**, leave its box unticked, and write
  why on its Result line. Never weaken a test beyond what the task authorizes.
- Every task lists the **invariants** it touches — re-check them in
  [`02-invariants.md`](./02-invariants.md) before editing.
- Legend: `- [ ]` todo · `- [x]` done · `- [~]` attempted, reverted (explain in Result).

> **Progress discipline:** keep this file honest. It is the single source of truth for
> what has shipped. A ticked box with no measured Result number is not done.

---

## Phase 0 — Baseline & instrumentation  _(push when complete)_

- [ ] **0.1 Install & verify clean baseline.** Run `npm ci --ignore-scripts`. Run the
  gate steps 1–4 on the untouched tree; confirm all green.
  - Invariants: none (measure only).
  - **Result:** _typecheck ___ · token-overhead test ___ · embed-check ____
- [ ] **0.2 Record the before-picture.** Create the throwaway `scripts/_measure_now.ts`
  ([`01-audit.md`](./01-audit.md) §6), run it, paste the numbers here. Create the
  baseline worktree: `git worktree add /tmp/clai-baseline $(git merge-base HEAD origin/main)`.
  - **Result:** _systemTokens=11437 · schemaTokens=10552 · combined=21988 · tools=39
    (confirm or correct from your run)_
- [ ] **0.3 Confirm the A/B harness availability.** If NVIDIA creds exist, do a dry
  `node --import tsx scripts/evaluate-token-overhead.ts` on the unchanged tree to confirm
  it runs; else record "live A/B unavailable — offline gate only".
  - **Result:** _harness: available / unavailable_

**Phase 0 push:** commit only if you added helper docs; `_measure_now.ts` is throwaway —
do **not** commit it.

---

## Phase 1 — Tool-schema description compression  _(push when complete)_

Edit `description` strings only. **Keep every param name/type/enum/required flag (T2).**
Update the catalog SHA lock (R2) and ratchet the `< 22_000` ceiling down (R4) at the end.

- [ ] **1.1 `fs.read`** (`src/tools/definitions/fs-read.ts`) — compress
  `FS_READ_DESCRIPTION`; keep all param docs and the `files[]` block. Target 1,042→~650.
  - Invariants: T2, C2. · **Result:** _before ___ / after ___ tok_
- [ ] **1.2 `http.fetch`** (`src/tools/definitions/web-1.ts`) — keep raw-forensic framing
  + every param; cut prose that repeats `# WEB READING`. Target 815→~520.
  - Invariants: T2. · **Result:** _before ___ / after ___ tok_
- [ ] **1.3 `shell.*`** (`src/tools/definitions/shell.ts`) — compress `shell.exec`'s long
  paragraph (+ wait/tail/jobs/stop). Target 1,333→~900.
  - Invariants: T2. · **Result:** _before ___ / after ___ tok_
- [ ] **1.4 `subagent.*`** (`src/tools/definitions/subagents.ts`) — compress hard
  (esp. `subagent.start`, `subagent.read`); keep params + the read-only/no-delegate
  caveat. Target 1,464→~850.
  - Invariants: T2, C3 (keep them LISTED — compress only). · **Result:** _before ___ / after ___ tok_
- [ ] **1.5 `web.fetch`** (`src/tools/definitions/web-2.ts`) — trim prose duplicating
  `# WEB READING`; keep selectors. Target 524→~360.
  - Invariants: T2. · **Result:** _before ___ / after ___ tok_
- [ ] **1.6 `terminal.send` / `terminal.start`** (`src/tools/definitions/terminal.ts`) —
  squeeze prose; **keep every `control`/`secretSource`/`kind` enum value (T2).**
  Target 851→~620.
  - Invariants: T2. · **Result:** _before ___ / after ___ tok_
- [ ] **1.7 `plan.create` + `pdf.read` + `image.ocr`** (`aggregate.ts`, `context-2.ts`) —
  trim repeated phrasing, keep field lists/params. Target 1,257→~930.
  - Invariants: T2, R3 (do NOT change `planModeDirective()`). · **Result:** _before ___ / after ___ tok_
- [ ] **1.8 Shared `timeoutMs` description** (`src/tools/definitions/define.ts`) — shorten
  the one string injected into all 6 TIMED_TOOLS.
  - Invariants: T2. · **Result:** _×6 saving ___ tok_
- [ ] **1.9 Close out Phase 1.** Update catalog SHA lock in `test/token-overhead.test.ts`
  (R2); ratchet `< 22_000` → just above new combined (R4); run full gate.
  - **Result:** _combined before 21,988 / after ___ tok (−___). A/B: toolErrors Δ=___,
    toolCalls Δ=___, prefix stable=____

**Phase 1 push:** `perf(tools): compress tool-schema descriptions (-___ tok, params unchanged)`

---

## Phase 2 — System-prompt prose compression  _(push when complete)_

Edit `src/prompts/system.agent.md`. **After every task run `npm run embed-prompts` and
stage `src/prompts/embedded.ts` (R1).** Preserve every directive in
[`02-invariants.md`](./02-invariants.md) §2. **Gate each task with the live A/B harness
when available** — this phase changes behavior-shaping text.

- [ ] **2a `# HOW YOU THINK`** 3,203→~2,100. Fold the execution-method bullets; drop
  phrasing restated elsewhere; keep priority order, query-vs-directive, mid-task steering,
  proportionality, parallelism, honesty-over-haste.
  - Invariants: §2 behavior set, R1. · **Result:** _before ___ / after ___ tok · A/B: ____
- [ ] **2b `# BACKGROUND / LONG-RUNNING`** 1,792→~900. Keep decision rules; delete flag
  mechanics already in `shell.exec`/`shell.wait`/`job.read` schemas.
  - Invariants: §2, R1. · **Result:** _before ___ / after ___ tok · A/B: ____
- [ ] **2c `# BUILDING SOFTWARE`** 918→~620. Keep working-feature deliverable, verify
  ladder, no-re-scaffold, scratch rules.
  - Invariants: §2, R1. · **Result:** _before ___ / after ___ tok · A/B: ____
- [ ] **2d `# OPERATING RULES`** 1,078→~750. Deduplicate vs HOW YOU THINK; keep match-the-
  deliverable, high-signal-commands, parallel-reads.
  - Invariants: §2, R1. · **Result:** _before ___ / after ___ tok · A/B: ____
- [ ] **2e `# CODE STYLE`** 686→~450. Keep hard ceilings (complexity/line caps, no `any`,
  comments-earn-place); compress explanation.
  - Invariants: §2, R1. · **Result:** _before ___ / after ___ tok · A/B: ____
- [ ] **2f `# PLANNING`** 628→~480. Keep plan-vs-agent distinction + stop-after-plan.create.
  **Do not edit `planModeDirective()` (SHA-locked, R3).**
  - Invariants: §2, R1, R3. · **Result:** _before ___ / after ___ tok · A/B: ____
- [ ] **2g `# DEBUGGING & FIXING` + `# RESILIENT ERROR HANDLING`** 705→~500. Keep the
  repro→localize→hypothesize→fix→verify ladder + error-recovery rules.
  - Invariants: §2, R1. · **Result:** _before ___ / after ___ tok · A/B: ____
- [ ] **2h Close out Phase 2.** Confirm `test/token-overhead.test.ts` `toContain(...)`
  string checks still pass (update any intentionally reworded checked string); ratchet
  the ceiling down (R4); update `request-snapshots` snapshot if changed (R6); full gate.
  - **Result:** _system before 11,437 / after ___ tok (−___). A/B parity: ____

**Phase 2 push:** `perf(prompt): tighten system-prompt prose (-___ tok, directives preserved)`

---

## Phase 3 — Merge `fs.writeMany` into `fs.write`  _(push when complete)_

- [ ] **3.1 Schema.** `src/tools/definitions/files.ts`: add optional `files[]` to
  `fs.write` (mirror `fs-read.ts`); remove the `fs.writeMany` def.
  - Invariants: T2, T3, T5. · **Result:** _schema Δ ___ tok_
- [ ] **3.2 Handler.** `src/tools/registry.ts` + `src/tools/handlers/files-*.ts`: route
  `fs.write` with `files[]` through the existing multi-write logic; drop the standalone
  `fs.writeMany` handler key. Keep single-file behavior identical.
  - Invariants: T3. · **Result:** _handler updated: ____
- [ ] **3.3 Upgrade mapping (zero errors).** `src/tools/retired-tools.ts`: add
  `RETIRED_TOOL_UPGRADES["fs.writeMany"]` that rewrites to `fs.write` with the same
  `files`. Add a test that a `fs.writeMany` call still succeeds via the rewrite.
  - Invariants: T1. · **Result:** _rewrite verified: ____
- [ ] **3.4 Prose + ask-mode + locks.** Update `fs.writeMany` mentions in
  `src/prompts/system.agent.md` (`# FILE POLICY`) and `agentNativeToolsHeader`; re-embed
  (R1). Check `src/modes/ask.ts`. Update catalog SHA lock (R2) and
  `assertDefinitionRegistryConsistency`; update snapshots (R5).
  - Invariants: R1, R2, R5, T3. · **Result:** _all refs updated: ____
- [ ] **3.5 Close out.** Full gate incl. a multi-file `fs.write` call test and the
  `fs.writeMany`-rewrite test.
  - **Result:** _tools 39→38 · combined after ___ tok · A/B toolErrors Δ=____

**Phase 3 push:** `perf(tools): merge fs.writeMany into fs.write files[] (upgrade-mapped, -___ tok)`

---

## Phase 4 — Remove cross-duplication (prose ↔ schema)  _(push when complete)_

- [ ] **4.1 Search syntax** — keep the canonical copy in `# SHELL RESEARCH`; trim the
  duplicate ripgrep/grep prose elsewhere in `system.agent.md`. Re-embed (R1).
  - **Result:** _before ___ / after ___ tok_
- [ ] **4.2 Read-policy** — keep `fs.read` schema as canonical; trim `# FILE POLICY`
  overlap. Re-embed (R1).
  - **Result:** _before ___ / after ___ tok_
- [ ] **4.3 web vs http choice** — keep one short statement in `# WEB READING`; trim the
  two schemas' long "not for X" prose. Re-embed (R1) + SHA lock (R2) for schema change.
  - **Result:** _before ___ / after ___ tok_
- [ ] **4.4 Close out.** Claim-level diff (no rule lost); ratchet ceiling (R4); full gate.
  - **Result:** _combined after ___ tok · A/B parity: ____

**Phase 4 push:** `perf(prompt): dedupe prose already carried by tool schemas (-___ tok)`

---

## Phase 5 — OPTIONAL: compact prompt for proven-parity routes  _(push only if it ships)_

**Gate: only attempt with the live A/B harness. Ship per-model only on clean parity.**

- [ ] **5.1 Spike.** A/B the tightened slim prompt vs `compactAgentPromptNative` on all 6
  `scripts/token-overhead-fixtures.ts` fixtures, ABBA-repeated, for one strong model.
  - **Result:** _per-fixture: toolCalls Δ ___, rounds Δ ___, toolErrors Δ ___, passed ____
- [ ] **5.2 Promote (only if clean).** Make `useCompactSystemPrompt`/`slimNativePrompt`
  a pure function of provider/model (C3) with an env/config override; default-compact
  only the proven family. Leave others on the tightened slim prompt.
  - Invariants: C1–C4 (choice must be session-stable, keyed on model). · **Result:** _routes promoted: ____
- [ ] **5.3 Close out or abandon.** If parity is clean: update locks/ceiling (R2/R4),
  full gate, push. If not: revert, record the result, stop — Phases 1–4 stand on their own.
  - **Result:** _shipped? yes/no · reason: ____

**Phase 5 push (if shipped):** `perf(prompt): default <model-family> to compact prompt (A/B-verified parity, -___ tok)`

---

## Final reconciliation (before declaring the effort done)

- [ ] **F.1** Re-run the throwaway measure; record final `systemTokens`, `schemaTokens`,
  `combined`, `tools`. Delete `scripts/_measure_now.ts` (no residue). Remove the baseline
  worktree: `git worktree remove /tmp/clai-baseline`.
  - **Result:** _final combined ___ tok (was 21,988; −___%)_
- [ ] **F.2** Confirm all guards green: `npm run typecheck`,
  `npm run embed-prompts:check`, `npm run test:deterministic`, and (if available)
  a final `scripts/evaluate-token-overhead.ts` run showing lower `firstPromptTokens`
  with no behavior/tool-error regression and a stable prefix hash.
  - **Result:** _all green: ____
- [ ] **F.3** Confirm cache-prefix stability test (`prefixSha256` across budget/recovery/
  delivery) still green — the cache contract held throughout.
  - **Result:** _stable: ____
- [ ] **F.4** Update [`README.md`](./README.md) TL;DR table with the achieved numbers and
  open the PR / update it with the before→after summary.
  - **Result:** _PR: ____
