# 03 — Reduction Roadmap

This is the phased strategy. Phases are ordered **safest-first**. Do them in order;
push after each phase. The concrete checklist is in [`tasks.md`](./tasks.md); this file
explains the *what* and *why* behind each task so the implementer makes correct calls.

## Targets

| Milestone | System prompt | Tool schema | Combined | vs today |
|---|---:|---:|---:|---:|
| **Today (measured)** | 11,437 | 10,552 | **21,988** | — |
| After Phase 1 (schema prose) | 11,437 | ~7,800 | **~19,200** | −13% |
| After Phase 2 (system prose) | ~8,700 | ~7,800 | **~16,500** | −25% |
| After Phase 3 (fs merge) | ~8,700 | ~7,650 | **~16,350** | −26% |
| After Phase 4 (cross-dup) | ~8,100 | ~7,650 | **~15,750** | **−28%** |
| After Phase 5 (optional, A/B-gated) | ~6,000 | ~7,650 | **~13,650** | **−38%** |

These are **planning estimates**, not promises. The **commitment** is: land every token
that passes the gate, in order, and stop any task that regresses behavior or tool errors.
A −28% safe cut is the expected floor; the ~−38% stretch depends on Phase 5 proving
parity on the live harness. "Half" (~11k) is the north star, reached only if Phase 5
plus deeper Phase 2 compression both prove behavior-neutral — we do not force it.

---

## The regression gate (run after EVERY task)

A task is complete only when this passes. (Full rationale in
[`02-invariants.md`](./02-invariants.md) §5.)

```sh
# 1. Types
npm run typecheck

# 2. Prompt embedding is in sync (only if you touched src/prompts/*.md)
npm run embed-prompts:check

# 3. The token + context contracts (update SHA locks / ceiling intentionally)
npm run test:deterministic -- test/token-overhead.test.ts test/context

# 4. Prove the prefix shrank (throwaway measure script from 01-audit.md §6)
HOME=/tmp/claicfg XDG_CONFIG_HOME=/tmp/claicfg/.config XDG_DATA_HOME=/tmp/claicfg/.local \
  node --import tsx scripts/_measure_now.ts

# 5. Behavior / tool-error parity — REQUIRED when NVIDIA creds are present
node --import tsx scripts/evaluate-token-overhead.ts
#    PASS = toolCalls, rounds, toolErrors, blockedCalls NOT increased;
#           verification still passed; toolsStable && systemStable true.
```

If step 5 cannot run (no credentials), record it as skipped in `tasks.md` and lean on
steps 1–4 plus a **claim-level diff** of the edited section (every imperative/
prohibition/named-mechanism that existed before still exists).

**Set up a baseline once** (for `scripts/measure-token-overhead.ts` before/after deltas):
```sh
git worktree add /tmp/clai-baseline $(git merge-base HEAD origin/main)
# then any time:  node --import tsx scripts/measure-token-overhead.ts /tmp/clai-baseline
```

---

## Phase 0 — Baseline & instrumentation (no behavior change)

**Goal:** lock in a reproducible before-picture so every later delta is provable.

- Install deps: `npm ci --ignore-scripts`.
- Create the throwaway `scripts/_measure_now.ts` (listing in
  [`01-audit.md`](./01-audit.md) §6) and record the current numbers
  (`systemTokens`, `schemaTokens`, `combinedTokens`, per-tool table) into `tasks.md`.
- Create the baseline worktree (command above).
- Confirm the current state of the guards: run the gate (steps 1–4) on an unmodified
  tree — everything must be green before you change anything.

**Savings:** 0. **Risk:** none. This phase only measures.

---

## Phase 1 — Compress tool-schema `description` prose (cache-safe, high value)

**Why first:** editing a tool's `description` string is pure prose compression inside
`src/tools/definitions/*`. It is cache-safe (C1–C3 untouched), cannot change the param
contract (keep names/types — invariant T2), and is independently testable. ~48% of the
prefix is tool schema; its descriptions are the most repetitive text in the whole prompt.

**What to change (in `src/tools/definitions/`):** tighten the `description` fields of the
heaviest tools, preserving every parameter and every behavioral caveat, just denser:

| File | Tool(s) | Now (tok) | Target | How |
|---|---|---:|---:|---|
| `fs-read.ts` | `fs.read` | 1,042 | ~650 | Collapse `FS_READ_DESCRIPTION`'s 7 sentences to the essential read-policy; keep all param docs; the `# FILE POLICY` header already repeats the multi-file guidance — don't duplicate it here. |
| `web-1.ts` | `http.fetch` | 815 | ~520 | Keep the raw-forensic framing + every param; cut the prose that repeats `# WEB READING`. |
| `shell.ts` | `shell.exec` (+ wait/tail/jobs/stop) | 1,333 | ~900 | Shorten the long foreground/background/responder paragraph; the mechanics also live in `# BACKGROUND/LONG-RUNNING` (which Phase 4 trims) and `# TOOLS` header — keep one canonical copy. |
| `subagents.ts` | `subagent.*` (esp. start, read) | 1,464 | ~850 | These are OFF by default yet always paid. Compress hard; keep param names + the "read-only, cannot delegate/mutate" caveat. |
| `web-2.ts` | `web.fetch` | 524 | ~360 | Trim prose duplicating `# WEB READING`; keep selectors. |
| `terminal.ts` | `terminal.send`/`start` | 851 | ~620 | Already telegraphic; squeeze the long `secretSource`/`control` prose, keep enums (T2!). |
| `aggregate.ts` | `plan.create` | 574 | ~430 | Dense already; trim repeated "durable/evidence" phrasing (keep the artifact field list). |
| `context-2.ts` | `pdf.read`, `image.ocr` | 683 | ~500 | Trim prose, keep params. |
| `define.ts` | `timeoutMs` auto-injected desc (×6) | ~6×~25 | ~6×~12 | Shorten the shared `timeoutMs` description string once; it is paid in all 6 TIMED_TOOLS. |

**Downstream / no residue:** update the catalog SHA lock in `test/token-overhead.test.ts`
(R2); keep `assertDefinitionRegistryConsistency` green (T3); do **not** touch param
names/enums (T2). No `embed-prompts` needed (these are `.ts`, not prompts).

**Expected savings:** ~2,500–3,500 tokens. **Risk:** low (prose only; A/B-verifiable).

---

## Phase 2 — Compress system-prompt prose, section by section (behavior-sensitive)

**Why second:** biggest absolute pool (11,437 tok) but the most behavior-sensitive.
Do **one section per task**, gate each, so a regression is isolated to one small diff.

Edit `src/prompts/system.agent.md`, then **always** `npm run embed-prompts` (R1).
Preserve every directive listed in [`02-invariants.md`](./02-invariants.md) §2 — reword,
never drop a capability. Order by value:

| Order | Section | Now (tok) | Target | Compression approach |
|---|---|---:|---:|---|
| 2a | `# HOW YOU THINK` | 3,203 | ~2,100 | Fold the "professional execution method" bullets into one tight list; remove phrasing re-stated in OPERATING RULES/PLANNING/DEBUGGING; keep priority order, query-vs-directive, mid-task steering, proportionality, parallelism, honesty-over-haste. |
| 2b | `# BACKGROUND / LONG-RUNNING` | 1,792 | ~900 | Keep the *decision rules* (foreground default, responder=fire-and-continue+job.read, never poll-loop, localhost rules). Delete the mechanics already in the `shell.exec`/`shell.wait`/`job.read` **schemas** (don't document the same flags twice across the prefix). |
| 2c | `# BUILDING SOFTWARE` | 918 | ~620 | Keep "deliverable is the working feature", verification ladder, don't-re-scaffold, scratch rules. Trim repeated examples. |
| 2d | `# OPERATING RULES` | 1,078 | ~750 | Deduplicate against HOW YOU THINK; keep "match the deliverable", high-signal-commands, parallel reads. |
| 2e | `# CODE STYLE` | 686 | ~450 | Keep the hard ceilings (complexity/line limits, no `any`, comments-earn-place); compress the explanatory prose. |
| 2f | `# PLANNING` | 628 | ~480 | Keep plan-mode vs agent-mode distinction and the stop-after-plan.create rule; trim restated detail (the full plan contract lives in `planModeDirective()`). **Do not edit `planModeDirective()` itself** (SHA-locked, R3). |
| 2g | `# DEBUGGING & FIXING` + `# RESILIENT ERROR HANDLING` | 705 | ~500 | Keep the repro→localize→hypothesize→fix→verify ladder and the error-recovery decision rules; compress examples. |

**Downstream / no residue:** `npm run embed-prompts` + commit `embedded.ts` (R1);
the `toContain(...)` and `not.toMatch(/\{\{.../)` assertions in
`test/token-overhead.test.ts` must stay green (they check specific strings survive —
if you legitimately reword one of those checked strings, update the assertion to the new
canonical wording, intentionally); update `request-snapshots` snapshot if it changes (R6).

**Expected savings:** ~2,500–3,500 tokens. **Risk:** medium — **gate with the live A/B
harness per task.** If a section's compression drops `verification passed` or raises
tool calls/errors, revert just that section.

---

## Phase 3 — One safe structural merge: `fs.writeMany` → `fs.write` (optional `files[]`)

**Why:** `fs.read` already proves the single-or-`files[]` shape is model-friendly.
Folding `fs.writeMany` into `fs.write` as an optional `files[]` param removes one tool
(~130 tok) **and** lets the model write many files in **one** call (fewer round-trips =
fewer full-prefix re-sends — directly serves the user's "one call not many" requirement).

**What to change:**
1. `src/tools/definitions/files.ts` — give `fs.write` an optional `files[]` param
   (mirror `fs-read.ts`'s shape); remove the `fs.writeMany` def.
2. `src/tools/registry.ts` + `src/tools/handlers/files-*.ts` — route `fs.write` with
   `files[]` through the existing writeMany handler logic; drop the standalone handler key.
3. `src/tools/retired-tools.ts` — add `RETIRED_TOOL_UPGRADES["fs.writeMany"]` that
   rewrites a `fs.writeMany` call to `fs.write` with the same `files`. **(T1: zero new
   tool-call errors.)**
4. `src/prompts/system.agent.md` `# FILE POLICY`/`agentNativeToolsHeader` + any prose
   mention of `fs.writeMany` → describe the merged `fs.write`. Re-embed (R1).
5. `src/modes/ask.ts` if it references `fs.writeMany` (it is mutating, so likely not in
   ask lists — verify).

**Downstream / no residue:** catalog SHA lock (R2); `assertDefinitionRegistryConsistency`
(T3); snapshot update (R5/R6); re-embed prompts (R1).

**Expected savings:** ~130 tokens + round-trip reduction. **Risk:** low-medium — the
upgrade mapping makes it error-proof; verify the handler correctly handles both the
single-file and `files[]` shapes.

> **Do NOT** attempt to merge `fs.edit`/`fs.replaceLines`/`fs.append` (invariant T4) or
> `http.fetch`/`web.fetch` (distinct forensic vs readable contracts) or `image.ocr`/
> `image.view`. Those merges would raise tool-selection errors — the opposite of the goal.

---

## Phase 4 — Remove cross-duplication between prompt prose and tool schemas

**Why:** the same mechanics are documented **twice** — once in a system-prompt section and
again in a tool schema. After Phases 1–2 made each copy smaller, pick the single canonical
home for each and delete the other copy's redundancy.

| Mechanic | Canonical home to KEEP | Redundant copy to TRIM |
|---|---|---|
| ripgrep/grep search syntax | `# SHELL RESEARCH` header | prose scattered in OPERATING RULES |
| `fs.read` read-policy / paging | `fs.read` schema | `# FILE POLICY` header overlap |
| background/responder/timeout flags | `shell.exec`/`shell.wait` schemas | `# BACKGROUND/LONG-RUNNING` (already trimmed in 2b) |
| web.fetch vs http.fetch choice | `# WEB READING` (short) | the two schemas' long "not for X" prose |

Keep exactly one clear statement of each; the model does not need the same rule in both
halves of the prefix. Re-embed after prompt edits (R1).

**Expected savings:** ~500–1,000 tokens. **Risk:** low-medium — ensure no rule is lost
entirely (claim-level diff + A/B).

---

## Phase 5 — OPTIONAL, experimental: default capable routes to a tighter prompt

**Status: do this ONLY if Phases 1–4 landed cleanly and NVIDIA (or equivalent) creds are
available for the live harness. Treat it as a research spike, not a commitment.**

The repo already ships `compactAgentPromptNative` (`src/prompts/index.ts`), far smaller
than the slim default, gated behind `useCompactSystemPrompt()` (default **false**) and
`reliabilityPolicy.slimNativePrompt`. The team keeps the fuller prompt for reliability.

**Safe way to explore (cache-safe because the choice keys on provider/model, fixed per
session — invariant C3 allows this):**
1. Pick one strong model family. Via the live A/B harness, compare the **tightened slim
   prompt** (post Phase 2/4) vs the **compact prompt** on the 6 fixtures in
   `scripts/token-overhead-fixtures.ts`.
2. Promote compact-by-default **only** for model families where the harness shows
   `verification passed` unchanged and **no** rise in `toolCalls`/`rounds`/`toolErrors`
   across all fixtures, repeated (ABBA) to cancel ordering bias.
3. Leave every other route on the tightened slim prompt.

**Downstream / no residue:** if you change the default selection logic
(`reliability-policy.ts` `slimNativePrompt` / `tool-routing.ts`
`useCompactSystemPrompt`), keep it a pure function of provider/model (C3); add a config/
env override; update `test/token-overhead.test.ts` only if the *default* route's measured
prompt changes.

**Expected savings:** up to ~2,700 tokens on promoted routes. **Risk:** high behavior
risk — **this is why it is gated and optional.** If parity is not clean, **do not ship it**
and report the result; Phases 1–4 already deliver the safe ~−28%.

---

## What success looks like

- The `/context` chip on turn one drops from ~22k toward ~16k (Phases 1–4), with the
  `< N` ceiling in `test/token-overhead.test.ts` ratcheted down to lock it in.
- `scripts/evaluate-token-overhead.ts` reports **lower** `firstPromptTokens` with
  **equal-or-better** `toolCalls`, `rounds`, `toolErrors`, and unchanged verification
  `passed` — i.e. cheaper **and** no regression.
- `cache.fingerprint.prefixSha256` stability test stays green (cache prefix intact).
- No `fs.writeMany`-style name ever errors (upgrade mapping), and the agent solves the
  fixture tasks identically.
