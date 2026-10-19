# 01 — clai Token-Usage Audit

**Scope:** the fixed, per-request token overhead sent *before* the user's task can
accomplish anything — i.e. the cacheable prefix on the first agent-mode turn.

**Why it matters:** this prefix is re-sent on every turn. On a cold cache (first turn,
model switch, cache expiry) the user pays for all of it. Shrinking it lowers cost and
latency on every single request and widens the usable context window for real work.

---

## 1. Headline numbers (measured on current `main`)

Measured by invoking the repo's own builders
(`createToolRouting().buildStableSystemContent(...)`, `selectToolDefs(...)`,
`toOpenAiTools(...)`) on route `nvidia / openai/gpt-oss-20b`, native tools, no MCP,
no vision, default `slimNativePrompt=true`. Estimator = `ceil(chars / 3.3)` (the
estimator used throughout the codebase: `src/agent/request-accounting.ts`
`estimateTextTokens`).

| Component | Chars | Est. tokens |
|---|---:|---:|
| Stable system prompt (`message[0]`) | 37,740 | **11,437** |
| Native tool-schema payload (request `tools` field) | 34,820 | **10,552** |
| **Fixed prefix total** | **72,560** | **21,988** |
| Exposed tool count | — | **39 tools** |

The existing guard `test/token-overhead.test.ts` asserts
`ceil((system.length + JSON.stringify(toOpenAiTools(tools)).length) / 3.3) < 22_000`.
**We are 12 tokens under that ceiling** — the prompt is already at the limit the team
set, which is exactly why the context chip reads ~22k on turn one.

On top of the prefix, each turn also appends a small, token-capped **REQUEST CONTEXT**
block (~1,000–1,500 tokens: OS/shell/cwd/time, mode directive, outcome/plan contracts,
empty scope). It is already capped at ~2,000 tokens in
`src/agent/turn/setup/turn-messages.ts` and is **out of scope** for this effort — it is
small, already bounded, and holds the volatile data that *must* stay out of the cached
prefix.

---

## 2. Where the system-prompt tokens go (`message[0]`)

The default prompt is the **slim-native** template `agentPromptNativeSlim`
(`src/prompts/index.ts`), assembled as:

```
sectionBefore("# TOOL CALLS — HOW TO USE TOOLS")   // ROLE + HOW YOU THINK + HONESTY + SECURITY POSTURE
  + agentNativeToolsHeader                           // short "# TOOLS / # SHELL RESEARCH / # FILE POLICY"
  + projectInstructionPolicy                         // PERSISTENT PROJECT INSTRUCTIONS slice
  + "\n\n"
  + sectionFrom("# OPERATING RULES")                 // OPERATING RULES ... CONTINUATION & CONTEXT
  + "\n\n" + FS_EDIT_DISCIPLINE                       // appended by renderAgentSystemPrompt
```

The big inline tool catalog (`# TOOLS (use these EXACT argument names)`, 15,765 bytes)
and the `# TOOL CALLS` protocol are **already dropped** in slim mode — good, that work
is done. `# PENTEST METHODOLOGY` (4,829 bytes) is stripped at render time on
non-pentest turns via `withPentestMethodology`.

### Per-section byte sizes of `src/prompts/system.agent.md`

(Exact bytes incl. the header line. "In slim prompt?" = present in the default
`message[0]`.) Approx tokens = `ceil(bytes / 3.3)`.

| Section (header) | Bytes | ≈tok | In slim prompt? |
|---|---:|---:|:--:|
| `# TOOLS (use these EXACT argument names)` | 15,765 | 4,777 | ❌ dropped in native |
| **`# HOW YOU THINK`** | **10,569** | **3,203** | ✅ |
| **`# BACKGROUND / LONG-RUNNING`** | **5,912** | **1,792** | ✅ |
| `# PENTEST METHODOLOGY` | 4,829 | 1,464 | ⚠️ only on pentest turns |
| **`# OPERATING RULES`** | **3,558** | **1,078** | ✅ |
| **`# BUILDING SOFTWARE`** | **3,027** | **918** | ✅ |
| **`# CODE STYLE`** | **2,262** | **686** | ✅ |
| **`# PLANNING`** | **2,070** | **628** | ✅ |
| `# SECURITY POSTURE` | 1,588 | 482 | ✅ |
| `# TOOL CALLS — HOW TO USE TOOLS` | 1,328 | 403 | ❌ replaced by header |
| **`# RESILIENT ERROR HANDLING`** | **1,289** | **391** | ✅ |
| `# DEBUGGING & FIXING` | 1,035 | 314 | ✅ |
| `# CONTINUATION & CONTEXT` | 845 | 257 | ✅ |
| `# TIMEOUTS` | 771 | 234 | ❌ dropped in native |
| `# WEB READING` | 726 | 220 | ✅ |
| `# PERSISTENT PROJECT INSTRUCTIONS` | 627 | 190 | ✅ (as policy slice) |
| `# ROLE` | 557 | 169 | ✅ |
| `# HONESTY` | 501 | 152 | ✅ |
| `# STAYING CURRENT` | 496 | 151 | ✅ |
| `# CROSS-OS AWARENESS` | 336 | 102 | ✅ |
| `# ATTACHED REFERENCES` | 312 | 95 | ❌ dropped in native |
| `# CONFIRMATIONS` | 283 | 86 | ✅ |
| *(generated)* `agentNativeToolsHeader` | ~1,310 | ~397 | ✅ |
| *(generated)* `FS_EDIT_DISCIPLINE` | ~500 | ~151 | ✅ |

Measured total of the assembled slim prompt = **37,740 chars / 11,437 tokens**.

### System-prompt root causes (the reduction targets)

1. **`# HOW YOU THINK` (3,203 tok) is the single largest block** and the densest. It
   restates the professional-execution method, proportionality, query-vs-directive,
   mid-task steering, parallelism, and information-load rules — several of which are
   **restated again** in `# OPERATING RULES`, `# PLANNING`, `# DEBUGGING & FIXING`, and
   `# BUILDING SOFTWARE`. This overlap is the richest safe-compression target.
2. **`# BACKGROUND / LONG-RUNNING` (1,792 tok)** explains foreground/background/responder
   mechanics, `timeoutMs` units, and job lifecycle in long prose — **the same mechanics
   are already in the `shell.exec` / `shell.wait` / `job.read` tool schemas** (677 + 241
   + 294 tok). This is duplication across the two halves of the prefix.
3. **`# BUILDING SOFTWARE` + `# CODE STYLE` + `# PLANNING` + `# OPERATING RULES`
   (3,310 tok combined)** contain repeated "verify before claiming / match the
   deliverable / don't re-scaffold" guidance.

> There is **no quick "flip to the compact prompt" win that is free of risk.** The repo
> already ships a much smaller `compactAgentPromptNative`, but it is gated behind
> `useCompactSystemPrompt()` (default **false**) on purpose — the team keeps the fuller
> prompt as the default for behavioral reliability. Flipping that default is an *A/B-gated
> experiment* (Phase 5), not a safe given. The safe work is tightening the full slim
> prompt section-by-section toward compact density while preserving every directive.

---

## 3. Where the tool-schema tokens go (request `tools` field)

39 tools, serialized by `toOpenAiTools` (`src/llm/adapters/openai-tools.ts`). Measured
per-tool serialized size (JSON incl. per-tool framing). Grouped:

| Group | Tools | ≈tok | Notes |
|---|---|---:|---|
| `fs.*` | read, edit, replaceLines, append, write, writeMany, delete | **1,972** | `fs.read` alone = **1,042** |
| `plan/task/job` | plan.create, job.read, task.add/update/move, plan.clear | **1,572** | `plan.create` = 574 |
| `subagent.*` | start, read, wait, stop, list | **1,464** | **off by default**; always listed |
| `shell.*` | exec, wait, tail, jobs, stop | **1,333** | `shell.exec` = 677 |
| `terminal.*` | start, send, read, status, list, close | **1,312** | interactive lifecycle |
| `http.fetch` | — | **815** | kept deliberately (see §5) |
| `web.*` | fetch, search | **678** | — |
| `pdf.read` | — | **444** | — |
| `image.ocr` | — | **239** | `image.view` adds ~239 on vision routes |
| `skill.*` | load, list | **312** | — |
| `creds.*` | get, list | **233** | — |
| `instructions.record` | — | **209** | — |

### Top 10 heaviest individual tool schemas

| Tool | ≈tok |
|---|---:|
| `fs.read` | 1,042 |
| `http.fetch` | 815 |
| `shell.exec` | 677 |
| `plan.create` | 574 |
| `subagent.start` | 555 |
| `web.fetch` | 524 |
| `terminal.send` | 508 |
| `pdf.read` | 444 |
| `subagent.read` | 393 |
| `terminal.start` | 343 |

### Tool-schema root causes (the reduction targets)

1. **`fs.read` (1,042 tok)** — `FS_READ_DESCRIPTION` is a 7-sentence joined paragraph
   plus a large shared param block plus the `files[]` multi-read block
   (`src/tools/definitions/fs-read.ts`). The *parameter names and semantics* are
   essential; much of the *prose* repeats what the `# FILE POLICY` header already says.
2. **`subagent.*` (1,464 tok, ~7% of the whole prefix) is paid on every request even
   though orchestration is OFF by default.** We **cannot** remove it conditionally
   (that breaks the cache prefix on `/orchestrator on` — see
   [`02-invariants.md`](./02-invariants.md)), but its descriptions are among the most
   verbose and can be compressed safely.
3. **`http.fetch` (815) / `shell.exec` (677) / `web.fetch` (524) / `terminal.send`
   (508)** carry long inline guidance in their `description` fields that partially
   duplicates the system-prompt prose. Param schemas stay; prose tightens.
4. **`timeoutMs` is auto-injected** into 6 tools (`src/tools/definitions/define.ts`
   `TIMED_TOOLS`) with a description string repeated 6×.

---

## 4. The three representations of a "tool" (keep them in sync)

Any tool change touches **three** places, enforced by
`assertDefinitionRegistryConsistency` (`src/tools/definitions/selection.ts`):

1. **Canonical definition** — `src/tools/definitions/aggregate.ts` (`TOOL_DEFINITIONS`,
   built via `def(...)` from `src/tools/definitions/define.ts`). This is what the model
   receives as native schema. **49 defs total** (39 are exposed on the measured route;
   `mcp.*`, `agent.handoff`, `loop.reset`, and `image.view`-on-no-vision are excluded).
2. **Executable handler** — `src/tools/registry.ts` (`toolRegistry`, 34 handlers). Meta
   tools (plan/task/job/mcp/agent.handoff/loop.reset) have **no** handler — they are
   listed in `NON_REGISTRY_TOOL_NAMES` (`src/tools/definitions.ts`).
3. **Retirement/upgrade map** — `src/tools/retired-tools.ts`. `RETIRED_TOOL_UPGRADES`
   **silently rewrites** an old tool name to its replacement (e.g. `task.read`→`job.read`,
   `shell.start`→`shell.exec background:"always"`). **This is the mechanism that lets us
   merge a tool with ZERO new tool-call errors** — see the roadmap.

The compact flag is a **no-op for tools**: `getCompactToolDefinitions()` returns the
full catalog (locked by `token-overhead.test.ts`). So the tool payload is identical in
compact and full modes — all tool savings come from editing the definitions themselves.

---

## 5. Tools we keep and why (do not remove these for token reasons)

- **`http.fetch` — KEEP.** The user explicitly values it, and it is genuinely distinct
  from `curl` via `shell.exec`: it returns raw, decoded, forensic HTTP evidence (final +
  redirect headers, cookies, body SHA-256, arbitrary method/body/headers, sensitive-header
  controls) in a normalized shape every model can parse. Relying on models to hand-craft
  `curl -i`/`-D`/`-s` invocations and parse raw output is less reliable and *costs more
  tokens* in round-trips and output than one structured call. We **compress its
  description**, we do not remove it.
- **`fs.edit` / `fs.replaceLines` / `fs.append` — KEEP SEPARATE.** They have different
  failure modes (exact-text match vs line-range vs positional append). Merging them would
  make the model pick wrong and *increase* retry errors — the opposite of the goal.
- **`terminal.*` (6) — KEEP.** A genuine interactive lifecycle (SSH/REPL/msfconsole),
  distinct from one-shot `shell.exec`. Needed for security work (password prompts, PTY).
- **`image.ocr` + `image.view` — KEEP SEPARATE.** Pixels vs text extraction; different
  jobs. `image.view` is already auto-dropped on non-vision routes.
- **`subagent.*` (5) — KEEP LISTED.** Removing them conditionally breaks the cache prefix
  on `/orchestrator on`. Compress descriptions only.

---

## 6. How to reproduce every number here

All numbers above are offline and deterministic (no model calls, no credentials).

**Install deps (once):**
```sh
npm ci --ignore-scripts
```

**Absolute current prefix size + per-tool breakdown** — create this throwaway script,
run it, then delete it (it is intentionally NOT committed):

```ts
// scripts/_measure_now.ts  (temporary; delete after use)
import { createToolRouting } from "../src/agent/turn/tool-routing.js";
import { toOpenAiTools } from "../src/llm/adapters/openai-tools.js";
const est = (c: number) => Math.ceil(c / 3.3);
const route = createToolRouting({ mode: "agent", mcpPresent: false, toolCalling: "native", useCompactSystemPrompt: () => false });
const system = route.buildStableSystemContent(true, "nvidia", "openai/gpt-oss-20b");
const tools = route.selectToolDefs(true, false, "nvidia", "openai/gpt-oss-20b")!;
const schema = JSON.stringify(toOpenAiTools(tools));
const per = tools.map((t) => ({ name: t.name, tokens: est(JSON.stringify(toOpenAiTools([t])).length) })).sort((a, b) => b.tokens - a.tokens);
console.log(JSON.stringify({ systemTokens: est(system.length), schemaTokens: est(schema.length), combinedTokens: est(system.length + schema.length), toolCount: tools.length, per }, null, 2));
```

```sh
# A writable HOME/XDG dir is required because the import chain initializes the config store.
mkdir -p /tmp/claicfg/.config
HOME=/tmp/claicfg XDG_CONFIG_HOME=/tmp/claicfg/.config XDG_DATA_HOME=/tmp/claicfg/.local \
  node --import tsx scripts/_measure_now.ts
```

**Per-section prompt bytes:**
```sh
awk '/^# /{if(n!="")printf "%6d  %s\n",b,n;n=$0;b=length($0)+1;next}{b+=length($0)+1}END{if(n!="")printf "%6d  %s\n",b,n}' \
  src/prompts/system.agent.md | sort -rn
```

**Before/after deltas across 5 scenarios** (compares a baseline checkout to the working
tree) — this is the repo's own tool, use it to prove each phase's savings:
```sh
node --import tsx scripts/measure-token-overhead.ts /path/to/baseline-checkout
```

**The guard test** (must stay green; ratchet its ceiling down as you save tokens):
```sh
npm run test:deterministic -- test/token-overhead.test.ts
```

**Live A/B parity (needs NVIDIA credentials)** — the authoritative behavior/tool-error
check:
```sh
node --import tsx scripts/evaluate-token-overhead.ts   # runs before/after child trials, ABBA-ordered
```
It records `promptTokens`, `firstPromptTokens`, `toolCalls`, `toolErrors`, `blockedCalls`,
`rounds`, and `toolsStable`/`systemStable`, and **rejects** any candidate that uses more
tool calls/rounds/errors or changes the tool/system prefix hash.

---

## 7. Runtime self-check already in the product

`src/agent/context-breakdown.ts` (`buildContextBreakdown` /
`contextBreakdownAuditPayload`) already emits a per-component breakdown
(`constitutionTokens`, `toolSchemaTokens`, `planTokens`, `scopeTokens`,
`compactionMemoryTokens`, …) on every assembled request
(`src/agent/turn/loop/request-assembly.ts`). Use this audit payload to watch the real
breakdown move as phases land. `describeDominantContextBlock()` names the single
largest block — a good sanity check that the dominant cost is shrinking.
