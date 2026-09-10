# Read-only orchestration

## User controls

Orchestration is session-local and defaults off, including after restoration. `/orchestration [on|off|status]` reports its state and purpose; only an explicit user command enables delegation. Disabling it requests cancellation of all active children. `/agents` opens a live picker in Classic and OpenTUI. Select a child to inspect its output, Escape back to the picker, then select another child or Main. `/agents stop <id>` and `/agents restart <id>` control individual assignments. Cancelling all work also stops children.

## Execution boundary

The parent retains implementation responsibility. Six stable parent tools expose start, list, read, wait, stop, and restart. They require the active enabled session, cannot enable orchestration themselves, and are rejected through the standalone registry or nested batches. Reads default to three recent events; completed reports are retrieved separately so entire child histories do not inflate the parent context.

The child does not reuse the global-state parent runner. Its fixed tool profile permits only confined filesystem reads/listings/searches and web search/fetch. Shell, editing, arbitrary HTTP actions, MCP, approvals, and recursive delegation are unavailable. Both native and fenced tool protocols pass through the allowlist before execution. Paths are resolved against the assigned project root and checked for traversal and symlink escapes. This is an application-level tool boundary, not an operating-system sandbox against other processes concurrently replacing filesystem entries.

The parent chooses zero to three independent assignments when delegation offers useful context or parallelism. The process-wide execution limit counts stopping workers until their actual operations settle, including across session replacement. Duplicate active assignments are rejected. Workers have a 24-round budget, a ten-minute cancellation deadline, bounded request/response sizes, and bounded tool output. Reads over 2 MiB require parent inspection. Searches skip generated directories and symlinks, limit traversal and file counts, and explicitly disclose coverage gaps. Uncooperative operations retain their slots rather than falsely appearing stopped.

Reports require findings, evidence with relevant paths/lines or URLs, actionable next steps, and coverage gaps. Unsupported conclusions, partial investigations, and exhausted budgets do not become successful completed reports. The parent treats reports as evidence, not instructions, and owns final verification.

## History and responsiveness

Child records are stored separately under their parent history namespace using atomic private files. There are at most 24 retained child identities per parent; reaching capacity rejects new identities without silently dropping their history. Restarts preserve the identity and prior-attempt evidence within bounded transcript limits. Restored interrupted executions become stopped, never automatically resumed. `/clear` and history deletion remove associated child records; `--no-history` avoids persistence.

Snapshots are immutable and cached by run identity. Notifications and persistence are throttled, waits are subscription-driven, and live pagers release their subscriptions when closed. Completed records are not repeatedly copied/redacted on each active child's token. Redaction is pattern-based and cannot guarantee detection of every possible credential; persisted assignments intentionally cannot recover redacted values on restart.

## Cache behavior and verification

Tool schemas and system instructions remain fixed when orchestration is toggled. Its latest state is mandatory appended request context, including when a previously used state is selected again. Old messages are not rewritten. Each child has an independent append-only history and stable routing/cache affinity across its restarts. A provider change, schema/software update, deliberate compaction, cache expiry, or provider eviction may still cause a cache miss; no provider hit-rate guarantee is implied.

Tests cover disabled and nested dispatch, filesystem confinement, denied mutations, stable prefixes, actual registry reads, bounded resources, cancellation races, shared concurrency, restart/history isolation, persistence/redaction, and both live UI adapters. The native inspector participates in normal test discovery through a Bun wrapper. The automatic-compaction fixture uses a 40k context limit rather than 30k to leave admission room for the expanded stable schema; its oversized history and exact single-summary-dispatch assertions remain unchanged.

Scripted local-provider terminal checks exercise integration behavior, not real-model judgment or comparative task success. Task-level model benchmarks and cross-platform runtime execution remain separate verification work.

The Classic PTY flow verified enabling orchestration, launching a child, rejecting a write attempt, reading the real package metadata, following live output, and returning to the parent without interruption. OpenTUI's native-renderer interaction test verifies live output, switching, status changes, and Escape behavior. Its separate raw-PTY launch was inconclusive in this sandbox: both the phase-one control and phase-two build emitted only the same 14 startup-control bytes and no visible application text. Full raw-terminal OpenTUI end-to-end verification is therefore not claimed.
