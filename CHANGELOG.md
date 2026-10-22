# Changelog

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
