# Changelog

## v5.1.6 — 2026-11-01

### Explicit turn completion

- Add the `turn.end` tool. The agent calls it with its final message and a reason (`completed`, `answered`, `needs_user_input`, `blocked` or `stop_requested`), judged only against your latest message, and the turn ends without another request. Tool-free answers, questions back to you, genuine blockers and explicit stop instructions are all valid ends. The declaration resets for every new prompt and counts only when the rest of the response is successful plan or job bookkeeping and no Responder result is unread.
- When a reply ends without a tool call and without `turn.end`, ask the model once whether it is finished. It either declares the end, which keeps its earlier reply as the answer, or makes the next tool call. Some models, such as Muse Spark, end a round with a progress line like "Moving to the cross-pass diff." and the turn stopped with work unfinished. The check is a fixed message appended after the reply, so earlier cached context is reused, and further checks need more tool work first, so turns cannot loop.

### Image tool cards

- Show `image.view` and `image.ocr` calls as one row per image with its path (`image 1/2: shots/before.png`) in OpenTUI, matching `fs.read` cards, instead of dumping the raw `{"paths": […]}` arguments. Paths that exceed the card width are middle-clipped with the filename intact, OCR options stay on their own line when the input carries them, and the pager header lists every image the call opened so the full input remains recoverable.

### Smooth transcript scrolling

- Glide wheel input on each renderer's own frame clock in Classic and OpenTUI. Motion now follows elapsed time instead of when input reports arrive, so bursty SSH input scrolls as continuous 60 fps motion instead of uneven multi-row jumps. Distance stays exact, single notches move exactly one row, reversals respond on the next frame, the glide stops at the transcript edges, and keyboard or jump navigation still cancels pending wheel input.
- Keep OpenTUI's frame rate at its 60 fps cap when an animation-frame request starts live rendering while a frame is already scheduled. OpenTUI 0.4.5 started a second frame loop in that case, roughly doubling frames, CPU and terminal output during scrolling.
- Keep the OpenTUI transcript moving while an older or newer window of items mounts, instead of holding the scroll position until the swap completes and then jumping.

## v5.1.5 — 2026-11-01

### Goals

- Add `/goal <condition>`, which starts a turn with the condition and keeps working until an evaluator judges it met or impossible. Verdicts appear in the transcript, and a strip above the composer in Classic and OpenTUI shows the elapsed time and evaluated turns.
- Add `/goal` status (condition, running time, evaluated turns, token spend and last reason), `/goal pause`, `/goal resume`, and `/goal clear` with the aliases `stop`, `off`, `reset`, `none` and `cancel`.
- Pause the goal after an interrupt, three turns without tool calls, 50 automatic turns, or a rate limit. Retry network and server errors three times. Clear it after authentication, credit, model-availability or context-overflow errors. Defer evaluation while subagents or background jobs run, with check-ins after 30 minutes.
- Restore active and paused goals when a session resumes. Store them per session, redacted, and skip storage in private mode and with `--no-history`.
- Keep the prompt cache warm: the evaluator repeats the last request with identical tools and reasoning settings and appends the question, which is never saved to history. Continuations are appended as hidden messages. `Esc` cancels an in-flight evaluation.

### Context usage after compaction

- Report the size of the compacted request right after `/compact` and automatic compaction. Previously the context indicator kept the provider count of the discarded history, so it could show several times the real size until the next request corrected it.

### Smooth scrolling over SSH

- Apply pending wheel input on the next paint instead of spreading a burst over trailing animation frames. OpenTUI coalesces reports across separate input chunks until its renderer is ready, avoiding repeated scroll/layout work between visible frames.
- Keep Classic's interactive paint interval at its 60 Hz target instead of adding cost-based delays during wheel input. Adaptive background pacing remains unchanged.
- Compact redundant terminal style sequences in durable attachments while preserving text, cursor commands, queries, UTF-8 and opaque control payloads, including tmux passthrough. A real-renderer fixture reduced OpenTUI's ANSI stream by 62% compared with that same stream before compaction; Classic's already-minimal stream was unchanged. Total traffic still depends on content and paint cadence, and network latency or VM load can still affect responsiveness.
- Retain the complete transcript, exact wheel displacement, navigation and jump-to-latest cancellation. Discard orphaned wheel input when a transcript unmounts without losing pending input during synchronous window replacement.

### Compaction and file-read diagnostics

- Quote the actual latest one to three user prompts in compaction memory, including a lone unfinished prompt, instead of substituting a retained-message placeholder. Keep existing excerpt limits, credential redaction, live-message retention and cache/replay prefixes intact.
- Derive multi-file `fs.read` failure summaries only from failed entries. Successful source containing words such as `failure`, `ENOENT` or `clearTimeout` no longer supplies a misleading error snippet; real partial failures still retain every successful read and per-file status.

## v5.1.4 — 2026-10-26

### Settings and output retention

- Add `/settings` in Classic and OpenTUI with filtering, arrow/Tab navigation, keyboard toggles, and persistent preferences.
- Turn automatic tool-output saving off by default. Enable it through settings when needed; explicit captures, background logs, and interactive-session logs remain available. Do not display saved-output paths when no file was created, and preserve private-mode restrictions.
- Render image/paste attachment labels, brackets, and caret boundaries in aqua, including whitespace-prefixed, wrapped, and Unicode input.

### Cleaner OpenTUI controls

- Connect tool commands and their output with a continuous branch, including multiline arguments and failed or blocked details.
- Remove tool-card and task-pane expand-all/collapse-all buttons while retaining individual disclosure and keyboard controls.
- Show **Hide** inside the task pane and **Tasks** below the composer only while the pane is hidden. Preserve an explicit hidden preference across plan updates.
- Remove delivered results from the Responder strip, including delivered-but-unread entries. Keep running and awaiting-delivery work visible without changing result consumption or Jobs history.
- Stabilize history selection and scrolling, simplify pagers, and keep image-view cards compact.

### Meta model capabilities

- Prefer published model context limits, output limits, and reasoning efforts. When Meta returns only model IDs, use the documented 1,048,576-token context for Muse Wonder 1.0 and Muse Spark text models rather than the generic 200k fallback.
- Show only supported effort levels. Preserve literal `max` for Muse Wonder 1.0 and standard Muse Spark 1.3 in complete and streaming requests, including after catalog refreshes and earlier learned downgrades. Keep credential-scoped cached metadata separate and omit unsupported reasoning controls.

### Composer-only token speed

- Show token speed only below the composer in Classic and OpenTUI. Retain duration, completion status, line-change counts, and `/changes` in turn summaries without appending TPS.
- Settle the footer to the completed turn's aggregate output tokens and provider-active duration, including aborted and failed turns. Preserve live estimates, stored generation metrics, and lifecycle fencing against late events.

### Reliability

- Restore River usage reporting and strengthen provider-accounting coverage.
- Keep oversized MCP discovery output bounded in model context even when automatic saving is disabled, without advertising a nonexistent artifact.
- Accept generated history session IDs whose timestamp ends in `sk`, without weakening rejection of secret-like parent identifiers. Add a deterministic regression for the intermittent subagent-history CI failure.
- Extend native terminal and cross-platform CI coverage for settings, output retention, attachment colors, and tool/task interactions. Correct the stale multi-file pager-title assertion.

### Upgrade notes

- No session migration is required. Automatic tool-output saving is now opt-in; existing saved files are not removed.
- Task-pane, tool-card, and Responder-strip control changes are OpenTUI-only.

## v5.1.3 — 2026-10-25

### Status-aware command colors

- Color tool-pager commands green on success, yellow while queued or running, and red on failure or blocked execution in Classic and OpenTUI.
- Apply the same status colors to command titles in job-tail views, including live completion, failure, and paused readers. Preserve output colors, wrapped multiline commands, search highlighting, and file syntax highlighting.

### Live TPS corrections

- Refresh live TPS during provider pauses instead of leaving a fast burst frozen on screen. Stop sampling when the request settles, is cancelled, or retries.
- Apply cumulative OpenAI-compatible and Gemini usage after the output in the same frame so subsequent estimates do not count that output twice. Exact counters immediately replace displayed estimates without disabling update throttling.
- Include reasoning and tool-call output when throughput is the only stream observer. Completed TPS remains reported output, including reasoning, divided by provider-active time; live `~` readings are estimates, not visible-answer speed.

## v5.1.2 — 2026-10-24

### Responsive attachments

- Show submitted prompts immediately while images are prepared asynchronously, including queued prompts sent with **Send now**. Keep typing, navigation, clipboard operations, and `image.view` responsive during image loading and conversion.
- Reference original image files instead of making redundant scratch copies. Cache successful image preparation with source-change invalidation, while preserving model image limits, cancellation, and the exact bytes sent to the provider.
- Display compact attachment labels such as `[Image 1]` instead of full file URIs in the composer and transcript, without losing the underlying file reference or changing ordinary prompt text.

### Compact, live, persistent TPS

- Use the shorter `tps` label below the composer in Classic and OpenTUI. Remove the visual `ctx` and Shift+Tab hints while preserving context-limit editing and keyboard mode switching.
- Update throughput during generation with event-driven, throttled updates. A `~` prefix identifies estimates while streaming; exact provider output-token counters replace estimates when available. Reasoning and tool-call output are included without counting reasoning twice in provider usage.
- Retain the latest reading through tool execution, idle periods, and the next turn. Clear it when the provider, model, or session changes, and reject late updates from cancelled or settled work.
- Keep live estimates separate from completed-turn summaries. Saved summaries continue to use exact reported output and provider-active duration, excluding tool execution and auxiliary requests.

### Reliable long-running REA analysis

- Increase managed Ghidra and Hopper startup defaults to **two hours**, and the Swift helper startup default to **ten minutes**, so large imports are not cancelled by the earlier short startup deadline.
- Prevent a global MCP timeout from imposing a shorter deadline on managed REA calls. Preserve explicit request deadlines, manual cancellation, and bounded connection/availability checks. See [REA.md](https://github.com/pentoshi007/clai/blob/v5.1.2/REA.md) for configuration.

### CI reliability

- Fix the native attachment-flow test on CI's pinned Bun 1.3.14 by awaiting actual request dispatch and turn completion instead of treating renderer idleness as completion of asynchronous file preparation. Preserve responsive-typing, compact-label, normal-send, queued-send, and exact image-byte assertions.
- Add live-streaming, cancellation, lifecycle-fencing, throughput-math, and Classic/OpenTUI footer regressions across terminal widths.
- Await background history recovery and full Ctrl+C cancellation settlement before fixture cleanup. Restore persisted model selections explicitly in compaction tests so changing default-provider catalog limits cannot change their expected context window.
- Pin elapsed-time fixtures away from rounding boundaries. Wait for the actual session-prompts pager and completed disk search instead of matching transcript or search-input text, and reject late disposed-source errors in the native test.

### Upgrade notes

- No configuration or session migration is required. A `~` TPS value is a live estimate, not an exact provider measurement; providers that report usage only at completion receive their exact rate at that point.

[Full comparison since v5.1.1](https://github.com/pentoshi007/clai/compare/v5.1.1...v5.1.2)

## v5.1.1 — 2026-10-23

### Long-running MCP and REA tools

- Remove automatic MCP tool execution and stall deadlines, including the outer watchdog that cancelled REA analysis after about 63 seconds. Stdio, HTTP, and SSE calls wait for completion unless manually cancelled or given an explicit request deadline.
- Keep connection startup, authentication, catalog discovery, and shutdown safeguards. Explicit request deadlines cover reconnect and retry without replaying ambiguous writes.

### Foreground-only Esc and immediate mouse cancellation

- Keep double keyboard `Esc` limited to the main agent in Classic and OpenTUI. Shell jobs, Responder tasks, subagents, and their result delivery continue; background-only activity does not arm Esc cancellation.
- Make the OpenTUI `esc: cancel` button stop the main agent on one click, without keyboard confirmation or hover expansion.
- Preserve bulk cancellation through `Ctrl+C`, explicit manual stops, and exiting clai, including bounded shutdown cleanup of owned jobs.
- Add long-running transport/watchdog regressions and native OpenTUI checks covering hover layout, one-click abort, double Esc, real background process survival, Responder result delivery, and Ctrl+C cleanup.

[Full comparison since v5.1.0](https://github.com/pentoshi007/clai/compare/v5.1.0...v5.1.1)

## v5.1.0 — 2026-10-23

This release adds the Hinoki provider and a bundled, on-demand security skill, improves skill recovery after compaction, and fixes tool progress and terminal rendering. It covers all changes since **v5.0.0**.

### Hinoki provider

- Add `hinoki` with the default `hinoki-offensive` model, authenticated model discovery, streaming answers and reasoning, function calls, and image support. Configure it with `clai set hinoki` and `clai use hinoki`, or `HINOKI_API_KEY`; `HINOKI_BASE_URL` and saved endpoints can override the default URL.
- Use published model metadata for context/output limits, tools, vision, and reasoning controls. Retain learned limits between sessions, coalesce concurrent catalog requests, and isolate caches by credential and endpoint. Temporary catalog failures retain the last successful result with a retry cooldown; authentication errors remain visible for key rotation.
- Preserve complete conversation and tool-result replay, per-session cache affinity, shared key failover, and measured cached-input, cache-write, and reasoning-token usage when the API reports it. Cache hits and workspace credit balances are not inferred.

### Bundled skills and compaction recovery

- Ship `clai-superman-skill`, an on-demand security investigation library covering web/API, identity, cloud, mobile, native systems, wireless/OT, AI agents, supply chains, and related research workflows. Include its usage guide and evaluation scenarios in the npm package.
- Discover bundled skill metadata without eagerly loading reference content. Embed the library in standalone binaries and materialize its files only when loaded. Project, user, and custom-root skills with the same name continue to override the bundle.
- Preserve a bounded index of loaded skills and previously read references through both summarized and mechanical compaction. Tell the agent to reload still-relevant instructions when their full content has left live context, rather than treating a historical load marker as sufficient.
- Allow necessary skill reloads after compaction without authorizing replay of side-effecting tool sequences. Keep stable prompt/tool prefixes and cache affinity intact when loading or recovering guidance.

### Tool progress and file reads

- Show a pending tool card as soon as the provider identifies a streamed call, before its arguments finish. Animate argument preparation in both interfaces, stop the thinking timer at the tool boundary, and update the same card when complete arguments arrive and execution begins.
- Reconcile parallel calls by wire ID or stream order, deduplicate legacy progress signals, and settle incomplete previews on cancellation, errors, or retry. Partial argument bytes are not displayed, and an unfinished preview is never recorded as a successful tool execution.
- Use one `fs.read` input parser across execution, tool schemas, argument display, outcome handling, and read-only subagents. Normalize unambiguous single-file and multi-file inputs while rejecting conflicting paths, ranges, and ambiguous filter placement with actionable errors.

### Terminal rendering and responsiveness

- Make wheel scrolling in Classic and OpenTUI follow current input instead of replaying a long frame-by-frame backlog. Preserve single-notch precision, catch up after delayed frames, and cancel remaining motion on reversal, boundaries, and explicit jumps.
- Keep clipped artifact paths and other one-row text stable while the transcript scrolls. Middle-clip long whole-text links to preserve both ends without losing their target.
- Pin the OpenTUI status line to the terminal bottom across viewport resizes, and restore the trailing gap after turn summaries.
- Restore a dedicated version row on startup cards in both interfaces, including the compact `ver` label at narrow widths.
- Keep bold reasoning titles on their own rows in both interfaces without changing ordinary assistant emphasis or losing streamed markdown consistency.
- Color Responder-owned plan rows by task state, matching their glyphs and phase chips. Adjust split and overlay pane widths to retain a clean gutter.

### Validation and packaging

- Check generated bundled-skill content for drift during CI and normal builds, and include it in native compilation.
- Expand regressions for Hinoki routing/catalogs/streaming, skill discovery and packaging, cache continuity through compaction, pending tool lifecycles, file-read parsing, real terminal geometry, scrolling, and plan rendering.
- Repair catalog, updater, snapshot, and loaded-machine timing regressions so the release remains gated on the complete cross-platform CI suite.

### Upgrade notes

- No configuration or session migration is required for this release. Existing providers and user/project skills remain supported.
- Hinoki requires its own API key; generation is charged against the provider's workspace credits. See [PROVIDERS.md](https://github.com/pentoshi007/clai/blob/v5.1.0/PROVIDERS.md#hinoki) for setup and capability details.
- The bundled security skill loads on demand and does not grant extra tool permissions or change engagement scope. Override it through a normal project/user/custom skill, not by editing its generated cache. See the [security skill guide](https://github.com/pentoshi007/clai/blob/v5.1.0/guides/security-skill.md).

[Full comparison since v5.0.0](https://github.com/pentoshi007/clai/compare/v5.0.0...v5.1.0)

## v5.0.0 — 2026-10-22

This release covers all changes since **v4.19.0**, including the REA integration, session and interface improvements, provider fixes, and the reliability work below.

### Accurate completion statistics

- Show output tokens per second alongside elapsed time, file changes, and `/changes` in Classic and OpenTUI, including narrow layouts and restored transcripts.
- Calculate TPS from reported output tokens and model-active generation time across foreground calls. Tool execution, user waits, auxiliary calls, and compaction do not inflate the rate; reasoning tokens are not counted twice.
- Preserve earlier valid measurements when a later generation is interrupted. Aborted turns retain measured TPS, and exact partial usage is included when the provider reports it. Missing usage is never replaced with guessed token counts.

### Live output and durable queued prompts

- Keep tool-output and job pagers live in both interfaces, following streamed output, spool replacement, final artifacts, externally appended job logs, and log rotation.
- Preserve paused scrolling when output completes, with explicit follow controls, bounded reads, redacted output, and cleanup of subscriptions and file watchers.
- Stream the OpenTUI compaction pager through progress, replacement, final summaries, and failures instead of opening a frozen snapshot.
- Persist unsent queued prompts per session with validated, redacted, atomic storage. Recover them after crashes, normal shutdown, session switches, and composer editing.
- Remove a queued prompt only after foreground model submission is acknowledged. Pre-submission failures retain and pause the prompt rather than silently losing it or retrying indefinitely. Private/no-history sessions do not persist the queue.

### On-demand reverse engineering with REA

- Add managed REA installation, updates, connection controls, and status, with `@rea`, `/rea <task>`, and an in-app `/rea guide` in both interfaces.
- Attach a version-matched, grouped tool index and workflow only when needed, preserving the stable system prompt and native tool catalog. Indicate tools that need an open target, an analysis engine, or unavailable prerequisites.
- Add explicit user-run `/rea engines` status, install, use, and remove workflows for Ghidra, Java, and configured external engines. The agent cannot install analysis engines on its own.
- Harden downloads with trusted HTTPS hosts, redirect validation, published SHA-256 checks, streamed size limits, stall detection, and disk-space checks. Reject unsafe archive entries and corrupted extraction.
- Improve macOS, Linux x64/ARM64, and Windows installation behavior, including native decompiler builds where required, Windows path and rename handling, stale staging cleanup, selected-engine environment precedence, and clear unsupported-platform guidance.
- Improve cancellation, reconnect sequencing, staged-update version reporting, installation contention messages, strict argument hints, exact tool lookup, and lazy archive loading.

### Sessions, compaction, and terminal interfaces

- Store sessions in individual append-only delta logs, automatically importing legacy `history.jsonl` while preserving the original file. Keep rejected frames separately and avoid unnecessary history reloads.
- Rebuild compaction memory around the active goal, scoped instructions, gathered context, completed work, next steps, relevant files, genuine issues, and the latest user prompts. Preserve inherited instruction scope and stable replay prefixes.
- Reduce per-frame transcript work and smooth wheel scrolling in both interfaces. Fix OpenTUI wheel stalls, duplicate acceleration, window-update races, and final-tool-card reachability without discarding saved history.
- Refresh startup cards with clearer mode and permission badges, responsive labels, a consolidated version/welcome row, and correct provider/model pairing in Classic.
- Improve whole-cell mouse selection, padding-origin drags, selectable startup and plan content, and plain-click behavior. Remove the transcript scrollbar.
- Render markdown in completed and streaming reasoning, including emphasis and fenced code, with incremental caches. Improve status spacing, context chips, and tool durations.
- Print large piped `history --show` output completely under Bun and regenerate the README preview from the real OpenTUI renderer.

### Providers and agent reliability

- Cache model lists for two minutes instead of up to thirty; never cache empty or fallback lists. Add `/model refresh` and `/models refresh [filter]`, bypass stale/in-flight results, and identify unavailable live catalogs accurately.
- Size reasoning output budgets from learned, live, remembered, or documented model limits, up to 131,072 tokens where supported. Preserve context fit and learn actual output caps from provider rejections with a bounded retry.
- Send a stable per-session River `prompt_cache_key`, preserve DeepSeek reasoning on tool-bearing requests, and derive Free/Zen context limits from the live catalog.
- Recover from malformed DSML tool calls rather than terminating the turn.
- Allow `http.fetch` to reach private, loopback, CGNAT, and metadata addresses while retaining engagement-scope enforcement.
- Recover from asynchronous shell artifact open, write, and flush failures without crashing Bun or discarding bounded output. Surface actionable storage warnings and fatal-shutdown diagnostics.
- Clean recognized session scratch folders after ten days of inactivity, checking at most daily across processes. Protect active sessions, recently modified files, and symlink targets; leave saved conversations and global/custom artifact retention unchanged. Compare expiry conservatively at millisecond precision so filesystem timestamp rounding cannot delete a folder at the exact ten-day boundary.

### Safer tools and agent guidance

- Allow `fs.edit` replacements of `""` to delete exact matching text. Keep empty search text invalid with actionable guidance rather than a generic argument error.
- Clarify exact current `oldText`, whitespace and line endings, safe creation/insertion alternatives, stale-preview risks, and the requirement to re-read after a no-match result.
- Require Responder delegation for finite work expected to exceed four to five minutes, including long suites, builds, scans, and CI watches. Keep interactive sessions in terminal tools and persistent servers/watchers in named normal background jobs.
- Preserve useful prompt safeguards and raise the native prompt-overhead guard to 23,000 estimated tokens.
- Keep deliverables out of scratch directories and avoid adopting unrelated same-named projects. Scope persistent instructions to the actual project while preserving cross-turn prompt-cache prefixes.
- Prevent MCP fuzzy matching from overriding built-in tool names or wire spellings, preserving built-in confirmation and parallel-safety rules.

### Validation and distribution

- Expand regressions for provider cancellation and exact TPS, both terminal interfaces, live pagers, queue submission/restart/shutdown behavior, atomic storage, tool edits, prompt variants, cache stability, and platform-specific REA behavior.
- Isolate test home directories and disable the real keychain during tests so placeholder provider keys cannot overwrite developer credentials.
- Harden CI checkout credentials and require SHA-256 evidence in the REA smoke test.
- Synchronize the v5 version across runtime metadata, npm lockfile, Homebrew and Scoop templates, and include this changelog in the npm package.

### Upgrade notes

- Existing configuration remains supported; legacy session history is imported automatically and retained.
- Queued-prompt persistence does not promise distributed exactly-once delivery across a crash between remote acceptance and local acknowledgement.
- TPS is omitted when exact provider usage is unavailable rather than displaying a fabricated rate.
- REA engine setup remains an explicit user action; platform prerequisites and limitations are documented in [REA.md](REA.md).

[Full comparison since v4.19.0](https://github.com/pentoshi007/clai/compare/v4.19.0...v5.0.0)
