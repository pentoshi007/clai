# REA: Reverse Engineer Anything

clai integrates the official [morluto/rea](https://github.com/morluto/rea) project as an on-demand capability. Use `/rea` in either terminal interface to open its picker.

| Command | Effect |
| --- | --- |
| `/rea install` | Install the latest official `rea-agents` package privately for clai. |
| `/rea setup` | Install if needed and connect clai's managed REA server. |
| `/rea update` | Verify and stage the latest release without interrupting an existing analysis. |
| `/rea use` | Connect if necessary and insert an editable `/rea` token in your draft. |
| `/rea on` | Enable REA for the session without editing the draft. |
| `/rea off` | Stop only clai's managed REA server. |
| `/rea status` | Check installation, connection and maintenance state without starting a server. |
| `/rea reconnect` | Reconnect or adopt an update when it is safe to discard the current analysis connection. |
| `/rea guide` | Show compact workflow guidance and paths to the installed version's detailed references. |
| `/rea <task>` | Submit a task with REA explicitly selected, for example `/rea inspect this Electron app`. |

You can also include `/rea` anywhere in a normal prompt. The token is highlighted in both composers, like MCP and skill mentions. The agent can independently choose REA through `rea.manage` when the task warrants it; no manual activation is required. Installation and agent-initiated state changes use the normal permission policy. Ask/plan mode can inspect status and guidance but cannot install or change REA state.

## Installation without npm or npx

The installer uses clai's existing JavaScript runtime and HTTPS APIs; it does not invoke a shell, Homebrew, curl, PowerShell, tar, unzip, npm or npx from PATH. A compatible existing Node installation with its npm CLI is reused. Otherwise clai downloads an official Node 24 LTS runtime with npm into its private installation. The native compiled clai binary therefore does not require a preinstalled Node toolchain.

Supported portable targets are macOS, Linux and Windows on x64/ARM64, subject to the official Node release's OS/libc support. Linux musl builds are selected separately where officially published; unavailable architectures/builds produce an actionable error, not an incompatible executable. Native engine support is a separate upstream constraint.

Files live under `~/.clai/tools/rea` (or `$CLAI_DATA_DIR/tools/rea`). Node archives are checked against the official SHA-256 manifest; REA/npm tarballs use registry SHA-512 integrity. npm verifies dependency integrity, lifecycle scripts are disabled, and the install uses isolated registry/config/cache settings. Package acquisition requires access to `nodejs.org` and `registry.npmjs.org` as applicable. TLS/registry checksum verification is not an independent publisher-signature guarantee.

A staged release is published only after its launcher reports the expected version. Failures leave the previous release intact. Concurrent maintenance is serialized across processes and deduplicated within a process. Old version directories are retained so running MCP processes are not broken by an update; reconnect explicitly when ready. Setup never changes Claude Code, Codex, other clients' registrations, skills, or the project's MCP configuration.

## Efficient agent use

REA is for shipped artifacts, decompilation, JavaScript/Electron applications, managed assemblies, Android, firmware, saved captures and requested runtime evidence—not ordinary source-repository reading.

Only one small `rea.manage` tool is permanently advertised. Installing does not start a server. Enabling registers `clai-rea` for the current runtime, preserves other selected MCP servers, and connects once. Repeated enables reuse the analysis. The agent searches focused schemas with `mcp.tools` and calls them through `mcp.call`; hundreds of REA tools are not added to the provider's native tool catalog. Large catalogs remain deferred and paginated.

Compact guidance is loaded only on explicit selection, enable, or a guide request. Version-matched detailed workflow references remain on disk for focused reading. Prefer summaries, retained Evidence IDs, selected fields and bounded pages instead of repeating analysis or requesting full results. A host timeout does not establish that server work stopped: inspect state/Evidence before retrying. Inspect the actual current schema or returned remediation rather than guessing arguments or reinstalling.

REA activation never rewrites the stable system prompt, native tool schemas, or prior messages. State and workflow changes enter the append-only conversation context. Cache-prefix regression tests cover installation, activation, discovery, calls, update, reconnect, disable and subsequent composer selection in both native/text tool modes and multiple provider wire formats. Provider cache eviction, compaction and switching providers/models remain independent of this guarantee.

## Optional engines and limits

Static JavaScript, managed-code, metadata and ordinary archive inspection do not require Hopper/Ghidra/IDA. Native decompilation needs a compatible existing provider. Android/JADX, Java, firmware tools, browsers and capture tooling have their own prerequisites and host restrictions; clai does not silently install all engines or execute the target. On Linux, owned-process analysis needs a procps-compatible `ps`. The agent should follow the selected tool's actual prerequisite/remediation and continue useful supported work.

Portable archives and failure cases have deterministic cross-platform fixtures. The implementation was live-tested on Linux ARM64 with REA 6.7.0 and portable Node/npm, including a standalone compiled integration smoke with no system executables on PATH. That smoke bootstrapped Node 24.22.0, discovered 207 tools, performed a digest-bound static analysis and disabled the server without removing the installation. Native Windows/macOS runtime execution requires their CI or real hosts and is not inferred from Linux fixture tests.
