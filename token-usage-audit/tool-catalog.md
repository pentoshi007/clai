# Tool catalog decisions

## Decision: retain capabilities; optimize information density first

There are 47 canonical definitions. The richest audited agent fixture selects 45: it omits `agent.handoff` and `loop.reset`. The non-vision/no-MCP fixture selects 37. Removing unused definitions from source would not save tokens on routes where they are already absent.

No tool removal or merge is approved by this audit. Tool count is not the objective; full-task cost and first-attempt success are. Descriptions may be shortened only in an explicitly versioned candidate after the contract and behavioral gates. Preserve runtime flags and wire names.

## Complete decision inventory

| Family | Tools (canonical names) | Decision and reason |
| --- | --- | --- |
| File read | `fs.read` | Keep single-path and `files` batch modes. Already combines listing, bounded reads and pattern/range selection. Do not add a second read-batch wrapper. |
| File changes | `fs.write`, `fs.writeMany`, `fs.edit`, `fs.replaceLines`, `fs.append`, `fs.delete` | Keep separate contracts. Exact-text edits, line replacement, scaffold writes and deletion have different safeguards. A generic action enum can obscure validation and confirmation. |
| Shell | `shell.exec`, `shell.jobs`, `shell.tail`, `shell.stop`, `shell.wait` | Keep. Finite foreground work, persistent jobs, cursor reads and blocking wait are not interchangeable. Combining them risks accidental reruns or orphaned jobs. |
| Network research/evidence | `http.fetch`, `web.fetch`, `web.search` | Keep all three. Raw protocol evidence, readable public research and search are different success conditions. Search already supports fetching top results. |
| Media | `image.view`, `image.ocr`, `pdf.read` | Keep. Actual pixels, fallback OCR and page-bounded PDF extraction are complementary, including security screenshots/scanned reports. Preserve existing vision-capability routing. |
| Skills/project rules | `skill.load`, `skill.list`, `instructions.record` | Keep. Loading a chosen procedure, discovery and persistent project instructions are different operations; retain scope safeguards. |
| Plan/task | `plan.clear`, `plan.create`, `task.add`, `task.move`, `task.update` | Keep. Their state transitions and dependency semantics are important. Compress repeated prose before considering protocol changes. |
| Responder receipts | `job.read` | Keep. Acknowledges delivered work; `shell.wait` does not replace that lifecycle. |
| MCP | `mcp.list`, `mcp.tools`, `mcp.call`, `mcp.enable`, `mcp.connect`, `mcp.login`, `mcp.add` | Keep fixed controls. External tool catalogs stay discoverable without changing native schemas. Selection, connection, authentication and calls remain distinct. |
| Read-only delegation | `subagent.start`, `subagent.list`, `subagent.read`, `subagent.wait`, `subagent.stop` | Keep capability independent of its current enabled state. Runtime disablement must not prune the established schema prefix. |
| Interactive terminal | `terminal.start`, `terminal.send`, `terminal.read`, `terminal.status`, `terminal.list`, `terminal.close` | Keep. PTY interaction, masked secret input, byte cursors and cleanup cannot be safely replaced by ordinary shell execution. |
| Special flow | `agent.handoff`, `loop.reset` | Preserve supported callers; not selected in these agent fixtures. They are not an agent startup savings opportunity. |

## Largest wire definitions

Single-tool JSON serialization; excludes enclosing array separators. Exact inventory is in [evidence/tool-inventory.csv](evidence/tool-inventory.csv).

| Tool | Wire chars | Estimated tokens | Description-field chars, including JSON keys |
| --- | ---: | ---: | ---: |
| `fs.read` | 4,309 | 1,306 | 3,159 |
| `http.fetch` | 2,687 | 815 | 1,858 |
| `shell.exec` | 2,230 | 676 | 1,811 |
| `plan.create` | 1,892 | 574 | 1,310 |
| `subagent.start` | 1,777 | 539 | 1,455 |
| `web.fetch` | 1,727 | 524 | 1,022 |
| `pdf.read` | 1,461 | 443 | 839 |
| `terminal.send` | 1,460 | 443 | 646 |
| `subagent.read` | 1,293 | 392 | 843 |
| `terminal.start` | 1,127 | 342 | 492 |

A field described twice for top-level and per-file `fs.read` input expands twice on the wire even though the source uses one `FILE_PROPERTIES` object. That expansion is real, but `$ref` is not a safe universal fix: provider schema support/sanitization varies. Do not replace an explicit nested schema without cross-provider acceptance and first-attempt tests.

## Description editing protocol

For each tool, create a compact contract checklist before changing wording:

1. Purpose and when not to use it.
2. Exact parameter names/types and required/optional combinations.
3. Bounds, units, defaults, enums and aliases.
4. Preconditions, permissions and side effects.
5. Completion/failure, partial-result and continuation semantics.
6. One minimal disambiguating example only where it improves first-attempt accuracy.

Assign each fact one primary owner: tool schema for arguments; stable instructions for cross-tool policy; runtime validation for enforcement. Intentional redundancy preventing a demonstrated error is retained. A schema constraint can be cheaper and clearer than prose, but adding/changing it still changes the prefix and needs the version gate.

### Highest-value candidates, conditional on validation

- `plan.create`: shorten verbose category guidance without restricting legitimate categories or weakening acceptance criteria/dependencies; update text-route guidance as needed.
- `subagent.start`, `shell.exec`: remove repetition between global workflow policy and purpose descriptions; retain all availability, background/responder, ownership, timeout and wait distinctions locally where models need them.
- `fs.read`: shorten duplicated property explanations without changing single/multi shape, per-file filters, partial failure handling, byte budgets or continuation instructions. Preserve simple first-attempt examples.
- `web.fetch`: add the actual `maxBytes` bounds to the candidate schema; verify inherited timeout schema enrichment before editing it. Do not infer the emitted schema only from one source file.
- `http.fetch`: shorten wording only after evidence tests prove raw defaults, capture/output distinction, redirect credentials, retries, TLS notes and body hashes remain understandable and correct.

## Why `http.fetch` is not replaced by curl

The current implementation records redirect status/method/header snapshots, decoded raw source, final cookies and captured-body digest, with destination-policy checks and controlled credential forwarding. It preserves evidence on HTTP errors by default rather than silently retrying until a success. Its behavior serves ordinary API debugging and security work.

A `curl -i` command is not an equivalent contract: shell quoting, method/redirect behavior, multiple cookies, decompression, truncation, hashing, artifact paths and secret handling still need implementation. A long shell recipe repeated in context may exceed the schema cost and raise first-attempt errors. Neither the inspected tests nor this audit show that every supported model can reconstruct it reliably.

**Do not remove it.** A future reconsideration would require an explicit owner request, a measured cross-platform/multi-model replacement and all evidence/policy checks—not an assumption that stronger models can use curl.

## If a future tool merge is separately justified

It is out of the default roadmap. A proposal must account for definitions, canonical/wire mappings, handler registry, input validation, tool-history replay, native/text parsing, execution gates, authorization/confirmation, parallel safety, result formatting, UI cards, CLI help, tests and documentation. Search every old name and classify retained historical aliases; never leave a dangling handler or silently break resumed calls.

Preserve the legacy profile and old-history compatibility. Measure total requests and retries, including discovery overhead. Reject a merge that saves schema tokens but requires another model round or creates ambiguous argument combinations. Do not delete the old definition from a currently bound profile.
