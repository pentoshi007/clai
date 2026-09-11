# Read-only orchestration

## User controls

Orchestration is session-local and defaults off, including after restoration. `/orchestration [on|off|status]` reports its state; only an explicit user command enables delegation. Disabling it requests cancellation of active children. `/agents` opens the live picker in Classic and OpenTUI. Select a child to inspect its output, then Escape back to choose another child or Main. `/agents stop <id>` and `/agents restart <id>` control individual assignments. Cancelling all work also stops children.

## Delegation and ownership

The parent delegates independent research when saved context or parallel work outweighs coordination cost. Small tasks and tightly dependent work stay with the parent. Each assignment names its goal, deliverable, relevant surfaces, non-goals, technical depth, and expected evidence. The brief contains task-relevant facts, not the full conversation or parent system/project/skill instructions.

A delegated investigation belongs to its child while active. The parent continues necessary, non-overlapping work rather than reading the same files or investigating the same question. It verifies decisive claims after receiving the result. If nothing independent remains, it waits; it does not manufacture work, poll activity, or cancel healthy children because they are slower than duplicate parent research. Cancellation is appropriate for a user request, a genuine scope change, or work that cannot help. Existing children can be restarted with focused follow-ups and retained evidence.

There is no fixed child-count, assignment-count, step, or wall-clock execution budget. Duplicate active assignments remain rejected, including while cancellation is settling and across session replacement. Provider context windows and transport/storage safety bounds still apply; these are not task deadlines.

## Result delivery and waiting

Six parent tools expose start, list, read, wait, stop, and restart. They require the enabled session, cannot enable orchestration themselves, and must be called directly rather than through the standalone registry or nested batches.

Each completed, failed, or stopped attempt produces an immutable terminal result identified by child ID and attempt. Results enter a session-local inbox and are delivered at safe model boundaries, never by mutating an in-flight request. Delivery and explicit report reads share acknowledgments so the same attempt is not continually reinjected. A restart produces a new attempt, not a second delivery of the previous one.

`subagent.wait` has no timeout by default. With an ID it joins that dependency; without one it receives whichever child settles first. It waits on lifecycle events without making model requests. Optional explicit timeouts return status without cancelling the child. Abort, purge, and disposal release waiters; stopping a child wakes a waiter only after its operation actually settles.

A parent attempting to finish while children remain active waits for a terminal result, then resumes analysis. Results that arrive during independent work are injected before the next request. An idle session can also wake to consume a new child result. Session replacement, cancellation, and user-prompt priority fence those wakes so an old child cannot start work in a different session.

Joins return reports or errors directly. `subagent.read` defaults to three recent activity events for diagnosis. Report delivery uses pages of at most 24,000 characters, with `reportLength` and `nextOffset`; continue with `view: "report"`, the delivered `attempt`, and `offset: nextOffset`. Settled attempts remain readable within the live session even after restarting their child. Paging bounds parent context without truncating the stored report. Reports and tool outputs are untrusted evidence, not instructions.

## Worker execution

Children use an isolated runner and their assigned provider/model. Their tool profile permits confined filesystem reads/listings/searches and web search/fetch. Shell, editing, arbitrary HTTP actions, MCP, approvals, and recursive delegation are unavailable. Native and fenced calls pass through the same allowlist. Paths resolve against the assigned project root and are checked for traversal and symlink escapes. This is an application-level boundary, not an operating-system sandbox against concurrent filesystem replacement.

Workers investigate until they can return an evidence-backed deliverable, are stopped, or encounter a failure. Reports contain findings, evidence, next steps, and coverage gaps. A partial report is an internal continuation checkpoint, not a successful final answer. Invalid or truncated responses can be repaired without a fixed repair count. Provider failures surface for the parent to inspect; they do not trigger an automatic provider-fallback or restart loop.

Requests use the model's context window and supported output allowance rather than separate 65,536-token context and 4,096-token response caps. When context needs compaction, the worker retains verified evidence, citations, and remaining work, then continues. Internal checkpoints are not streamed as user-facing partial reports. Compaction notices and tool activity remain visible. Recompression replaces obsolete context before requesting a smaller checkpoint.

Filesystem traversal, individual tool outputs, response transport, and durable records retain safety bounds. Oversized reads and incomplete searches disclose their limits. Reports up to the 4 MiB transport boundary are retained whole; oversized reports fail explicitly rather than silently losing their tail. Reports are paged into the parent context separately.

## History and recovery

Child records use atomic private files under their parent history namespace. Active records are not evicted to make room for settled history. Disk retention keeps the latest 24 settled identities; it does not reject new assignments or remove live-session results. Restored interrupted executions become stopped and never automatically resume. `/clear` and history deletion remove child records; `--no-history` avoids persistence.

A live child retains a private checkpoint of completed messages, native/text tool mode, native IDs and reasoning replay, and pending batch position. There is no separate 1 MiB checkpoint execution cutoff. Checkpoints are excluded from parent snapshots and disk records. Exact recovery resumes from completed-message and pending-operation boundaries; interrupted provider output is discarded and interrupted read-only operations may be retried. Retained evidence reduces repeated work but does not guarantee runtime tool-call deduplication.

Disposal and purge discard exact checkpoints. History recovery uses bounded, redacted persisted evidence within available model context and explicitly discloses that it is not an execution checkpoint. Provider artifacts and unredacted protocol messages are deliberately not persisted. Missing or uncertain evidence must be verified again. Redaction is pattern-based and cannot guarantee detection of every credential.

Snapshots are immutable and cached by run identity. Activity notifications and persistence are throttled; waits subscribe to lifecycle changes. Live pagers release their subscriptions on close. Tool schemas and system instructions remain stable when orchestration toggles; current enablement is appended request context. Children retain independent routing/cache affinity across restarts, without a provider cache-hit guarantee.

## Verification

Regression coverage includes event-driven joins, no model requests during waits, terminal delivery while busy or idle, per-attempt acknowledgments, cancellation and session isolation, provider-sized context and outputs, private compaction, long-report pagination, exact recovery, filesystem confinement, redaction, and both terminal UI adapters. Scripted provider tests verify runtime behavior; they do not establish real-model delegation quality or comparative task success.
