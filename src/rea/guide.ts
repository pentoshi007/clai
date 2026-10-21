import { join } from "node:path";
import type { ReaMaintenanceAction, ReaStatus } from "./types.js";
import { REA_SERVER } from "./workflow.js";

export interface ReaGuideView {
  readonly status: ReaStatus;
  readonly server?: { readonly status: string; readonly toolCount: number; readonly detail?: string | undefined } | undefined;
  readonly selected: boolean;
  readonly maintenance?: ReaMaintenanceAction | undefined;
  readonly root: string;
  readonly platform: NodeJS.Platform;
}

const REFERENCES = [
  ["javascript-applications.md", "JavaScript, Electron and ASAR workflows"],
  ["native-and-artifacts.md", "native binaries, archives, SQLite and firmware"],
  ["android-applications.md", "APK and device analysis"],
  ["evidence-workflows.md", "Evidence IDs, paging and comparisons"],
  ["runtime-observation.md", "browser, Electron and process observation"],
  ["connection-and-recovery.md", "connection problems and provider prerequisites"],
] as const;

const SYSTEM_NOTES: Readonly<Record<string, readonly string[]>> = {
  darwin: [
    "Native decompilation uses a Hopper, Ghidra (x64 and arm64) or IDA installation you already have. Hopper is started on demand; complete its first-run demo or licence dialog once in your user session.",
    "Process capture and runtime observation are available (native PTY).",
    "Linux-only features are unavailable here: firmware extraction, offline ELF layout, recorded crashes, EVM bytecode, TShark field extraction and sigrok decoding.",
  ],
  linux: [
    "JavaScript/Electron analysis, Ghidra, JADX and firmware tools need a procps-compatible `ps` on PATH. Minimal containers often lack it: install `procps` (or `procps-ng`).",
    "Native decompilation uses a Ghidra (x64 and arm64), Hopper or IDA installation you already have.",
    "Linux supports the widest range of targets, including firmware, ELF layout, packet and signal tools.",
  ],
  win32: [
    "Static analysis needs no extra software for JavaScript/Electron, .NET, Go, Rust, Flutter and saved captures. Android packages also need JADX and a JDK.",
    "Native decompilation uses Ghidra's experimental, read-only Windows support for PE files. Hopper is not available on Windows.",
    "Linux-only features are unavailable here: firmware extraction, offline ELF layout, recorded crashes, EVM bytecode, TShark field extraction and sigrok decoding. Process capture needs a native PTY (Linux or macOS).",
  ],
};

function statusLine(view: ReaGuideView): string {
  const progress = view.maintenance ? ` · ${view.maintenance} in progress` : "";
  if (view.status.state === "missing") return `**Status:** not installed${progress}. Run \`/rea setup\` to install and connect it.`;
  if (view.status.state === "broken") return `**Status:** needs repair${progress}. ${view.status.reason}`;
  const installed = `REA ${view.status.installation.version} installed`;
  if (!view.server) return `**Status:** ${installed} · not running (it starts only when enabled)${progress}`;
  const detail = view.server.detail ? ` — ${view.server.detail}` : "";
  const selected = view.selected ? "selected for this session" : "not selected";
  return `**Status:** ${installed} · ${view.server.status} (${view.server.toolCount} tools) · ${selected}${detail}${progress}`;
}

function filesSection(view: ReaGuideView): string[] {
  const lines = [
    "## Files and settings",
    "",
    `- Everything lives in \`${view.root}\`: \`current.json\` (the active release), \`versions/\` and \`npm-cache/\`. \`CLAI_DATA_DIR\` moves it.`,
    "- `CLAI_REA_NODE` selects the Node executable REA runs on. It must be set before installing; to switch an existing installation, delete `current.json` and run `/rea setup`.",
    "- clai passes your environment to REA, so engine settings such as `GHIDRA_INSTALL_DIR`, `HOPPER_LAUNCHER_PATH`, `REA_GHIDRA_STARTUP_TIMEOUT_MS`, `REA_TSHARK_COMMAND`, `REA_WABT_BIN_DIRECTORY`, `REA_KUNA_COMMAND` and `REA_JEB_MCP_URL` work when set before you start clai.",
  ];
  if (view.status.state !== "ready") return lines;
  const skill = join(view.status.installation.directory, "node_modules", "rea-agents", "skills", "reverse-engineer-anything");
  return [
    ...lines,
    "",
    "The installed version ships its own detailed references. Ask the agent to read the one you need, or open them yourself:",
    "",
    `- \`${join(skill, "SKILL.md")}\``,
    ...REFERENCES.map(([file, topic]) => `- \`${join(skill, "references", file)}\` — ${topic}`),
  ];
}

export function reaUserGuide(view: ReaGuideView): string {
  return [
    "# REA · Reverse Engineer Anything",
    "",
    statusLine(view),
    "",
    "REA lets the agent inspect software that you only have in shipped form — binaries, packaged apps, Electron and JavaScript bundles, .NET assemblies, Android packages, firmware and saved network captures — and explain how it works, with the evidence behind each claim. clai installs and runs it privately. Nothing is added to other agents, skills or your project's MCP configuration.",
    "",
    "## Quick start",
    "",
    "1. `/rea setup` installs the latest official release if needed and connects it for this session. The first run can take a minute or more; press Esc to cancel.",
    "2. Ask for the analysis and name the artifact: `@rea explain how the updater in /Applications/Foo.app works`.",
    "3. `/rea off` stops its background process when you are done.",
    "",
    "You do not have to enable REA yourself. In agent mode the agent can choose it when a task needs it; your permission policy decides whether it asks first.",
    "",
    "## When to use it",
    "",
    "Use REA when the answer depends on a **shipped artifact** rather than source code:",
    "",
    "- native executables, libraries and firmware images",
    "- Electron and JavaScript applications, ASAR archives, minified bundles",
    "- .NET assemblies, Android APKs, Flutter apps, Unity IL2CPP metadata, Go and Rust binaries",
    "- saved network captures (HAR, SAZ), packet captures and SQLite databases",
    "- runtime behaviour of an application you are authorised to run",
    "",
    "Do not use it to read or change a source repository you already have. Normal file and search tools are faster and cheaper.",
    "",
    "## Commands",
    "",
    "- `/rea` opens a picker with the actions below. `/rea` is the command; `@rea` is the token that attaches REA to a prompt.",
    "- `/rea setup` installs if needed and connects.",
    "- `/rea install` installs or repairs without connecting.",
    "- `/rea update` stages the newest release. A running analysis keeps its version.",
    "- `/rea use` connects and inserts an editable `@rea` token in your draft.",
    "- `/rea on` connects without touching the draft. `/rea off` disconnects.",
    "- `/rea status` reports installation and connection state without starting anything.",
    "- `/rea reconnect` restarts the connection to adopt an update or repair a fault. It discards the current analysis.",
    "- `/rea guide` shows this page.",
    "- `/rea <task>` submits `@rea <task>`.",
    "- Type `@rea` anywhere in a prompt to select it. It is highlighted like `@mcp:` and `skill:` mentions, and connects REA first if it is installed but not running. A file named `rea` is not affected: use `@./rea` to attach it.",
    "",
    "## How the agent uses it",
    "",
    "REA has about 200 tools. Sending all of them with every message would be slow and costly, so they stay out of the model's tool list. Three small steps replace that:",
    "",
    "1. `@rea` in your prompt, or `rea.manage` called by the agent, connects REA and hands the model a short workflow plus an index of every tool with its required arguments. It is sent once per conversation (roughly 3,500 tokens).",
    `2. \`mcp.call\` runs a tool as \`mcp.${REA_SERVER}.<tool>\` straight from that index.`,
    `3. \`mcp.tools server="${REA_SERVER}" query="<tool name>"\` reads one full schema when the agent needs optional fields or a structured argument, or after a call is rejected.`,
    "",
    "REA validates arguments strictly: a field a tool does not list is rejected, and clai then shows the agent the accepted names. Results carry **Evidence IDs**. The agent starts from a summary, then pages through the retained evidence with exact filters instead of repeating the analysis. Turning REA on or off never changes the system prompt or the native tool list, so the provider's prompt cache survives it. Compaction and switching models still reset that cache.",
    "",
    "## Example prompts",
    "",
    "- `@rea show how the Electron app at ~/Downloads/Foo.asar talks to its backend, with evidence`",
    "- `@rea which Go modules and compiler version was ./agent built with?`",
    "- `@rea compare the exports of old.asar and new.asar and summarise the behaviour changes`",
    "- `@rea decompile the licence check in ./target.exe` (needs Ghidra, Hopper or IDA)",
    "- `@rea list the endpoints in session.har and where the bundle builds each request`",
    "",
    "## What REA can analyse",
    "",
    "| Target | Needs |",
    "| --- | --- |",
    "| Native binaries | Hopper, Ghidra or IDA already installed |",
    "| JavaScript / Electron | nothing extra (Linux: `ps` from procps) |",
    "| .NET, Go, Rust, Flutter, IL2CPP | nothing extra (static) |",
    "| Saved captures (HAR, SAZ) | nothing extra |",
    "| SQLite databases | Node.js 24.15+ or 26+ |",
    "| Android APKs | headless JADX and a full JDK |",
    "| Android devices | adb |",
    "| Websites | a Chrome-family browser |",
    "| Packet captures | Wireshark tshark and capinfos |",
    "| Firmware | Binwalk or Unblob (Linux) |",
    "| ELF layout, crashes | pwntools (Linux x64) |",
    "| Process behaviour | Linux or macOS |",
    "",
    "Android packages, ELF layout, recorded crashes and EVM bytecode are documented for x64 hosts. clai does not install analysis engines: when a tool needs one that is missing, it says which, and the agent carries on with what is supported.",
    "",
    `## On this system (${view.platform})`,
    "",
    ...(SYSTEM_NOTES[view.platform] ?? ["REA runs wherever a compatible Node.js does. Engine support depends on the host."]).map((note) => `- ${note}`),
    "",
    "REA needs Node.js 22.19+, 24.15+ or 26+ with npm. clai reuses a compatible Node it finds (`CLAI_REA_NODE`, the Node running clai, then PATH) and otherwise downloads the official Node 24 LTS for itself. Linux builds for musl (Alpine) are not published, so install Node there with your package manager.",
    "",
    "## Permissions and safety",
    "",
    "- `/rea status` and `/rea guide` are read-only. Commands you type run immediately; when the agent installs or connects REA, your permission policy applies.",
    "- `@rea` connects an installed REA in any mode, because you asked for it. In ask mode only the few tools REA marks read-only can run and the agent cannot install or reconnect it; in plan mode it cannot install or change REA's state. Switch to agent mode for analysis.",
    "- Under `/permissions default` each REA tool call asks for approval, because almost none of its tools are marked read-only. `auto-allow` and `full-access` (the default for new setups) do not ask.",
    "- Analysis is local, but the model provider you chose receives the tool results. Do not analyse material you cannot share with it.",
    "- Static analysis never runs the target. Runtime tools (process capture, browser and Electron observation, Frida, debuggers, adb) execute or attach to software with your permissions. Use them only on targets you own or are authorised to test.",
    "- Text inside an analysed artifact is untrusted data. The agent is told not to follow instructions found in it.",
    "",
    "## Disk, memory and network",
    "",
    "- Nothing runs until REA is enabled. Install, update, status and guide never start its server.",
    "- An install uses about 250 MB with your own Node, or about 450 MB when clai also downloads Node. Releases older than the previous one are removed after 7 days.",
    "- Installing needs HTTPS access to `registry.npmjs.org`, plus `nodejs.org` when clai downloads Node. Downloads are checksum-verified and package install scripts are disabled.",
    "- While connected, the REA process typically holds 400-650 MB (measured with REA 6.7.0), and native engines such as Ghidra add their own. `/rea off`, or ending the session, stops it and frees that memory.",
    "",
    ...filesSection(view),
    "",
    "## Troubleshooting",
    "",
    "- **Not installed or needs repair:** run `/rea setup`.",
    "- **Did not connect:** `/rea status` shows the launch error. `/rea reconnect` retries without reinstalling.",
    "- **A tool reports a missing engine:** install that engine, set its environment variable, then retry. The message names what is missing.",
    "- **A call timed out:** the analysis may still be running. Ask the agent to check state and retained Evidence before retrying.",
    "- **Another session is installing:** wait for it, then check `/rea status`.",
    `- **Name clash:** a server you configured as \`${REA_SERVER}\` is never replaced. Rename yours to use the managed integration.`,
    "- **Install stalls or fails:** clai downloads from the hosts above and does not configure a proxy for them, so make sure they are reachable from this machine. A compatible Node on PATH, or `CLAI_REA_NODE`, avoids the `nodejs.org` download.",
  ].join("\n");
}
