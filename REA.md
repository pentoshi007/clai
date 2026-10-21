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
| `/rea engines` | Show which analysis engines (Ghidra, Hopper, IDA, Kuna) are ready on this machine and the exact command that fixes each one that is not. |
| `/rea engines install ghidra` | After a confirmation, download the official Ghidra release and make it usable by REA. |
| `/rea engines install java` | After a confirmation, install a private JDK 21 for REA's server when Java is what is missing. |
| `/rea engines use <engine> <location>` | Use an installation you already have: a Ghidra folder, a JDK home, the Hopper launcher, an IDA MCP registration file or a Kuna executable. |
| `/rea engines remove <engine>` | Forget an engine; clai asks before deleting anything it installed. |
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

On `@rea`, on enable and on a `guide` request the model receives, once per conversation, a workflow of about 4,200 characters, an `ENGINE:` line and a version-matched index generated from the live catalog: every tool name, grouped by verb, with its required arguments, `~` where the tool accepts `detail` and `!` where it changes state or the target (about 8,300 characters for REA 6.7.0's 207 tools, bounded at 10,000). The index lets the agent call tools directly; `mcp.tools` with an exact tool name returns just that tool's full schema for optional fields and structured arguments. REA schemas are strict, so an argument a tool does not list is rejected and clai appends the accepted argument names to the error. The context is sent once per conversation: later turns that repeat `@rea` reuse it, and it is sent again, once, only if it changed (for example after you install an engine and reconnect).

So that the agent does not call tools that cannot work, clai asks REA once per connection (one `binary_session` call, about 2 seconds and 50 KB, not repeated) which tools need an open target, an analysis engine or a missing prerequisite, and marks the index: `#` acts on the binary opened by `open_binary` and takes no path, `^` also needs an analysis engine, `%` is unavailable on this machine. The `ENGINE:` line says which engines are ready. When a call still fails, clai replaces REA's long machine-readable error with a short instruction: pass no `path` to a `#` tool and call `open_binary` first; thin a universal Mach-O to one slice with `lipo` before Ghidra or Kuna can read it; or, when no engine is ready, do not retry and tell the user to run `/rea engines`. If the availability report cannot be read, the plain index is used. Repeating `enable` on a live connection returns it again on request, without restarting anything. The always-advertised `rea.manage` description is kept to about 450 characters because it is sent with every request. The long human-oriented usage guide is shown only by `/rea guide` and is never sent to the model. Version-matched detailed workflow references remain on disk for focused reading. Prefer summaries, retained Evidence IDs, selected fields and bounded pages instead of repeating analysis or requesting full results. A host timeout does not establish that server work stopped: inspect state/Evidence before retrying. Inspect the actual current schema or returned remediation rather than guessing arguments or reinstalling.

REA activation never rewrites the stable system prompt, native tool schemas, or prior messages. State and workflow changes enter the append-only conversation context. Cache-prefix regression tests cover installation, activation, discovery, calls, update, reconnect, disable and subsequent composer selection in both native/text tool modes and multiple provider wire formats. Provider cache eviction, compaction and switching providers/models remain independent of this guarantee.

## Analysis engines

Static JavaScript and Electron inspection, managed (.NET) assemblies, archives, Mach-O headers, plists, signatures and metadata need no engine. Native decompilation (procedures, pseudocode, strings, cross-references, assembly) needs one of Ghidra, Hopper, IDA or Kuna, and REA does not ship any of them.

Engines are installed by you, never by the agent. `/rea engines` shows what is ready and what to run, and `/rea setup` points at it when it connects REA with no engine ready. `install` shows what it will download and where it will write (press `ctrl+o` for the full plan), asks for confirmation, shows progress and can be cancelled with Esc; `remove` asks before deleting anything clai installed. The agent's workflow tells it not to install or configure an engine and to send you to `/rea engines` instead, and `rea.manage` has no engine action. Only one engine operation runs at a time. If REA is connected and idle when an install finishes, clai reconnects it so the new engine is used straight away; the engine is verified with REA before the install is reported as done.

| System | `install ghidra` | `install java` |
| --- | --- | --- |
| macOS arm64 and x64 | Yes. Ghidra does not ship a macOS decompiler, so clai builds it once (about a minute; needs the Xcode Command Line Tools). | Yes |
| Linux x64 | Yes; the decompiler is in the download. | Yes (glibc) |
| Linux arm64 | Yes; builds the decompiler once (needs make, g++ and bison). | Yes (glibc) |
| Windows x64 | Yes; the decompiler is in the download. REA's Windows Ghidra support is experimental upstream. | Yes |
| Anything else (Windows arm64, Alpine and other musl Linux, 32-bit) | Not offered; `/rea engines` says so and why. Use `/rea engines use ghidra <folder>` with your own installation. | Not offered for musl; use `/rea engines use java <JDK home>` |

Hopper is a commercial macOS and Linux application and Kuna is not available on Windows; clai does not install either. IDA needs your own installation and an MCP registration file. These are connected with `/rea engines use`. Android, firmware, capture and similar tools (JADX, apktool, binwalk, tshark and others) have their own prerequisites; `/rea engines` lists the ones that block tools on your machine with the fix REA reports, and clai does not install them.

What `install ghidra` does:

- Resolves the newest Ghidra 12.1.x release on GitHub (the series REA 6.7.0 needs) and refuses to continue unless GitHub publishes a SHA-256 for the download. Downloads are HTTPS only, limited to `github.com`, `*.githubusercontent.com`, `api.github.com` and `api.adoptium.net`, with every redirect re-checked, a size limit and a 60-second stall guard.
- Checks free disk space first (about 570 MB to download, 1.6 GB while installing and 900 MB afterwards), extracts the archive itself (no `unzip`), and rejects absolute paths, `..`, symlinks, encrypted or ZIP64 entries and checksum mismatches.
- Builds the native decompiler where needed with `make` using at most four jobs, with a 30-minute limit. It checks for the build tools before downloading anything and tells you what to install.
- Stages everything in a temporary folder, moves it into `~/.clai/tools/ghidra/<version>` only when it is complete, then asks REA whether Ghidra is usable. A failed or cancelled install leaves nothing behind and keeps the previous version; after a successful one, older versions that clai installed are removed.

Ghidra also needs a JDK 21 or newer. `install ghidra` does not change your system Java: if REA reports that Java is missing or too old, clai offers `install java`, which puts Eclipse Temurin 21 (about 200 MB, SHA-256 verified) in `~/.clai/tools/jdk/` and uses it for REA's server only.

Settings live in `~/.clai/tools/rea/engines.json` (mode 0600; `$CLAI_DATA_DIR/tools/rea` if set). They are passed to REA's server as `GHIDRA_INSTALL_DIR`, `JAVA_HOME`, `HOPPER_LAUNCHER_PATH`, `REA_IDA_MCP_CONFIG` and `REA_KUNA_COMMAND`; a variable already set in your environment always wins. Reconnect REA (`/rea reconnect`) after changing them yourself.

Ghidra and Kuna cannot open universal (fat) Mach-O files such as most system binaries on macOS. The agent is told to thin one slice into the session scratch directory with `lipo <file> -thin <arch> -output <scratch>/<name>-<arch>` (`llvm-lipo` when `lipo` is missing) and open that. Hopper opens universal files directly.

## Limits

clai does not execute the target. On Linux, owned-process analysis needs a procps-compatible `ps`. The agent follows the selected tool's actual prerequisite or remediation and continues with supported work.

Portable archives and failure cases have deterministic cross-platform fixtures. The implementation was live-tested on Linux ARM64 with REA 6.7.0 and portable Node/npm, including a standalone compiled integration smoke with no system executables on PATH. That smoke bootstrapped Node 24.22.0, discovered 207 tools, performed a digest-bound static analysis and disabled the server without removing the installation.

The engine installers were run for real on macOS arm64 only: Ghidra 12.1.4 with its decompiler build and a Temurin 21 JDK were installed, REA reported both ready, and a thinned Mach-O slice was decompiled. Measured there, the 543 MB Ghidra download and install peaked at about 260 MB of memory in clai's process with about 33 seconds of CPU (the rest was waiting for the network and the build), 900 MB on disk afterwards; the 200 MB JDK peaked at about 250 MB and used 336 MB on disk. Linux and Windows behavior of the installers is covered by unit tests and by CI, not by a live installation. Native Windows and macOS runtime execution of REA itself requires their CI or real hosts and is not inferred from Linux fixture tests.
