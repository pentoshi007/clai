# clai

> A fast, terminal-native AI agent that runs real tools — built to run on **free API tiers**, stay alive across rate limits with **multi-key + multi-provider switching**, and do serious work: **building, debugging, and scope-based pentesting / bug bounty**.

`clai` is an agentic CLI. It doesn't just describe what to do — it edits files, runs shell commands, scans hosts, fetches HTTP evidence, keeps a durable task plan, and verifies its own work before claiming success. It runs in your terminal with three full surfaces — an OpenTUI full-screen console (default on macOS/Linux), a classic Ink UI (default on Windows), and a noninteractive stream renderer for prompts and pipes. Every interactive surface is a full-screen app sharing the same features, commands, and session state.

Two things make it practical for everyday use:

- **It's cheap-to-free to run.** A fresh install runs **keyless out of the box** on the built-in Free provider — no signup, no API key. Point it at DeepSeek, Kimi, GLM, MiniMax, Gemini, NVIDIA NIM, OpenRouter, OpenAI, Anthropic, or run completely offline with local Ollama. Add multiple keys per provider; when one hits a rate limit, it rotates to the next automatically.
- **It's honest.** Findings need real tool output. Builds get typechecked/run before "done." Compaction and history keep long sessions coherent instead of hallucinating progress.

---

## Highlights

- **Free-tier first.** Built-in **keyless Free** gateway (`free-2/kilo-auto/free`) so a fresh install runs at no cost with zero setup — no API key required.
- **Multi-key smart switching.** Up to 10 keys per provider with a *sticky* active key and circular rotation on rate-limit, quota, transient, or 5xx errors. Disable any key to skip it without deleting it. Optional cross-provider fallback and a free-only filter.
- **Broad provider support.** Native support for DeepSeek, Kimi (Moonshot), GLM (Zhipu AI), MiniMax, OpenAI, Anthropic, Google Gemini, Ollama, NVIDIA NIM, OpenRouter, Qwen, and custom OpenAI-compatible endpoints.
- **Scope-based pentesting.** Opt-in engagement scope with authorized/excluded targets, allowed phases, rate and concurrency ceilings, redirect and DNS-rebinding escape detection, and out-of-scope flagging — designed for authorized pentests and bug-bounty programs.
- **Real building & debugging.** Scaffolds apps, edits code surgically, installs packages, runs builds/tests, starts dev servers as background jobs, and probes them before reporting success.
- **Durable plans.** `plan.create` / `task.update` drive a live checklist that survives context compaction and reloads with `/history` — the agent works task-by-task and won't fake completion.
- **Durable agent sessions.** Interactive sessions run behind a local broker, so an agent keeps working after `/minimise`, an SSH disconnect, or switching to another history session; `clai --resume <id>` reattaches to the same live UI and output stream.
- **Persistent interactive terminals.** Conversation-owned PTY or pipe sessions keep REPLs such as Python, Metasploit, Meterpreter, database consoles, and debuggers open across model turns.
- **Native + text tool calling.** Uses provider-native function calling where available, with a text-fence fallback (`toolCalling: auto|native|text`).
- **MCP, explicitly controlled.** Discovers local stdio and remote HTTP/SSE servers from project configs. MCP tools are off by default; `/mcp` inspects and adds servers, and picking one drops an editable `@mcp:<server>` token into your prompt.
- **Safety gate you control.** Every action is classified safe / confirm / block; deletes always confirm with a preview; destructive patterns are blocked.

---

## Install

### macOS
```sh
brew tap pentoshi007/clai && brew install clai
# or
curl -fsSL https://downloads.clai.aniketpandey.website/install/install.sh | sh
```

### Linux
```sh
curl -fsSL https://downloads.clai.aniketpandey.website/install/install.sh | sh
```

### Windows
```powershell
irm https://downloads.clai.aniketpandey.website/install/install.ps1 | iex
# or
scoop bucket add clai https://github.com/pentoshi007/clai && scoop install clai
```

### npm / from source
```sh
npm i -g @pentoshi/clai
# or
git clone https://github.com/pentoshi007/clai.git
cd clai && npm install && npm run build && npm start
```

Node.js ≥ 22. Type `clai` in any terminal to start.

> **Tip for Linux users:** For the best mouse and hover support in the full-screen TUI, modern GPU-rendered terminals like **Kitty**, **Alacritty**, or **WezTerm** are recommended. On macOS, **iTerm2** and the default Terminal work out of the box.

---

## Quick start

Out of the box, `clai` runs **keyless** on the built-in Free provider — no signup, no API key:

```sh
clai          # launch the full-screen agent console (already on the free provider)
```

Prefer a different provider? Set your key and start:

```sh
# Add an API key (DeepSeek shown; Gemini, OpenAI, Anthropic, Kimi, etc. work the same)
clai set deepseek sk-your_key_here
clai use deepseek

# Launch the full-screen agent console
clai

# Or one-shot directly from the shell
clai "explain what this repo does and find the entrypoint"
clai --mode agent "add a /health endpoint to the Express app and run the tests"
```

Prefer fully local and offline? Point at Ollama:

```sh
clai set ollama --url http://localhost:11434
clai use ollama
```

---

## Providers & Key Management

### Supported Providers

| Provider | Default Model | Tier | Environment Variable |
|----------|---------------|------|----------------------|
| **Free (keyless)** | `free-2/kilo-auto/free` | Free · Keyless | — (no key needed) |
| **DeepSeek** | `deepseek-chat` | Paid / Usage | `DEEPSEEK_API_KEY` |
| **Kimi (Moonshot)** | `moonshot-v1-auto` | Paid / Usage | `KIMI_API_KEY` / `MOONSHOT_API_KEY` |
| **GLM (Zhipu AI)** | `glm-4-flash` | Free tier / Paid | `GLM_API_KEY` / `ZHIPU_API_KEY` |
| **MiniMax** | `MiniMax-Text-01` | Paid / Usage | `MINIMAX_API_KEY` |
| **Google Gemini** | `gemini-2.5-flash` | Free tier / Paid | `GEMINI_API_KEY` |
| **NVIDIA NIM** | `openai/gpt-oss-20b` | Free tier | `NVIDIA_API_KEY` |
| **OpenRouter** | `meta-llama/llama-3.3-70b-instruct:free` | Free / Paid | `OPENROUTER_API_KEY` |
| **Ollama** | `llama3.1:8b` | Local / Free | `OLLAMA_HOST` |
| **OpenAI** | `gpt-5.4-mini` | Paid | `OPENAI_API_KEY` |
| **Anthropic** | `claude-3-5-haiku-latest` | Paid | `ANTHROPIC_API_KEY` |
| **Qwen Cloud** | `qwen3.7-plus` | Paid (DashScope) | `DASHSCOPE_API_KEY` |
| **Bynara** | `mimo-v2.5-free` | Free | `BYNARA_API_KEY` |
| **Hetzner** | `Qwen/Qwen3.6-35B-A3B-FP8` | Free (experiment) | `HETZNER_API_KEY` |

Model lists for all providers are fetched dynamically from their respective APIs. You can switch models anytime using `/model` or `clai model <name>`.

### Manage Keys

```sh
clai set deepseek sk-first_key         # store a key
clai set deepseek sk-second_key        # add another key for multi-key rotation
clai set gemini --from-env GEMINI_API_KEY
echo "sk-..." | clai set deepseek --stdin
clai set ollama --url http://localhost:11434
clai keys                              # list providers with masked keys (★ active)
clai use deepseek                      # set active provider
clai provider                          # interactive provider/model selector
clai unset deepseek                    # remove keys for a provider
```

In the interactive console:
- **`/set`** opens the multi-row key editor. Add keys (`+`), set the active key (★), or disable a key (`○`) without deleting it.
- **`/keys`** displays configured keys (masked) and active status.
- **`/provider`** and **`/model`** open interactive pickers for switching providers and models on the fly.

### Smart Switching & Resilience

- **Multi-key rotation** — Store up to **10 keys per provider**. The last key that worked is *sticky*. On encountering a rate limit (HTTP 429), quota limit, auth error, or 5xx server error, `clai` automatically rotates to the next available key.
- **Disable without deleting** — Toggle any key disabled in the `/set` editor; rotation skips it until you re-enable it.
- **Cross-provider fallback** *(opt-in)* — `/fallback on` lets `clai` fall back to other configured providers when the active provider is exhausted.
- **Free-only mode** *(opt-in)* — `/freeonly on` restricts fallback strictly to free tiers so you never accidentally spend.

---

## What clai is good at

### Building & debugging

The same agent that runs recon also ships code. It explores before it writes, matches your existing stack from lockfiles, edits surgically, and proves the result:

- Scaffolds and extends apps; replaces starter boilerplate with real features.
- Surgical file tools: `fs.edit`, `fs.replaceLines`, `fs.append`, plus multi-file writes.
- Runs the checks that apply — typecheck, build, unit/integration tests — and fixes failures before claiming success.
- Starts dev servers as background jobs, tails until ready, probes `localhost`, and reports the URL / port / job id with the server left running.
- Debugging loop: reproduce → read the actual error → fix root cause → re-verify.

```sh
clai --mode agent "convert this Vite React app to Next.js App Router, keep all features, run the build"
clai --mode agent "this test is flaky — find the race and fix it"
```

### Scope-based pentesting & bug bounty

`clai` is built to run real, authorized security work — not to narrate it. It follows a recon-first methodology and keeps you inside the boundaries you set.

```
recon / discovery  →  fingerprint stack  →  plan.create (kind=pentest)
        ↑                      │
        │              /implement (approve)
        │                      ↓
        └──── enumerate → exploit → post-ex → report
              (revise the plan as surface grows; keep completed tasks)
```

1. **Authorize once**, then optionally **define scope** — authorized targets, exclusions, allowed phases, rate/concurrency ceilings, and an expiry.
2. **Recon first** (read-only discovery needs no plan): whois, DNS, `net.scan`, `net.context`, `http.fetch`, `pentest.recon`, and shell tools like `nmap`, `ffuf`, `nuclei`, `sqlmap`.
3. **Analyze real evidence**, then `plan.create` with `kind=pentest` from actual ports/services/endpoints — then stop for your approval.
4. `/implement` and execute task-by-task; expand the plan as new attack surface appears without wiping completed work.
5. **Report** with structure — title, severity, evidence, reproduction, impact, remediation — and honest residual/untested notes.

**Scope enforcement is real, not cosmetic.** When scope is active, `clai` checks each target against your authorized/excluded lists, enforces token-bucket rate limits and a concurrency ceiling, detects **redirects that leave scope** and **DNS-rebinding escapes**, and flags out-of-scope hosts instead of touching them.

```sh
clai authorize-pentest AGREE
clai scope new --targets lab.example.com,10.10.0.0/24 --exclude prod.example.com \
  --phases recon,enumeration --max-rate 5 --max-concurrency 2
# in the console: /scope show · /scope add <targets> · /scope clear
```

Dedicated recon tools: `pentest.recon` (bundled whois/dns/nmap), `pentest.webDiscover` (scoped path discovery), `pentest.apiEnumerate` (OpenAPI/Swagger), `pentest.authCompare` (auth-context diffing), `pentest.scanStatus` (durable scan checkpoints).

### General security & sysadmin workflows

Log triage, config hardening, packaging, network analysis, OCR of a screenshot or PDF report, quick OSINT — all handled by the same agent under the same safety gate.

---

## Modes & reasoning

Three modes, switchable anytime with a slash command, `Shift+Tab`, or `clai --mode`:

| Mode | Use |
|------|-----|
| **ask** | Answers, methodology, and read-only tools — no mutations, no attacks. |
| **agent** | Executes: edits, installs, scans, verifies, works the plan. |
| **plan** | Research and design a durable plan; approve with `/implement` before execution. |

**Reasoning / thinking** is controlled with `/effort` (alias `/reasoning`), accepting `on`, `off`, `none`, `minimal`, `low`, `medium`, `high`, or `xhigh`. `clai` sends reasoning options only to models that support them.

---

## Safety gate

You own authorization; `clai` gates risk on every action:

| Level | Behavior |
|-------|----------|
| **safe** | Auto-runs read-only work: `fs.read/list/search`, `sysinfo`, `dns.lookup`, `whois.lookup`, `http.fetch` GET, `web.search`/`web.fetch`, recon scanners. |
| **confirm** | Asks first for mutations: file writes/edits, installs, moves, mutating shell commands. |
| **block** | Refuses destructive patterns (`rm -rf /`, fork bombs, exfiltration signatures) and SSRF-prone fetches. |

`fs.delete` always confirms (with an optional diff preview) even under allow-all. Use `/permissions` to choose the confirmation level and `/allow` / `/disallow` for a per-session tool allow-list.

---

## Terminal UI

The interactive console provides streaming chat, nested tool cards, file diffs, a live plan pane, pickers, session history, and masked key prompts.

| Action | Key |
|--------|-----|
| Send / newline | `Enter` / `Shift+Enter` |
| Abort turn (keeps results) | `Esc` |
| Interrupt / quit | `Ctrl+C` (twice to quit) |
| Cycle mode (ask→agent→plan) | `Shift+Tab` |
| Plan pane / plan detail | `Ctrl+H` / `Ctrl+P` |
| Background jobs | `Ctrl+J` |
| Expand thinking / tool output | `Ctrl+T` / `Ctrl+O` |
| Copy focused thinking block | `c` |
| Search transcript | `Ctrl+R` |
| Copy selection | `Ctrl+Shift+C` |
| Commands / file mentions | `/` · `@` |
| MCP servers / project config | `/mcp` |
| Command help / shortcut reference | `Ctrl+G` / `/shortcuts` |

- **Thinking blocks:** Clickable `✦ Thought for 3.2s` rows open internal reasoning in a scrollable card (`Ctrl+T`). Pressing `c` copies the reasoning text.
- **Tool cards:** Show running commands with live elapsed timers, status indicators, and expandable output pagers (`Ctrl+O`) with search and copy capabilities.
- **File diffs:** Edits and writes render clean inline diff previews before changes take effect.

### Background sessions, minimise, and SSH reattach

Interactive sessions run behind a local broker so an agent continues working across terminal disconnects:

- **`/minimise`** (or `/minimize`) detaches immediately and returns you to your shell without interrupting the turn. It displays the session ID and resume command.
- **SSH disconnects:** If an SSH session drops, reconnect and run `clai --resume <id>` (or `clai -c` to continue the latest session in the current directory).
- **`/history`** lists all active, attached, and detached sessions.

---

## Slash commands

| Command | Does |
|---------|------|
| `/ask` · `/agent` · `/plan` | Switch mode (plan = design-then-approve) |
| `/implement` · `/discard` | Approve and execute or drop the current plan |
| `/model [name]` · `/provider [name]` | Select model / switch provider |
| `/set [provider]` · `/unset [provider]` · `/keys` | Manage API keys and view provider configuration |
| `/effort [level]` · `/reasoning [level]` | Configure thinking / reasoning effort |
| `/freeonly [on\|off]` · `/fallback [on\|off]` | Free-only filter · cross-provider fallback |
| `/search [provider]` · `/search-provider` | Choose web-search backend |
| `/mcp [...]` | Browse, configure, start, or stop MCP servers |
| `/scope [show\|add\|new\|clear]` | Manage engagement scope |
| `/output [last\|id\|list]` | Open full tool output pager (also `Ctrl+O`) |
| `/jobs` | View background jobs (also `Ctrl+J`) |
| `/compact` · `/context` | Compact history now · show context token size |
| `/history` · `/save <name>` · `/new` · `/clear` | Session lifecycle management |
| `/allow <tool>` · `/disallow <tool>` · `/permissions` | Tool permission management |
| `/cwd <path>` | Change working directory |
| `/think` · `/thinking` | Show thinking from the last response |
| `/privacy [...]` | Private mode · clear history, logs, or artifacts |
| `/minimise` · `/minimize` | Detach terminal while the session runs in background |
| `/update` · `/help` · `/shortcuts` · `/exit` | Utilities and exit |

---

## CLI commands

```sh
clai [prompt...]                       # interactive UI, or one-shot with a prompt
  --mode <ask|agent|plan>  --provider <p>  --model <m>
  -y/--yes  --no-history
  --show-thinking  --verbose  --quiet    # one-shot stream controls
  --tui  --classic
  --resume <sessionId>  -c/--continue    # reattach live or reopen saved session

clai set <provider> [key]              # --from-env <VAR> | --stdin | --url <url>
clai unset <provider>                  # remove all keys for a provider
clai keys                              # list providers with masked keys
clai use <provider>                    # set active provider
clai provider [provider]               # switch provider or open picker
clai model <model>                     # set model for the active provider
clai mode <ask|agent|plan>             # set default mode
clai search-provider <brave|tavily|duckduckgo>
clai config [key] [value]              # view or update configuration
clai doctor                            # check installed tools + provider config
clai history [--show <id>]             # list saved sessions
clai update                            # check for updates and upgrade
clai authorize-pentest AGREE           # enable scan/attack tools (one-time ack)
clai scope <show|new|add|clear>        # engagement scope management
clai privacy <status|on|off|clear-all> # privacy and history clearing
```

---

## Model Context Protocol (MCP)

`clai` can discover and call tools from local or remote MCP servers. MCP tools are **off by default**; they are activated when a prompt mentions `@mcp:<server>` or via `/mcp all`.

### Project configuration

Define MCP servers in `.clai/mcp.json` (or standard `.vscode/mcp.json` / `.cursor/mcp.json` locations):

```json
{
  "servers": {
    "local": {
      "command": "my-mcp-server",
      "args": ["--root", "${workspaceFolder}"],
      "env": {
        "MCP_TOKEN": "${env:MCP_TOKEN}"
      }
    },
    "remote": {
      "url": "https://mcp.example.com/mcp",
      "headers": {
        "Authorization": "Bearer ${env:MCP_TOKEN}"
      }
    }
  }
}
```

Use `/mcp` inside the interactive console to browse servers, inspect available tools, view logs, restart connections, or add new servers interactively.

---

## Built-in tools

| Group | Tools |
|-------|-------|
| **Files** | `fs.read` · `fs.list` · `fs.search` · `fs.write` · `fs.writeMany` · `fs.edit` · `fs.replaceLines` · `fs.append` · `fs.delete` |
| **Shell & jobs** | `shell.exec` · `shell.start` · `shell.jobs` · `shell.tail` · `shell.stop` · `pkg.install` |
| **Network** | `net.scan` (nmap) · `net.context` · `net.pingSweep` · `dns.lookup` · `whois.lookup` |
| **HTTP / web** | `http.fetch` (raw evidence) · `web.search` · `web.fetch` (readable) |
| **Pentest** | `pentest.recon` · `pentest.webDiscover` · `pentest.apiEnumerate` · `pentest.authCompare` · `pentest.scanStatus` |
| **Orchestration** | `tool.batch` (up to 20 calls, `on_fail` policies) · `tool.check` · `wordlist.find` |
| **Plan** | `plan.create` · `task.update` · `agent.handoff` |
| **Context** | `sysinfo` · `image.ocr` · `pdf.read` |

---

## Web search / OSINT

| Provider | Key | Environment Variable |
|----------|-----|----------------------|
| **DuckDuckGo** | None (default) | — |
| **Brave** | Required | `BRAVE_SEARCH_API_KEY` |
| **Tavily** | Required | `TAVILY_API_KEY` |

```sh
clai set brave bsx-...
clai set tavily tvly-...
clai search-provider tavily
```

---

## Per-project context

Drop a `.clai/context.md` in any project root, and its content is injected automatically on every turn — repo architecture, stack conventions, testing instructions, or scope rules.

---

## Interactive REPLs and terminals

When a task requires multi-step interactive terminal interactions, `clai` maintains a persistent terminal session attached to the conversation:

```text
Start a Python REPL, test the regular expression against our test cases, and show me the output.
```

The agent runs interactive commands in persistent PTY sessions, reads incremental output, sends follow-up commands, and safely terminates processes upon completion.

---

## Configuration & privacy

```sh
clai config                # view current config
clai mode agent            # set default mode
clai model <name>          # set default model
/privacy on                # private mode: don't persist this session
/privacy clear-all         # wipe history, logs, and artifacts
```

Config is stored locally in your OS user directory (e.g. `~/.config/clai/`). Keys are stored locally and never exposed in plain text.

---

## Development

```sh
npm install
npm run dev          # run from source
npm run typecheck
npm run build
npm test             # full test suite
npm run compile      # compile native binaries with Bun
```

---

## Architecture

```
clai/
├─ src/
│  ├─ index.ts          # CLI entry + subcommands
│  ├─ agent/            # loop, plans, compaction, resume orientation, tool parsing
│  ├─ llm/              # providers, streaming, native tools, key rotation + fallback
│  ├─ mcp/              # discovery, validation, transports, lifecycle, and tool dispatch
│  ├─ tools/            # fs, shell, net, http, web, pentest, batch, plan
│  ├─ safety/           # risk classifier + engagement (scope) policy
│  ├─ store/            # config, history, keys, plans, scope
│  ├─ ui-core/         # renderer-neutral state, actions, layout, rendering, and ports
│  ├─ classic/         # React + Ink classic UI and POSIX terminal bootstrap
│  ├─ tui-v2/           # OpenTUI full-screen renderer
│  ├─ noninteractive/   # stdout/stderr-split one-shot stream renderer
│  ├─ app/              # session controllers, commands, events, and ports
│  └─ prompts/          # agent methodology (embedded for the compiled binary)
├─ install/ · manifests/
└─ package.json
```

---

## License

MIT.

**Use only on systems you are authorized to test.** clai is an operator's tool: authorization, scope, and impact are yours. The agent executes with the gates and confirmations you configure — nothing more.
