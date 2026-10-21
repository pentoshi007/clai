# REA: Reverse Engineer Anything

clai integrates the official [morluto/rea](https://github.com/morluto/rea) project as an on-demand capability. Use `/rea` in either terminal interface to open its picker.

| Command | Effect |
| --- | --- |
| `/rea install` | Install the latest official `rea-agents` package privately for clai. |
| `/rea setup` | Install if needed and connect clai's managed REA server. |
| `/rea update` | Verify and stage the latest release without interrupting an existing analysis. |
| `/rea use` | Connect if necessary and insert an editable `@rea` token in your draft. |
| `/rea on` | Enable REA for the session without editing the draft. |
| `/rea off` | Stop only clai's managed REA server. |
| `/rea status` | Check installation, connection and maintenance state without starting a server. |
| `/rea reconnect` | Reconnect or adopt an update when it is safe to discard the current analysis connection. |
| `/rea guide` | Open the usage guide in a markdown pager: commands, how the agent uses REA, supported targets and prerequisites for your OS, permissions, resource use and troubleshooting. |
| `/rea <task>` | Submit `@rea <task>`, for example `/rea inspect this Electron app`. |

`/rea` is the command that opens these options; `@rea` is the token that attaches REA to a prompt. Type `@rea` anywhere in a normal prompt. The token is highlighted in both composers, like `@mcp:` and skill mentions, and is never treated as a file (attach a file that is really named `rea` as `@./rea`). When a turn contains `@rea`, clai connects an installed REA before the model is called and gives the model the workflow and the tool index described below; if REA is not installed, the model is told to run `rea.manage action=setup`. The agent can also choose REA through `rea.manage` when the task warrants it; no manual activation is required. Installation and agent-initiated state changes use the normal permission policy. Ask/plan mode can inspect status and guidance but cannot install or change REA state.

## Installation without npm or npx

The installer uses clai's existing JavaScript runtime and HTTPS APIs; it does not invoke a shell, Homebrew, curl, PowerShell, tar, unzip, npm or npx from PATH. A compatible existing Node installation with its npm CLI is reused, looked up in this order: `CLAI_REA_NODE`, the Node that is running clai, then `node` on PATH. Otherwise clai downloads an official Node 24 LTS runtime with npm into its private installation. The native compiled clai binary therefore does not require a preinstalled Node toolchain.

A compatible Node is 22.19+, 24.15+ or 26+ (upstream REA also accepts 24.11 to 24.14, but SQLite inspection needs 24.15+ or 26+). `CLAI_REA_NODE` must point at the `node` executable and is read when REA is installed; to move an existing installation to a different Node, remove `current.json` and run `/rea setup`. Installation is cancellable with Esc from either interface, and a download is abandoned after 60 seconds without data rather than after a fixed total time, so slow links can finish.

Supported portable targets are macOS, Linux and Windows on x64/ARM64, subject to the official Node release's OS/libc support. nodejs.org does not publish Linux musl builds (Alpine), so install Node with the system package manager there. Unavailable architectures/builds produce an error that names the required Node versions and `CLAI_REA_NODE`, not an incompatible executable. Native engine support is a separate upstream constraint.

Files live under `~/.clai/tools/rea` (or `$CLAI_DATA_DIR/tools/rea`). Node archives are checked against the official SHA-256 manifest; REA/npm tarballs use registry SHA-512 integrity. npm verifies dependency integrity, lifecycle scripts are disabled, and the install uses isolated registry/config/cache settings. Package acquisition requires access to `nodejs.org` and `registry.npmjs.org` as applicable. TLS/registry checksum verification is not an independent publisher-signature guarantee.

A staged release is published only after its launcher reports the expected version, and the pointer file is replaced atomically (retrying briefly on Windows when another process holds it). Failures leave the previous release intact. Concurrent maintenance is serialized across processes and deduplicated within a process; a second clai session that waits too long is told that another session is installing. The current and previous releases are always kept so running MCP processes are not broken by an update; reconnect explicitly when ready. Releases older than that, including leftovers from interrupted installs, are removed once they are seven days old. An install takes about 250 MB with an existing Node and about 450 MB when clai also downloads one (the npm cache is shared across releases). Setup never changes Claude Code, Codex, other clients' registrations, skills, or the project's MCP configuration.

## Efficient agent use

REA is for shipped artifacts, decompilation, JavaScript/Electron applications, managed assemblies, Android, firmware, saved captures and requested runtime evidence—not ordinary source-repository reading.

Only one small `rea.manage` tool is permanently advertised. Installing does not start a server. Enabling registers `clai-rea` for the current runtime, preserves other selected MCP servers, and connects once. Repeated enables reuse the analysis. REA's tools are not added to the provider's native tool catalog; the agent calls them through `mcp.call`.

On `@rea`, on enable and on a `guide` request the model receives, once per conversation, a workflow of about 3,500 characters and a version-matched index generated from the live catalog: every tool name, grouped by verb, with its required arguments, `~` where the tool accepts `detail` and `!` where it changes state or the target (about 8,000 characters for REA 6.7.0's 207 tools, bounded at 10,000). The index lets the agent call tools directly; `mcp.tools` with an exact tool name returns just that tool's full schema for optional fields and structured arguments. REA schemas are strict, so an argument a tool does not list is rejected and clai appends the accepted argument names to the error. The context is sent once per conversation: later turns that repeat `@rea` reuse it. Repeating `enable` on a live connection returns it again on request, without restarting anything. The always-advertised `rea.manage` description is kept to about 450 characters because it is sent with every request. The long human-oriented usage guide is shown only by `/rea guide` and is never sent to the model. Version-matched detailed workflow references remain on disk for focused reading. Prefer summaries, retained Evidence IDs, selected fields and bounded pages instead of repeating analysis or requesting full results. A host timeout does not establish that server work stopped: inspect state/Evidence before retrying. Inspect the actual current schema or returned remediation rather than guessing arguments or reinstalling.

REA activation never rewrites the stable system prompt, native tool schemas, or prior messages. State and workflow changes enter the append-only conversation context. Cache-prefix regression tests cover installation, activation, discovery, calls, update, reconnect, disable and subsequent composer selection in both native/text tool modes and multiple provider wire formats. Provider cache eviction, compaction and switching providers/models remain independent of this guarantee.

## Optional engines and limits

Static JavaScript, managed-code, metadata and ordinary archive inspection do not require Hopper/Ghidra/IDA. Native decompilation needs a compatible existing provider. Android/JADX, Java, firmware tools, browsers and capture tooling have their own prerequisites and host restrictions; clai does not silently install all engines or execute the target. On Linux, owned-process analysis needs a procps-compatible `ps`. The agent should follow the selected tool's actual prerequisite/remediation and continue useful supported work.

Portable archives and failure cases have deterministic cross-platform fixtures. The implementation was live-tested on Linux ARM64 with REA 6.7.0 and portable Node/npm, including a standalone compiled integration smoke with no system executables on PATH. That smoke bootstrapped Node 24.22.0, discovered 207 tools, performed a digest-bound static analysis and disabled the server without removing the installation. Native Windows/macOS runtime execution requires their CI or real hosts and is not inferred from Linux fixture tests.
