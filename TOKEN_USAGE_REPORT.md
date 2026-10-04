# Token overhead changes

Branch: `perf/remove-shell-redundant-tools`. This change starts at `66b699a8`, after the first token optimization. The original pre-optimization baseline is `dbc5bcf8` (`v4.12.1`).

Five shell-redundant wrappers and their implementations, schemas, aliases, routing, rendering and instruction references have been removed. The remaining catalog contains 47 definitions; the configured NVIDIA `openai/gpt-oss-20b` agent route exposes 37 tools. HTTP fetching is byte-identical to the preceding version.

## Savings from this removal

These are controlled request-assembly estimates using `ceil(characters / 3.3)`, excluding provider framing. They are not provider-reported or billed token counts, and do not convert the reported 17k baseline into an exact saving. The long-task example adds approximately 5,000 characters of requirements.

| Request | Before estimate | After estimate | Difference |
| --- | ---: | ---: | ---: |
| Default native, short task | 21,780 | 21,308 | 472 fewer (2.16%) |
| Default native, long task | 23,310 | 22,839 | 471 fewer (2.02%) |
| Compact native, short task | 13,587 | 12,992 | 595 fewer (4.38%) |
| Full text tools, short task | 15,747 | 15,736 | 11 fewer (0.07%) |
| Compact text tools, short task | 3,809 | 3,889 | 80 more (2.12%) |

Default native schemas shrink from 33,829 to 31,544 characters: approximately 693 estimated tokens. Replacement shell guidance adds 729 characters, bringing the net reduction to 1,556 characters, or approximately 472 estimated tokens. Two removed wrappers were already excluded from the default route, so their schemas do not contribute to its saving.

Compact text has no attached native schema to shrink. Its explicit search and executable-check instructions cost more than the removed names. This increase is retained to explain correct searches and prevent additional discovery calls or ambiguous tool use.

## Combined savings since the original baseline

| Request | Original estimate | Final estimate | Difference |
| --- | ---: | ---: | ---: |
| Default native, short task | 23,507 | 21,308 | 2,199 fewer (9.36%) |
| Default native, long task | 28,099 | 22,839 | 5,260 fewer (18.72%) |
| Compact native, short task | 12,924 | 12,992 | 68 more |
| Full text tools, short task | 17,173 | 15,736 | 1,437 fewer (8.37%) |
| Compact text tools, short task | 3,864 | 3,889 | 25 more |

The first optimization removed duplicate task text and the repeated mode execution contract from full constitutions. It also corrected incomplete compact catalogs. The final compact native request still includes complete schemas for all permitted tools, which explains its small increase over the original incomplete catalog.

## Replacement behavior

- Cross-file searches use foreground `shell.exec` with ripgrep, grep or PowerShell. Instructions cover literal/PCRE patterns, quoted globs, leading-dash patterns, bounded paths, batching and no-match exit status. Existing shell handling treats grep/ripgrep exit 1 as a successful empty observation and preserves genuine failures, including through RTK.
- `fs.read` retains its existing directory listing implementation, sorting, hidden entries and default 500-entry limit. Its `limit` argument caps directory entries. File paging and edit validation are unchanged.
- Executable paths and versions, wordlist discovery and LAN discovery use batched OS-appropriate shell commands. Guidance includes project-local binaries, package/binary name differences and ARP cache limitations.
- Recognized read-only local shell calls can run alongside independent reads in one response. Mutating or unrecognized shell calls retain sequential execution. Read-only classification preserves completed-observation and task-preflight behavior.
- Ask mode keeps local search through a restricted foreground shell schema and command classifier. Scripts, writes, network commands and jobs require agent mode. Child research tools retain their shell interface.
- Remaining tool argument types, required fields, limits and permission flags are unchanged. Only file read/edit descriptions were updated to explain the replacements. There are no compatibility aliases advertising removed tools.

## Plans, compaction and cache behavior

Plan-mode instructions, accepted-plan detail, task acceptance criteria, summary budgets and the compaction system prompt are unchanged. Two compaction receipt examples now say "routine local inspection"; all summary requirements, sections and retention rules remain. Baseline hash checks cover the protected prompts, and a large-plan test verifies that full detail and acceptance criteria reach the model at a small input budget.

All permitted tools remain visible through complete native schemas or the complete text-route name list. No lazy discovery step is introduced. Schema selection remains independent of input-budget changes, and the initial compact/full choice stays pinned per provider/model for the session.

Changing the installed tool catalog necessarily establishes a new cache prefix when the upgraded version starts. Within an agent session, the system and schema prefixes remain stable through model rounds, budget changes and delivery/recovery messages under the existing capability rules. Existing conversation history is not rewritten to erase historical calls. Compaction retains its existing history replacement protocol.

The native-loop integration fixture performs parallel shell search/read, then a surgical edit and final response in three model rounds with three successful tool calls. It checks CRLF preservation, unrelated content, zero tool errors and unchanged system/schema prefixes. Ask research uses one local search call followed by its answer without a discovery round.

## Validation

- `node scripts/run-tests.mjs`: 8,236 passed, 14 skipped, zero failures across 780 files (779 passed, one skipped).
- Final shell-classifier and consumer checks: 93 passed across six files after tightening output-writing options. Updated protocol/rendering fixtures: 181 passed across seven files.
- `npm run build`: passed, including TypeScript compilation and prompt embedding.
- Measurement/evaluation scripts: passed the repository's strict TypeScript options.
- `node scripts/embed-prompts.mjs --check`: passed.
- `node dist/index.js --version`: `4.12.1`.
- Retained schema-contract comparison and HTTP byte comparison: passed.
- Removed-reference audit includes tracked source, tests, documentation, CI and rebuilt distribution.
- No code comments added.

Earlier live experiments rejected broader prompt rewrites when tool calls or model rounds increased. Their limited comparison budget was consumed before the final implementation. This removal has been measured offline and exercised through repository tests; it has not received a separate live parity comparison. The fixtures establish their covered invariants and do not prove identical stochastic model behavior on every task.

## Reproduce

Offline measurement requires no model calls:

```sh
node --import tsx scripts/measure-token-overhead.ts /path/to/baseline-checkout
```

Use `66b699a8` for this removal or `dbc5bcf8` for the combined comparison. Both checkouts need the repository dependencies available.
