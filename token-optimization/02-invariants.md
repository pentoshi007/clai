# 02 — Invariants: the safety contract

> **Read this before changing anything.** Every task in [`tasks.md`](./tasks.md) names
> the invariants it touches. Token savings **never** justify breaking one of these.

There are three guarantees we must preserve, in priority order:

1. **Cache-prefix stability** — never break prompt caching.
2. **Behavior neutrality** — the agent must solve tasks exactly as well as before.
3. **Tool-call-error neutrality** — no new "wrong tool / wrong args / retry" failures.

---

## 0. The one mental model that makes optimization safe

> **Prompt caching breaks when the prefix changes *between turns within the same
> session*. It does NOT break merely because the prefix is smaller than it used to be in
> a previous release.**

A provider caches a prefix of the request (system prompt + tool definitions + the stable
head of the conversation). On turn *N+1* it reuses the cached prefix **iff** that prefix
is byte-identical to turn *N*'s prefix and the new content is strictly appended.

Therefore:

- ✅ **Shrinking the system prompt or a tool description is cache-safe** — it produces a
  *new* but still *stable* prefix. The first turn after the upgrade is a cold cache
  (it always is after any upgrade); every subsequent turn in that session hits the new
  warm prefix. This is normal and costs nothing extra.
- ✅ **Merging/renaming a tool is cache-safe** — same reasoning: the tool array is
  different from the old release but stable within every new session.
- ❌ **Making the prefix depend on state that can change mid-session is NOT cache-safe.**
  Example: including `subagent.*` only when orchestration is on. A user runs
  `/orchestrator on` at turn 5 → the tool array changes at turn 5 → the prefix is
  invalidated mid-session. **This is the trap to avoid.**
- ❌ **Putting volatile data into the stable prefix is NOT cache-safe** (and the codebase
  already avoids this — do not regress it).

So: **compress freely; never make the prefix a function of per-turn or mid-session
mutable state.**

---

## 1. Cache-prefix invariants (do not break)

These are enforced by code in `src/llm/` and by `test/token-overhead.test.ts`. The
implementing agent must keep all of them true.

| # | Invariant | Where it lives / why |
|---|---|---|
| C1 | **`message[0]` (the stable system prompt) is byte-identical across every turn of a session.** | `src/agent/turn/message-assembly.ts` places it at index 0; it feeds `firstSystemPrompt` (Anthropic `system` block) and `cacheAffinityKey` (`src/llm/cache-affinity.ts`). Keep rendering it with `stableEnvironment:true` so `{{os}}/{{cwd}}/{{datetime}}` stay the literal `"see REQUEST ENVIRONMENT"` constant (`src/prompts/index.ts` `STABLE_ENVIRONMENT_VALUES`). **Never inline volatile data into it.** |
| C2 | **The tool array (`tools`) and its ORDER are stable within a session.** | `classifyPrefixAffinity` (`src/llm/request-fingerprint.ts`) marks the whole prefix `not_eligible` if the `tools` section hash changes. Preserve tool ordering from `routeToolNames`. |
| C3 | **The tool set does not depend on per-turn or mid-session-mutable state.** | This is why `subagent.*` are "listed even when disabled" (see `system.agent.md` and the registry stubs). Do **not** gate tools on orchestration, plan existence, or anything a user can toggle mid-session. Gating on **provider/model** (fixed per session) is acceptable. |
| C4 | **All volatile data stays in the APPENDED `REQUEST CONTEXT` message (and later injected blocks), never in `message[0]`.** | `renderRequestEnvironmentContext` + `composeTurnMessages` push it *after* the user turn; `normalizeSystemMessages` (`src/llm/system-messages.ts`) rewrites trailing `system` messages to `[SYSTEM]`-tagged user turns. Datetime is hour-floored (`floorToLocalHour`) so even the tail churns ≤1×/hour. |
| C5 | **History is append-only.** | Never reorder or rewrite prior turns; `request-plan.ts` relies on `exact_append_eligible` / `partial_prefix_eligible`. |
| C6 | **The compiled request `cache.fingerprint.prefixSha256` is unchanged by budget/recovery/delivery changes.** | Locked by `test/token-overhead.test.ts` ("keeps the instructions and schema fingerprint through budget changes…"). Any edit must keep this test green (the *hash value* may change across the release, but it must stay stable across the in-session mutations the test exercises). |
| C7 | **Anthropic breakpoint budget is preserved:** 1 system block (only applied when system ≥ 4,000 chars) + ≤3 rolling conversation breakpoints. | `src/llm/anthropic.ts`, `src/llm/adapters/anthropic-tools.ts`. Our prompt stays well above 4,000 chars, so do not shrink it below that threshold (no risk at our sizes). |

### Key consequence for this effort

The system prompt and tool schemas live **entirely inside the cached prefix**. That is
*good news*: compressing them is cache-safe. The only cache rule you can actually violate
is **C3** (making the tool set conditional on mutable state) or **C4** (leaking volatile
data into `message[0]`). Everything in the roadmap avoids both.

---

## 2. Behavior-neutrality invariants (do not break)

The system prompt is a behavior specification. Compressing prose must **preserve meaning
and coverage**, only reduce words. The following directives are load-bearing and MUST
survive every compression (reword, never delete the capability):

- **Honesty rule** (`# HONESTY`) — never claim an unperformed action/result. Keep intact;
  it is the top-priority rule and is cheap (152 tok).
- **Full offensive-security posture** (`# SECURITY POSTURE`) — assist fully on pentest/
  VAPT/red-team, no refusals/lectures/disclaimers, non-destructive by default. This is a
  product differentiator; **do not dilute capability to save tokens.**
- **Query vs directive** distinction (ask → answer; direct → act). Losing this causes the
  agent to mutate on questions or stall on directives — a behavior regression.
- **Verification ladder** (typecheck/build/test → runtime proof) and **"match the
  deliverable"** (feature ≠ scaffold, fix ≠ diagnosis-only, finding ≠ open port).
- **Tool-call format & parallelism** rules (parallel independent reads; serial writes).
- **File-edit discipline** (`FS_EDIT_DISCIPLINE`) — copy `oldText` literally; after a
  no-match, don't repeat the same `oldText`. Directly prevents `fs.edit` retry errors.
- **Background/responder/timeout** semantics — foreground-by-default, `timeoutMs` is
  foreground-only ms, responder = fire-and-continue + `job.read`. Losing precision here
  causes polling loops and duplicate jobs.
- **Plan vs agent tasks**, **continuation/resume** (don't restart done work), and
  **pentest methodology** (only rendered on pentest turns).

**Rule of thumb:** after compressing a section, diff the *claims* (not the words). Every
imperative, prohibition, and named mechanism present before must still be present after.
These are verified by:
- The `toContain(...)` assertions in `test/token-overhead.test.ts` (e.g. the fs.edit
  discipline strings, `"rg -n --glob"`, the plan-mode/compaction SHA locks).
- The **live A/B harness** `scripts/evaluate-token-overhead.ts`, which fails a candidate
  that regresses verification `passed`, or increases `toolCalls`/`rounds`.

---

## 3. Tool-call-error-neutrality invariants (do not break)

- **T1 — Never silently remove or rename a tool the model may still call.** If you merge
  or rename, add a `RETIRED_TOOL_UPGRADES` entry (`src/tools/retired-tools.ts`) so the old
  name is **silently rewritten** to the new call. This yields **zero** new tool-call
  errors even if a model emits the old name out of habit.
- **T2 — Preserve every parameter's name, type, enum values, and required/optional
  status** when compressing a schema. You may shorten `description` text; you may **not**
  change the contract the model codes against. Changing a param name or dropping an enum
  value is a behavior/err regression.
- **T3 — Keep `assertDefinitionRegistryConsistency` passing.** Every `TOOL_DEFINITIONS`
  entry that isn't in `NON_REGISTRY_TOOL_NAMES` must have a `toolRegistry` handler, and
  wire names must be unique. Merging a tool means updating def + handler + consistency.
- **T4 — Do not merge tools with distinct failure modes** (`fs.edit`/`fs.replaceLines`/
  `fs.append`). Distinct, well-named tools help the model pick right on the first attempt
  — the user's explicit requirement.
- **T5 — First-attempt success & single-call-where-possible.** Prefer merges that let the
  model do in **one** call what previously took several (e.g. multi-file write), because
  every extra round-trip re-sends the whole prefix. Never a merge that makes the model
  guess.

---

## 4. Residue / downstream-sync invariants (do not leave the tree inconsistent)

These are the places a careless edit leaves the repo broken or half-changed:

| # | If you edit… | You MUST also… |
|---|---|---|
| R1 | any `src/prompts/*.md` | run `node scripts/embed-prompts.mjs` and commit the regenerated `src/prompts/embedded.ts` **in the same commit**. Runtime loads the *embedded* copy first (`loadPromptFile`); the markdown alone has **no effect** until re-embedded. CI guard: `npm run embed-prompts:check`. |
| R2 | `TOOL_DEFINITIONS` (any tool def) | update the SHA lock in `test/token-overhead.test.ts` ("locks the retained tool catalog") to the new `sha256(JSON.stringify(getToolDefinitions()))`, and keep `assertDefinitionRegistryConsistency` green. |
| R3 | `planModeDirective()` / `COMPACTION_SYSTEM_PROMPT` / `buildCompactionUserPrompt(...)` | update their SHA locks in `test/token-overhead.test.ts`. (Avoid editing these unless a task says to.) |
| R4 | anything that shrinks the prefix | **ratchet the `< 22_000` ceiling in `test/token-overhead.test.ts` DOWN** to just above the new measured value, to lock the win and prevent silent regrowth. |
| R5 | merge/rename a tool | add `RETIRED_TOOL_UPGRADES` mapping (T1); update `registry.ts`; update any prose mention in `system.agent.md`/`system.ask.md`; update ask-mode lists in `src/modes/ask.ts`; update any snapshot (`test/conformance/__snapshots__/request-snapshots.test.ts.snap`) with `-u`. |
| R6 | any prompt/tool change | re-run the request-snapshot + context tests; update snapshots only when the change is intended and reviewed. |

---

## 5. The definition of "done" for any single change

A change is done only when **all** of these hold (this is the gate referenced in
[`03-roadmap.md`](./03-roadmap.md) and every task):

1. `npm run typecheck` passes.
2. `npm run embed-prompts:check` passes (if prompts changed).
3. `npm run test:deterministic -- test/token-overhead.test.ts test/context` passes
   (plus any test the task names), with SHA locks and the `< N` ceiling updated
   **intentionally**, not loosened.
4. Offline measurement shows the prefix **smaller** than before the change
   (record the before/after token numbers in [`tasks.md`](./tasks.md)).
5. If NVIDIA credentials are available: `scripts/evaluate-token-overhead.ts` shows
   **no** increase in `toolCalls`, `rounds`, `toolErrors`, or `blockedCalls`, verification
   still `passed`, and `toolsStable`/`systemStable` true. If credentials are **not**
   available, record that the live check was skipped and rely on the offline guards +
   a careful claim-level diff of the section (§2 rule of thumb).
6. No residue: every applicable row in §4 is handled.
