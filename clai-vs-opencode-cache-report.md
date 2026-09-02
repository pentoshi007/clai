# clai vs opencode — Prompt-Cache & Professionalism Audit

**Source data:** `~/Downloads/clai.txt` (clai request), `~/Downloads/opencode.txt` (opencode request), `~/Downloads/opencode-requests-info.txt` (opencode architecture notes), plus the clai source in `~/Downloads/clai/src/`.
**Date:** 2026-09-01

---

## 1. TL;DR

opencode gets **99%** cache hit because its request history is **purely append-only**: static system prompt, static tools, then a growing tail of assistant/tool messages where *no earlier message is ever edited, moved, or deleted between requests*. The only uncached tokens per turn are the newest assistant turn + tool results (**649 tokens**).

clai gets **88%** because it **removes and re-inserts state blocks in the middle of the message array every request** (`REQUEST CONTEXT`, `ACTIVE PLAN`, `SESSION STATE`, governor notes). The provider's prefix cache diverges at the first removed block, so the *entire last turn plus all refreshed blocks* is re-billed at full price every turn (**6,967 tokens** — 10.7× more uncached than opencode). On top of that, clai sends **23 identical `PROGRESS GOVERNOR` messages** and **56 tool schemas (~16.8k tokens)** on every request.

The fix is not tuning — it is a small set of structural rules: **never mutate sent history, dedupe injections, freeze the tool set, pin the session to one gateway node.**

---

## 2. Side-by-side numbers (from the two dumps)

| Metric | clai | opencode |
|---|---|---|
| Model | `xai/grok-4.6` | `moonshot/kimi-k3` |
| Endpoint | `/v1/responses` | `/v1/responses` |
| Input tokens | 56,119 | 60,041 |
| Output tokens | 641 | 757 |
| **Cache hit rate** | **88%** (49,152 hit) | **99%** (59,392 hit) |
| **Cache miss (full-price) tokens** | **6,967** | **649** |
| Estimated cost | $0.0424 | $0.0303 |
| Total response time | 32.0s | 22.9s |
| Tool definitions sent | **56 tools, ~67 KB ≈ ~16.8k tokens (30% of the request)** | **12 tools, ~16.5 KB ≈ ~4.1k tokens (6.9%)** |
| `PROGRESS GOVERNOR` injections in history | **23 (identical, up to 5 in a row)** | 0 |
| user-role messages | 27 (mostly injected `[SYSTEM]` blocks) | 3 (task + 2 × "continue") |
| Session-affinity headers | **none** | `x-opencode-session`, `x-session-affinity`, `x-opencode-client`, `x-opencode-project` |
| Mid-history mutations between requests | yes (block removal + arg elision) | none |

Note: grok-4.6 and kimi-k3 have different per-token prices, so don't attribute the whole $0.0424 → $0.0303 gap to caching. The cache-rate gap itself (12.4% → 1.1% miss) is entirely structural and model-independent.

---

## 3. How automatic prefix caching works (why the details below matter)

Both requests go through the same gateway (byunara/`router.bynara.id`) with `store: null`, `previous_response_id: null` — i.e. **the client resends the full transcript every turn**, and the provider caches by **longest matching token prefix** starting at byte 0:

- The cache hit extends from the start of the request until the **first token that differs** from any previously seen prompt.
- **Everything after that point is a cache miss**, even if it appeared verbatim in earlier requests.
- Appending new messages at the end is free-ish (cached prefix + small new suffix). **Editing, deleting, or reordering any earlier message forfeits the cache for everything after it.**
- Provider caches are typically **per-worker, in-memory**. Without a session-affinity routing hint, consecutive turns can land on different workers and miss regardless of message stability.

---

## 4. What clai does differently — root causes, with evidence

### 4.1 Remove-and-repush of trailing state blocks (the 88% → 99% gap)

clai refreshes its dynamic state blocks every request by **deleting all existing copies from wherever they are in the array, then pushing new copies at the end**:

- `src/agent/session-state.ts:143-166` — `upsertSessionStateMessage`: *"Drop every prior SESSION STATE copy… Always append"*.
- `src/agent/injected-blocks.ts:7-19` — `upsertKeyed` (agent instructions, skills): same splice-then-push.
- `src/agent/plan-tool.ts:448-491` — `upsertPlanContextMessage` / `ACTIVE PLAN` block: same pattern ("Keep exactly one live ACTIVE PLAN copy in the request, as a suffix").
- `src/agent/runner.ts:1779` — `upsertRequestContextMessage(messages, requestContextMessage)`: same.

Why this is the killer: between request *N* and request *N+1*, new messages (assistant turn, tool results, governor notes) are appended **after** the previous request's tail blocks. The refresh then **splices those old blocks out of the middle** of the array. The new request's text diverges from the cached text exactly at that splice point — which sits *before* the newest turn. Result: the whole newest turn + all re-pushed blocks are uncached.

In the dump, the request ends with a freshly rebuilt 4-block tail — `REQUEST CONTEXT` (incl. the full AGENT MODE charter), `ACTIVE PLAN v381`, `SESSION STATE / WORKING MEMORY`, `PROGRESS GOVERNOR` — and the observed miss (6,967 tokens) matches "previous tail region + full newest turn + new tail" almost exactly.

opencode never touches history. Its tail is `…assistant → tool_result → assistant → tool_result`, so the cached prefix extends to the end of the previous request and only **649** new tokens miss.

**Fix (highest impact):**
1. **Dirty-check before touching the array.** If a block's rendered content is unchanged since the last request, don't remove or re-push it — leave it exactly where it is.
2. When a block *did* change, **append the new copy and leave the old one in place**; make the protocol "the most recent `ACTIVE PLAN`/`SESSION STATE` message is authoritative" (you already have this language in `PLAN PROTOCOL` — relax the "single copy" rule). Stale copies cost a few *cached* tokens; removal costs thousands of *uncached* tokens. Strip stale copies during compaction, which busts the cache anyway.
3. Reorder stably: when blocks are re-pushed, keep their relative order identical every turn (`REQUEST CONTEXT → ACTIVE PLAN → SESSION STATE → governor`) so a later "keep prefix" optimization never trips on reordering.

### 4.2 Volatile fields inside the refreshed blocks make them dirty every turn

Even with append-only, re-rendering a block whose text changed every turn keeps adding uncached suffix. clai's blocks embed counters that tick on *every successful tool call*:

- `ACTIVE PLAN v381` — the **version number** is in the text, and each task carries `[evidence: 786 successful tools; last shell.exec]` (`plan-tool.ts:491`). Every tool success changes these numbers → the block is dirty every turn.
- `SESSION STATE / WORKING MEMORY` — contains `last_ok_tool: shell.exec`, `done: t1; t2; t3`, etc.
- `DURABLE WORK ENVELOPE` — `Verified checks: fs.read # …; fs.edit …` grows per check (`durable-envelope.ts:161-167`).

**Fix:** split each block into a *stable* part (goal, tasks, constraints — re-injected only when structure changes) and a *volatile* part (counters, last tool — either dropped, moved to the tiny final suffix, or only updated every N turns / on task transitions). A plan that re-renders only on `task.add/move/update-state` (not on evidence ticks) is clean for whole stretches of a session.

### 4.3 `PROGRESS GOVERNOR` spam — 23 duplicates in one request

`runner.ts:3556-3565`: every time `governProgress` returns `"reflect"`, a `PROGRESS GOVERNOR: resource envelope reached…` message is pushed via `deferredPostToolMessages`. These are **never deduped and never removed** until compaction. The dump shows 23 identical copies — including runs of 5 in a row between two assistant turns (~1,400 tokens of dead weight riding on every subsequent request, and pure noise for the model).

Worse, it visibly **failed at its job**: the assistant re-ran the *same python verification script 4–5 times* (tool calls `-16`, `-20`, `-21`, `-22`, `-23` — same checks, same `OK` output), each time preceded by "t4 is still open. I'll re-verify…". The governor fired repeatedly and the loop continued anyway.

**Fix:**
- At most **one** governor message per request cycle, and only when `reason` differs from the last injected one.
- Strip all governor messages at compaction (they're ephemeral by nature).
- Make the governor *escalate* instead of repeat: 1st fire = note, 2nd = require a `task.update`/plan change before more tools, 3rd = hard pause with a concrete fork of options. A repeated identical message is a no-op the model learns to ignore.

### 4.4 Retroactive slimming/elision rewrites already-sent history

`message-slim.ts` + `tool-history.ts` (`projectToolHistory`) + `context-manager.ts` (`leanTailMessages`, `slimToolArgs`) rewrite *old* messages — replacing large args/results with `«N chars sha256=…»` stubs or `content_elided` siblings. The a922533 diff in the dump even adds a guard that **disables compaction replay when `projectToolHistory(...).changed`** — an explicit acknowledgement that projection mutates history.

Any such rewrite of a message that was already sent to the provider busts the prefix from that message onward. (In this very dump the old-code stubbing bug fires: the assistant's `fs_write` payload *is* the stub `«5696 chars sha256=903e84157a43…»` — the f149d05 bug, live — costing a wasted write plus a `git show` recovery turn.)

**Fix:** slim/truncate **at capture time** — when the message is first appended — so sent history is immutable thereafter. Never re-slim older messages between requests; defer all historical rewriting to compaction. Keep the write-time stub-rejection guard from f149d05.

### 4.5 No session-affinity routing to the gateway

opencode's request carries `x-opencode-session: ses_…`, `x-session-affinity: ses_…`, `x-opencode-client: cli`, `x-opencode-project: <hash>`. The gateway uses these to pin the session to the worker holding its warm prefix cache. clai sends **no equivalent header for bynara/xAI/Moonshot** — affinity keys exist only for openrouter (`session_id`) and fireworks (`prompt_cache_key`) (`src/llm/http.ts:1420-1432`).

Also note clai's key derivation (`src/llm/cache-affinity.ts`): it hashes the **first system message + first non-system message**. After every compaction, the first non-system message becomes the new "Session memory" message → **the key changes exactly when the request is largest** → cold node → full miss on the most expensive turn.

**Fix:** send a stable-per-session header (e.g. `x-clai-session: <sessionId>`, and whatever affinity header the gateway honors — mirror opencode's `x-session-affinity`) on every provider request, and make `cacheAffinityKey` constant per session (hash the session id, not message content).

### 4.6 Tool catalog: 56 schemas ≈ 16.8k tokens vs opencode's 12 ≈ 4.1k tokens

clai sends 56 tool definitions (`fs_read…fs_delete` ×9, `shell_exec/start/jobs/tail/stop/wait` ×6, `terminal_*` ×6, `mcp_*` ×5, `pentest_*` ×5, `net_*` ×4, plan/task tools, web tools, …) with long decision-guide descriptions. That's **30% of every request**. opencode sends 12 tersely-described tools.

Cached schema tokens are cheaper than uncached, but not free — and a large catalog raises the risk that any per-turn variation (mode-gated tools, `selectToolDefs(native, …)`, compaction tool subsets) busts the *entire* cache, since tool schemas serialize ahead of/with the system section.

**Fix:**
- Consolidate along the seams opencode uses: one `read` (file+dir), one `shell` (exec/jobs/tail/stop/wait via an `action` field), one `terminal`, one `mcp`, one `pentest` with an `op` enum. Target ≤ ~15 tools, ≤ ~5k tokens.
- Move decision guides out of `description` into the system prompt or into tool-returned hints.
- **Freeze the tool set for the whole session.** If a tool must be gated by mode, gate at execution time (return an error), not by removing the schema.

### 4.7 Compaction hygiene (mostly fine, two refinements)

The post-compaction front matter — `Session memory from compacted earlier turns` + `DURABLE WORK ENVELOPE` — sits at the front and is rebuilt per compaction. One full bust per compaction is unavoidable; the replay-safe path from a922533 is the right idea. Two refinements:

- Keep these front blocks **byte-stable for the entire epoch** between compactions: never refresh the envelope mid-epoch at the front; if canonical state must surface mid-epoch, append a new envelope at the tail (per 4.1/4.2).
- Keep ticking counts/timestamps out of memory/envelope rendering (e.g. artifact receipt timestamps like `2026-09-01T08-27-42-651Z` are fine inside immutable tool results, but not in re-rendered summary blocks).

---

## 5. Action list, ordered by expected impact

| # | Change | Where | Expected effect |
|---|---|---|---|
| 1 | Append-only state blocks: dirty-check, never splice out mid-array; latest-copy-wins protocol; strip stale copies only at compaction | `session-state.ts`, `injected-blocks.ts`, `plan-tool.ts`, `runner.ts:1779` | Miss per turn drops from ~7k to roughly the newest turn (~1-3k) — this alone is most of the 88→99% gap |
| 2 | Remove ticking counters (`v381`, evidence counts, `last_ok_tool`) from re-rendered blocks; re-render only on structural change | `plan-tool.ts:491`, `session-state.ts`, `durable-envelope.ts` | Long stretches with *zero* block churn → ~649-token-class misses |
| 3 | Governor: dedupe (max 1/cycle, only on new reason), strip at compaction, escalate instead of repeat | `runner.ts:3538-3565`, `progress.ts`/`evidence-governor.ts` | −1.4k tokens/request here; also unblocks the doom-loop fix (#7) |
| 4 | Slim/elide only at capture time; never rewrite sent history outside compaction | `message-slim.ts`, `tool-history.ts`, `context-manager.ts` | Removes sporadic mid-history busts |
| 5 | Send session-affinity headers to bynara; make `cacheAffinityKey` session-constant | `http.ts`, `cache-affinity.ts` | Protects against cold-node misses; crucial after compaction |
| 6 | Consolidate 56 → ~12-15 tools; freeze the set per session; slim descriptions | `tools/definitions*.ts`, `registry.ts` | −12k tokens of schema per request; removes a whole class of full-bust risk |
| 7 | Hard loop-block: refuse identical successful command re-runs unless `WorkLedger` changed since; extend "trust the receipt" from `fs.write` to verification scripts | `loop-guard.ts`, tool result receipts | Kills the 4-5× re-verification loop visible in the dump (each iteration cost ~2-4k tokens) |
| 8 | Metrics + tests: log per-request cache hit/miss; conformance test asserting "messages of request N are a byte-prefix of request N+1 except designated tail suffix" | `request-accounting.ts`, `test/conformance/request-snapshots.test.ts.snap`, `test/provider-cache-affinity.test.ts` | Turns cache regressions into CI failures instead of surprise bills |

With #1–#3 done, clai's profile on this same session would be ~60k input with ~1-2% miss — i.e. opencode's 99% regime — plus ~14k fewer tokens sent per turn after #6.

---

## 6. Beyond cache — gaps to "professional tool" level visible in these files

1. **Loop governance that actually stops loops.** The governor observed 23 times and changed nothing. `loopGuard.getAttemptCount` already counts identical attempts — wire it to a *hard* refusal (with a clear message: "identical check already passed at turn N; mutate something or justify") instead of a soft repetition score.
2. **Trust-your-receipts discipline.** `fs.write` already returns *"Do NOT re-read this file to verify the write — trust this receipt"* — excellent. Generalize: every tool that produces verifiable state returns a receipt hash; verification scripts consult the last receipt instead of re-reading/re-checking. The dump shows the model re-reading `message-slim.ts` right after writing it, and re-running an all-OK check script 4 times.
3. **Guard rails for known footguns.** The elided-stub-as-write-payload bug (f149d05) burned a turn *in this session*. Keep the write-time rejection of stub-pattern content, and add the same guard to `fs.edit` newText.
4. **Deterministic request shape as a tested invariant.** opencode's cleanliness isn't an accident — treat "prefix stability" as a contract: snapshot-test that consecutive requests share a byte-prefix except the appended tail, that tool schemas are byte-identical across turns, and that injected blocks are suffix-only.
5. **Cost/latency observability per turn.** Surface `hit / miss / miss-reason` (block-refresh | new-turn | compaction | tool-change | node-change) in the status line. You can't fix what you can't see; the gateway already returns the numbers.
6. **Assistant turn discipline.** clai's per-turn text preambles are fine and short (good). Keep them out of history bloat by leaving them as-is (they're append-only), but avoid re-stating plan/task status in prose — that's what the (fixed, append-only) state blocks are for.
7. **Thinking budget explicitness** (from `opencode-requests-info.txt`): opencode sets explicit provider options per protocol (Anthropic `thinking.budget_tokens`, OpenAI `reasoning_effort`, Gemini `thinkingConfig`) at the request level and relies on cached reasoning across actions rather than re-thinking per turn. clai should pass one explicit, bounded budget per session and avoid re-deriving it per round.

---

## 7. One-paragraph summary

opencode's 99% comes from boring discipline: a frozen system prompt, a frozen 12-tool catalog, and a transcript that only ever grows at the end, pinned to one gateway worker by a session header. clai's 88% comes from four self-inflicted wounds: splicing refreshed state blocks out of the middle of history every request, embedding ticking counters in those blocks, accumulating 23 copies of the same governor note, and rewriting old tool args/results between requests — with no affinity header to protect against cold nodes. Make history append-only, dedupe and escalate the governor, slim at capture time, freeze and shrink the tool set, pin the session, and assert prefix-stability in CI. That gets clai to the same ~99% regime and roughly a third fewer tokens sent per turn — and the loop-blocking and receipt-trust fixes make it behave like a professional tool, not just bill like one.
