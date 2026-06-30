# clai

> A fast, cross-platform AI CLI assistant with `/ask` and `/agent` modes for general shell tasks, file operations, and cybersecurity / pentesting workflows. Free to build, free to run.

## Installation

### macOS

```sh
# Homebrew (recommended)
brew tap pentoshi007/clai
brew install clai

# or via curl
curl -fsSL https://raw.githubusercontent.com/pentoshi007/clai/main/install/install.sh | sh
```

### Linux

```sh
curl -fsSL https://raw.githubusercontent.com/pentoshi007/clai/main/install/install.sh | sh
```

### Windows

```powershell
# PowerShell (recommended)
irm https://raw.githubusercontent.com/pentoshi007/clai/main/install/install.ps1 | iex

# or Scoop
scoop bucket add clai https://github.com/pentoshi007/clai
scoop install clai
```

### Any OS (via npm)

```sh
npm i -g @pentoshi/clai
```

### From Source

```sh
git clone https://github.com/pentoshi007/clai.git
cd clai && npm install && npm run dev
```

After installing, type `clai` in any terminal to start.

## Quick Start

```sh
# Open the full-screen terminal UI (default)
clai

# Frontend selection
clai --tui          # explicitly request the TUI
clai --classic      # start the legacy line-based REPL
CLAI_CLASSIC=1 clai # persistent shell-level opt-out (CLAI_TUI=0 also works)

# One-shot ask mode (explains but doesn't execute)
clai --mode ask "how to create a python venv and install requests"

# One-shot agent mode (executes)
clai --mode agent "find all PDFs larger than 10MB in ~/Documents"

# Auto-confirm tool execution
clai -y "list the 10 largest files in my home directory"
```

### Terminal UI

`clai` launches the full-screen interface by default. It uses the same agent as
the legacy REPL, with a persistent composer, streaming responses, live tool
cards, searchable pickers, secure credential/password prompts, and restorable
session transcripts. Use `clai --classic` when a line-based interface is
required.

In the TUI:

- Type to chat; `Enter` sends. While the agent works you can keep typing — the
  message is queued and sent when the turn finishes.
- `/` opens the command menu (`/ask`, `/agent`, `/model <name>`,
  `/provider <name>`, `/implement`, `/plan`, `/jobs`, `/output`, `/clear`,
  `/think`, `/cwd`, `/allow`, `/context`, `/compact`, `/save`, `/help`, …).
- `@path` attaches files (and images on vision-capable models).
- `Esc` cancels the running turn · `Ctrl+T` expand/collapse thinking ·
  `Ctrl+O` view full tool output · `Ctrl+P` view the plan · `Ctrl+J` jobs panel
  · `Ctrl+C` twice to exit.
- `Up`/`Down` browse submitted prompts; reaching the newest entry restores the
  draft. Use `PageUp`/`PageDown` or `Ctrl+U`/`Ctrl+D` to scroll the transcript.
- Provider, model, variant, and history pickers filter as you type.
- `/compact` shows active progress and asks the selected model to turn the full
  session—prompts, reasoning, plans, commands, outputs, results, completed
  tasks, failures, and remaining work—into compact continuation memory. That
  memory replaces older model context while the eight newest messages remain
  verbatim. If the provider is unavailable, a local deterministic fallback is
  used.
- `/history` restores user prompts, assistant responses, thinking, tool calls,
  and tool outputs for sessions saved by v1.2.9 or newer.

If the terminal is not interactive or is too small, clai falls back to the
classic REPL automatically.

## Features

- **`/ask` mode** — Read-only. AI explains, gives commands & step-by-step guidance, but does NOT execute anything.
- **`/agent` mode** — Agentic. AI plans, waits for approval, then executes shell commands, edits files, installs missing tools, parses output, and continues until the goal is met. Tasks run on an approve/refine/discard plan workflow (`/implement`, free-text to refine, `/discard` to cancel).
- **11 LLM providers** — Groq, Google Gemini, OpenRouter, OpenAI, Anthropic, NVIDIA NIM, AgentRouter, Kimchi, AWS Mantle, Ollama (local), and Bynara. All with streaming.
- **10 built-in tools** — `shell.exec`, `fs.read`, `fs.write`, `fs.list`, `fs.search`, `pkg.install`, `net.scan`, `http.fetch`, `sysinfo`, `pentest.recon`.
- **Smart safety gate** — Read-only commands auto-execute; mutating commands require confirmation; destructive patterns are blocked.
- **OS-aware & tool-frugal** — Picks the best approach for your OS, prefers tools already installed (installs only when nothing suitable exists), broadens its approach and escalates privileges as needed to finish the task.
- **Cross-platform** — macOS, Linux, and Windows. Detects OS-native package managers (brew, apt, dnf, pacman, winget, choco).
- **Pentest-aware** — nmap, nikto, sqlmap, gobuster, ffuf, hydra, masscan, whois, dig, netcat, tshark.
- **Auto-update** — Checks for new versions on startup; run `/update` or `clai update` to upgrade.
- **Persistent history** — Full transcript restoration with automatic secret
  redaction, including thinking and tool activity.
- **Context compaction** — Model-generated continuation memory with recent-turn
  preservation and an offline fallback.
- **Modern terminal UI by default** — Boxed session header, searchable pickers,
  cancellable tools, secure prompts, full-output pager, and queued messages.

## Provider Setup

clai supports 11 LLM providers (9 with free tiers):

| Provider    | Default Model                                | Free? | API Key Prefix |
|-------------|----------------------------------------------|-------|----------------|
| Groq        | `llama-3.3-70b-versatile`                    | ✓     | `gsk_`         |
| Gemini      | `gemini-2.0-flash`                           | ✓     | `AIza`         |
| OpenRouter  | `meta-llama/llama-3.3-70b-instruct:free`     | ✓     | `sk-or-`       |
| OpenAI      | `gpt-4o-mini`                                | —     | `sk-`          |
| Anthropic   | `claude-3-5-haiku-latest`                    | —     | `sk-ant-`      |
| NVIDIA NIM  | `openai/gpt-oss-20b`                         | ✓     | `nvapi-`       |
| AgentRouter | `gpt-5`                                      | —     | `sk-`          |
| Kimchi      | `kimi-k2.6`                                  | ✓     | (any)          |
| AWS Mantle  | `anthropic.claude-haiku-4-5`                 | —     | `sk-ant-`      |
| Ollama      | `llama3.1:8b`                                | ✓     | (local URL)    |
| Bynara      | `mimo-v2.5-free`                             | ✓     | `sk_nry_`      |

```sh
# Store an API key
clai set groq gsk_xxxxxxxxxxxxxxxx

# Import from environment variable
clai set gemini --from-env GEMINI_API_KEY

# Read from stdin (safer — avoids shell history)
echo "gsk_xxx" | clai set groq --stdin

# Set Ollama endpoint
clai set ollama --url http://localhost:11434

# List configured providers (keys masked)
clai keys

# Switch active provider
clai use groq

# Interactive provider picker
clai provider

# Remove a key
clai unset groq
```

### Environment Variable Overrides

Runtime env vars override stored keys:

```sh
export GROQ_API_KEY=gsk_...
export GEMINI_API_KEY=AIza...
export OPENROUTER_API_KEY=sk-or-...
export OPENAI_API_KEY=sk-...
export ANTHROPIC_API_KEY=sk-ant-...
export NVIDIA_API_KEY=nvapi-...
export CASTAI_API_KEY=...
export ANTHROPIC_WORKSPACE_ID=default  # optional, for AWS Mantle
export OLLAMA_HOST=http://localhost:11434
```

## REPL Commands

| Command                 | Action                                             |
|-------------------------|--------------------------------------------------  |
| `/ask`                  | Switch to ask mode                                 |
| `/agent`                | Switch to agent mode                               |
| `/model`                | Open interactive model picker (type/↑/↓, Tab fills, Enter selects) |
| `/model <name\|#>`      | Switch model by name or number (e.g. `/model 2`)   |
| `/provider [name]`      | Switch provider or open interactive picker          |
| `/use <provider>`       | Alias for `/provider <name>`                       |
| `/set <provider> [key]` | Store API key (masked input if key omitted)        |
| `/unset <provider>`     | Remove stored key                                  |
| `/keys`                 | List configured providers, masked                  |
| `/info [provider]`      | Show details & usage plan for a provider           |
| `/variants [on|off|low|medium|high]` | Toggle model thinking/reasoning variants |
| `/think`                | Show hidden thinking from last response            |
| `/output [last|id|list]`| Toggle full saved tool output                      |
| `/clear`                | Clear conversation context                         |
| `/new`                  | Save current session & start fresh                 |
| `/history`              | Browse & resume past sessions (interactive picker) |
| `/save <name>`          | Save current session                               |
| `/reset`                | Clear all saved history                            |
| `/cwd <path>`           | Change working directory                           |
| `/allow <tool>`         | Whitelist a tool for the session                   |
| `/plan`                 | View the current session plan (also `Ctrl+P`)      |
| `/implement`            | Approve the current plan and have clai execute it  |
| `/discard`              | Discard the current plan so later messages ignore it |
| `/scope add <targets>`  | Add authorized pentest targets                     |
| `/fallback [on|off]`    | Try other configured providers after a failure     |
| `/update`               | Check for updates                                  |
| `/exit`                 | Quit                                               |
| `/help`                 | List commands                                      |
| `Ctrl+C`                | Abort current response (second Ctrl+C exits)       |
| `Ctrl+O`                | Toggle full tool output (same keys on all OSes)    |
| `Ctrl+P`                | View the current session plan                      |

### Plan → Implement workflow

For multi-step coding or pentest tasks, clai first proposes a **plan** (a goal,
an approach, and an ordered task checklist) and then waits. Nothing runs until
you approve it.

- **Approve** — type `/implement` to execute the plan task by task.
- **Refine** — type any normal message (e.g. "use only installed tools",
  "skip task 2", "also enumerate subdomains") and clai produces a **revised
  plan**, then waits again. While a plan is awaiting approval, free-text is
  treated as plan feedback, not as a signal to start running.
- **Cancel** — type `/discard` to drop the plan. After discarding, later
  messages are independent of it.

## Built-in Tools (Agent Mode)

| Tool             | Description                                                        | Risk Level |
|------------------|--------------------------------------------------------------------|------------|
| `shell.exec`     | Run shell commands via execa (120s timeout, streams output)        | smart*     |
| `fs.read`        | Read files (sandboxed to approved roots)                           | safe       |
| `fs.write`       | Write files (sandboxed)                                            | confirm    |
| `fs.list`        | List directory contents                                            | safe       |
| `fs.search`      | Search files with ripgrep (falls back to grep)                     | safe       |
| `pkg.install`    | Install packages via detected OS package manager                   | confirm    |
| `net.scan`       | Nmap wrapper. Defaults to a stealth SYN scan, auto-elevates (sudo/doas/gsudo) and falls back to an unprivileged TCP connect scan | confirm    |
| `http.fetch`     | HTTP GET/POST with response size limits                            | safe       |
| `sysinfo`        | OS, architecture, shell, and working directory info                | safe       |
| `pentest.recon`  | Composite: whois + dig + stealth nmap top-100 ports               | confirm    |

> \* **smart** = read-only commands (`curl`, `ls`, `whoami`, `gobuster`, `dirb`, etc.) auto-execute; mutating commands require confirmation.

## Web tools

Two higher-level tools sit alongside `http.fetch` for agent-driven web reading:

- **`web.search`** — query the public web through a configurable search provider and return structured `{title, url, snippet}` hits. Default provider is **DuckDuckGo** (keyless, works out of the box). **Brave Search** and **Tavily** are supported when an API key is configured. Use this for current-events or post-cutoff information; the agent prompt steers `web.search` toward time-sensitive questions and `web.fetch` toward reading a known URL.
- **`web.fetch`** — fetch a URL and return readable prose (HTML stripped of `<script>`/`<style>`/chrome) plus rich metadata: response headers, TLS session details (cipher, peer cert SAN list, fingerprint), redirect chain, fine-grained timing, resolved IP. Sensitive headers and cookie values are redacted by default; pass `redactSensitive=false` to expose them in the *output* (the audit log never carries them). Loopback / RFC1918 / link-local / cloud-metadata addresses are blocked by SSRF checks at every redirect hop, with DNS rebinding defeated by IP-pinning the connection to the resolved address.

### Search provider configuration

```sh
# Set a key for Brave or Tavily (DuckDuckGo is keyless and is a no-op).
clai set brave bsx-xxxxxxxxxxxxxxxx
clai set tavily tvly-xxxxxxxxxxxxxxxx

# Remove a stored key.
clai unset brave

# Switch the active search provider used by web.search.
clai search-provider tavily

# List configured keys (LLM and search) with the same masking rule.
clai keys
```

Environment variables override stored keys at call time:

| Provider     | Env var                  |
|--------------|--------------------------|
| Brave Search | `BRAVE_SEARCH_API_KEY`   |
| Tavily       | `TAVILY_API_KEY`         |
| DuckDuckGo   | (none, keyless)          |

## Safety Gate

Every tool call passes through a 3-tier classifier:

- **`safe`** — Auto-run: read-only fs, sysinfo, http.fetch, read-only shell commands (`curl`, `ls`, `whoami`, `ifconfig`, `gobuster`, `dirb`, `ffuf`, `nikto`, etc.)
- **`confirm`** — User prompt: mutating shell commands, fs.write, pkg.install, net.scan
- **`block`** — Refuse with explanation: `rm -rf /`, fork bombs, public IP scans without authorization, exfiltration patterns

### Pentest Authorization

Security tools require a one-time acknowledgment:

```sh
clai authorize-pentest AGREE
```

Public targets do not require a stored scope, but keeping one helps clai remember what you are authorized to test. Add targets with:

```sh
clai scope add --targets example.com,10.0.0.0/24
```

Inside the REPL, use `/scope add example.com`. If the agent proposes a public recon target that is not covered, clai shows a scope suggestion and still lets you continue through the normal confirmation flow.

## Updates

clai checks for updates automatically on startup (every 4 hours, non-blocking). You can also check manually:

```sh
# CLI command
clai update

# Inside the REPL
/update
```

## Diagnostics

```sh
clai doctor
```

Outputs: OS, shell, architecture, config paths, provider key status, available pentest tools with install commands for missing ones.

## Per-Project Context

Create a `.clai/context.md` file in your project root to automatically inject project context into every prompt:

```md
This is a Node.js project using Express and PostgreSQL.
The API server runs on port 3000.
```

## Configuration

Configuration is stored at `~/.config/clai/config.json` (varies by OS):

```sh
clai config        # Print config path and settings
clai mode agent    # Set default mode
clai model llama-3.3-70b-versatile  # Set model
```

## Development

```sh
npm install        # Install dependencies
npm run dev        # Run in development mode
npm run typecheck  # Type check
npm run build      # Build TypeScript
npm test           # Run tests (39 tests)
npm run compile    # Build native binaries (requires Bun)
```

## Releasing

Releases are fully automated by `.github/workflows/release.yml`, triggered when
you push a `v*.*.*` tag. To cut a release:

```sh
npm version 1.0.6 --no-git-tag-version   # bump package.json + lockfile
# also bump: src/commands/update.ts (FALLBACK_VERSION),
#            manifests/homebrew/clai.rb, manifests/scoop/clai.json
git commit -am "v1.0.6"
git push origin main
git tag -a v1.0.6 -m "clai v1.0.6"
git push origin v1.0.6                   # this triggers the workflow
```

On the tag push the workflow:

1. **build** — runs typecheck + tests and compiles native binaries for all platforms.
2. **publish** — creates the GitHub Release with the binaries and SHA256 sidecars.
3. **publish-npm** — publishes `@pentoshi/clai` to npm.
4. **sync-tap** — regenerates the Homebrew formula in `pentoshi007/homebrew-clai`.

> **Reruns don't pick up newer workflow code.** Re-running a workflow runs it
> against the commit the tag points to. If you change `release.yml` after
> tagging, you must move/recreate the tag (or cut a new version) for the change
> to take effect.

Required repository secrets (Settings → Secrets and variables → Actions). Each
job skips gracefully if its secret is absent:

| Secret             | Used by       | How to create                                                                 |
|--------------------|---------------|-------------------------------------------------------------------------------|
| `NPM_TOKEN`        | `publish-npm` | npm → Access Tokens → **Granular** (Read and write on `@pentoshi/clai`) or classic **Automation** token. These bypass the interactive OTP prompt that blocks CI. |
| `TAP_GITHUB_TOKEN` | `sync-tap`    | A GitHub PAT with `contents:write` on the `pentoshi007/homebrew-clai` repo     |

Optional repository **variable** (not a secret):

| Variable         | Effect                                                                          |
|------------------|---------------------------------------------------------------------------------|
| `NPM_PROVENANCE` | Set to `true` to publish with `--provenance`. Only works if the npm account's 2FA is set to **"authorization only"**. Leave unset otherwise — the job publishes without provenance. |

The `publish-npm` job verifies the tag matches `package.json` version and skips
if that version is already on npm, so re-running a tag is safe.

> A normal account with 2FA set to **"auth and writes"** prompts for a one-time
> password on every publish, which fails in CI. Use a Granular/Automation
> `NPM_TOKEN` (token-level auth) so CI can publish without an OTP — you can keep
> 2FA enabled on the account.

## Architecture

```
clai/
├─ src/
│  ├─ index.ts              # CLI entry, argv parsing via commander
│  ├─ repl.ts               # Interactive REPL with readline
│  ├─ modes/
│  │   ├─ ask.ts            # Read-only mode (no tool execution)
│  │   └─ agent.ts          # Agentic mode (tool execution)
│  ├─ agent/
│  │   └─ runner.ts         # Agent loop: LLM → parse → classify → execute → loop
│  ├─ llm/
│  │   ├─ provider.ts       # Provider interface & utilities
│  │   ├─ router.ts         # Provider selection & fallback chain
│  │   ├─ http.ts           # OpenAI-compatible HTTP client
│  │   ├─ groq.ts           # Groq provider (streaming)
│  │   ├─ gemini.ts         # Gemini provider (streaming)
│  │   ├─ ollama.ts         # Ollama provider (streaming)
│  │   ├─ openai.ts         # OpenAI provider (streaming)
│  │   ├─ anthropic.ts      # Anthropic provider (streaming)
│  │   ├─ nvidia.ts         # NVIDIA NIM provider (streaming)
│  │   └─ openrouter.ts     # OpenRouter provider (streaming)
│  ├─ tools/
│  │   ├─ registry.ts       # Tool dispatch table
│  │   ├─ shell.ts          # shell.exec via execa
│  │   ├─ fs.ts             # Sandboxed file operations
│  │   └─ http.ts           # HTTP fetch tool
│  ├─ safety/
│  │   ├─ classifier.ts     # 3-tier risk classification
│  │   └─ patterns.ts       # Destructive & exfiltration regexes
│  ├─ os/
│  │   ├─ detect.ts         # OS/arch/shell detection
│  │   └─ pkgmgr.ts         # Package manager detection
│  ├─ store/
│  │   ├─ config.ts         # Persistent config via `conf`
│  │   ├─ history.ts        # Session history
│  │   ├─ keys.ts           # Keychain + fallback key storage
│  │   ├─ logs.ts           # Audit log with rotation
│  │   └─ project.ts        # Per-project context loader
│  ├─ commands/
│  │   ├─ doctor.ts         # System diagnostics
│  │   ├─ update.ts         # Auto-update checker
│  │   └─ providers.ts      # Provider management commands
│  └─ prompts/
│      └─ index.ts          # Prompt template renderer
├─ bin/clai.mjs             # ESM shebang launcher
├─ scripts/build.ts         # Bun compile per target
├─ .github/workflows/
│   └─ release.yml          # CI: build + publish binaries on tag
├─ manifests/
│   ├─ homebrew/clai.rb     # Homebrew formula
│   └─ scoop/clai.json      # Scoop manifest
├─ install/
│   ├─ install.sh           # macOS/Linux curl installer
│   └─ install.ps1          # Windows PowerShell installer
├─ package.json
├─ tsconfig.json
└─ README.md
```

## License

MIT
