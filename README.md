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
# Open interactive REPL
clai

# One-shot ask mode (explains but doesn't execute)
clai --mode ask "create a python venv and install requests"

# One-shot agent mode (executes)
clai --mode agent "find all PDFs larger than 10MB in ~/Documents"

# Auto-confirm tool execution
clai -y "list the 10 largest files in my home directory"
```

## Features

- **`/ask` mode** — Read-only. AI explains, gives commands & step-by-step guidance, but does NOT execute anything.
- **`/agent` mode** — Agentic. AI plans, then executes shell commands, edits files, installs missing tools, parses output, and continues until the goal is met.
- **7 LLM providers** — Groq, Google Gemini, OpenRouter, OpenAI, Anthropic, NVIDIA NIM, and Ollama (local). All with streaming.
- **10 built-in tools** — `shell.exec`, `fs.read`, `fs.write`, `fs.list`, `fs.search`, `pkg.install`, `net.scan`, `http.fetch`, `sysinfo`, `pentest.recon`.
- **Smart safety gate** — Read-only commands auto-execute; mutating commands require confirmation; destructive patterns are blocked.
- **Cross-platform** — macOS, Linux, and Windows. Detects OS-native package managers (brew, apt, dnf, pacman, winget, choco).
- **Pentest-aware** — nmap, nikto, sqlmap, gobuster, ffuf, hydra, masscan, whois, dig, netcat, tshark.
- **Auto-update** — Checks for new versions on startup; run `/update` or `clai update` to upgrade.
- **Persistent history** — Session history with automatic key redaction in logs.

## Provider Setup

clai supports 8 LLM providers (7 with free tiers):

| Provider    | Default Model                                | Free? | API Key Prefix |
|-------------|----------------------------------------------|-------|----------------|
| Groq        | `llama-3.3-70b-versatile`                    | ✓     | `gsk_`         |
| Gemini      | `gemini-2.0-flash`                           | ✓     | `AIza`         |
| OpenRouter  | `meta-llama/llama-3.3-70b-instruct:free`     | ✓     | `sk-or-`       |
| OpenAI      | `gpt-4o-mini`                                | —     | `sk-`          |
| Anthropic   | `claude-3-5-haiku-latest`                    | —     | `sk-ant-`      |
| NVIDIA NIM  | `openai/gpt-oss-20b`                         | ✓     | `nvapi-`       |
| AgentRouter | `gpt-5`                                      | —     | `sk-`          |
| Ollama      | `llama3.1:8b`                                | ✓     | (local URL)    |

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
export OLLAMA_HOST=http://localhost:11434
```

## REPL Commands

| Command                 | Action                                             |
|-------------------------|--------------------------------------------------  |
| `/ask`                  | Switch to ask mode                                 |
| `/agent`                | Switch to agent mode                               |
| `/model`                | List available models for current provider (numbered) |
| `/model <name\|#>`      | Switch model by name or number (e.g. `/model 2`)   |
| `/provider [name]`      | Switch provider or open interactive picker          |
| `/use <provider>`       | Alias for `/provider <name>`                       |
| `/set <provider> [key]` | Store API key (masked input if key omitted)        |
| `/unset <provider>`     | Remove stored key                                  |
| `/keys`                 | List configured providers, masked                  |
| `/variants [on|off|low|medium|high]` | Toggle model thinking/reasoning variants |
| `/think`                | Show hidden thinking from last response            |
| `/output [last|id|list]`| Toggle full saved tool output                      |
| `/clear`                | Clear conversation context                         |
| `/history`              | Show past sessions                                 |
| `/save <name>`          | Save current session                               |
| `/cwd <path>`           | Change working directory                           |
| `/allow <tool>`         | Whitelist a tool for the session                   |
| `/scope add <targets>`  | Add authorized pentest targets                     |
| `/fallback [on|off]`    | Try other configured providers after a failure     |
| `/update`               | Check for updates                                  |
| `/exit`                 | Quit                                               |
| `/help`                 | List commands                                      |
| `Ctrl+C`                | Abort current response (second Ctrl+C exits)       |
| `Ctrl+O`                | Toggle full tool output (same keys on all OSes)    |

## Built-in Tools (Agent Mode)

| Tool             | Description                                                        | Risk Level |
|------------------|--------------------------------------------------------------------|------------|
| `shell.exec`     | Run shell commands via execa (120s timeout, streams output)        | smart*     |
| `fs.read`        | Read files (sandboxed to approved roots)                           | safe       |
| `fs.write`       | Write files (sandboxed)                                            | confirm    |
| `fs.list`        | List directory contents                                            | safe       |
| `fs.search`      | Search files with ripgrep (falls back to grep)                     | safe       |
| `pkg.install`    | Install packages via detected OS package manager                   | confirm    |
| `net.scan`       | Nmap wrapper for port scanning                                     | confirm    |
| `http.fetch`     | HTTP GET/POST with response size limits                            | safe       |
| `sysinfo`        | OS, architecture, shell, and working directory info                | safe       |
| `pentest.recon`  | Composite: whois + dig + nmap top-100 ports                       | confirm    |

> \* **smart** = read-only commands (`curl`, `ls`, `whoami`, `gobuster`, `dirb`, etc.) auto-execute; mutating commands require confirmation.

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
