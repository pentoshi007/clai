# clai

> A fast, cross-platform AI CLI assistant with `/ask` and `/agent` modes for general shell tasks, file operations, and cybersecurity / pentesting workflows. Free to build, free to run.

## Features

- **`/ask` mode** — Read-only. AI explains, gives commands & step-by-step guidance, but does NOT execute anything.
- **`/agent` mode** — Agentic. AI plans, then executes shell commands, edits files, installs missing tools, parses output, and continues until the goal is met.
- **6 LLM providers** — Groq, Google Gemini, OpenRouter, OpenAI, Anthropic, and Ollama (local). All with streaming support.
- **10 built-in tools** — `shell.exec`, `fs.read`, `fs.write`, `fs.list`, `fs.search`, `pkg.install`, `net.scan`, `http.fetch`, `sysinfo`, `pentest.recon`.
- **Safety gate** — 3-tier classifier (`safe` / `confirm` / `block`) with destructive pattern detection, public IP scan blocking, and exfiltration guards.
- **Cross-platform** — macOS, Linux, and Windows. Detects OS-native package managers (brew, apt, dnf, pacman, winget, choco).
- **Pentest-aware** — nmap, nikto, sqlmap, gobuster, ffuf, hydra, masscan, whois, dig, netcat, tshark integration with authorization gates.
- **Persistent history** — SQLite with JSONL fallback. Automatic key redaction in logs.

## Installation

```sh
# npm (any platform — requires Node.js ≥ 20)
npm i -g clai

# macOS (Homebrew)
brew tap pentoshi007/clai
brew install clai

# Linux / macOS (curl)
curl -fsSL https://raw.githubusercontent.com/pentoshi007/clai/main/install/install.sh | sh
```

```powershell
# Windows (PowerShell)
irm https://raw.githubusercontent.com/pentoshi007/clai/main/install/install.ps1 | iex

# Windows (Scoop)
scoop bucket add clai https://github.com/pentoshi007/clai
scoop install clai
```

```sh
# From source
git clone https://github.com/pentoshi007/clai.git
cd clai && npm install && npm run dev
```

## Quick Start

```sh
# Open interactive REPL
clai

# One-shot ask mode
clai --mode ask "create a python venv and install requests"

# One-shot agent mode
clai --mode agent "find all PDFs larger than 10MB in ~/Documents"

# With auto-confirm for agent mode
clai -y "list the 10 largest files in my home directory"
```

## Provider Setup

clai supports 6 LLM providers with free tiers:

| Provider    | Default Model                                | Free? | API Key Prefix |
|-------------|----------------------------------------------|-------|----------------|
| Groq        | `llama-3.3-70b-versatile`                    | ✓     | `gsk_`         |
| Gemini      | `gemini-2.0-flash`                           | ✓     | `AIza`         |
| OpenRouter  | `meta-llama/llama-3.3-70b-instruct:free`     | ✓     | `sk-or-`       |
| OpenAI      | `gpt-4o-mini`                                | —     | `sk-`          |
| Anthropic   | `claude-3-5-haiku-latest`                    | —     | `sk-ant-`      |
| Ollama      | `llama3.1:8b`                                | ✓     | (local URL)    |

```sh
# Store an API key
clai set groq gsk_xxxxxxxxxxxxxxxx

# Import from environment variable
clai set gemini --from-env GEMINI_API_KEY

# Read from stdin (safer for shell history)
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
export OLLAMA_HOST=http://localhost:11434
```

## REPL Commands

| Command                 | Action                                             |
|-------------------------|----------------------------------------------------|
| `/ask`                  | Switch to ask mode                                 |
| `/agent`                | Switch to agent mode                               |
| `/model <name>`         | Switch LLM model                                   |
| `/provider [name]`      | Switch provider or open interactive picker          |
| `/use <provider>`       | Alias for `/provider <name>`                       |
| `/set <provider> [key]` | Store API key (masked input if key omitted)        |
| `/unset <provider>`     | Remove stored key                                  |
| `/keys`                 | List configured providers, masked                  |
| `/clear`                | Clear conversation context                         |
| `/history`              | Show past sessions                                 |
| `/save <name>`          | Save current session                               |
| `/cwd <path>`           | Change working directory                           |
| `/allow <tool>`         | Whitelist a tool for the session                   |
| `/exit`                 | Quit                                               |
| `/help`                 | List commands                                      |

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

## Safety Gate

Every tool call passes through a 3-tier classifier:

- **`safe`** — Auto-run (read-only fs, sysinfo, http.fetch, read-only shell commands like `curl`, `ls`, `whoami`, `ifconfig`, recon tools like `gobuster`, `dirb`)
- **`confirm`** — User prompt (mutating shell commands, fs.write, pkg.install, net.scan)
- **`block`** — Refuse with explanation (`rm -rf /`, fork bombs, public IP scans without authorization, exfiltration patterns)

### Pentest Authorization

Security tools require a one-time acknowledgment:

```sh
clai authorize-pentest AGREE
```

Public IP scanning is blocked unless the target is private (RFC 1918) or the user explicitly confirms ownership.

## Diagnostics

```sh
# Check system info, provider configuration, and available tools
clai doctor
```

Outputs:
- OS, shell, architecture
- Config and history file paths
- Provider key status
- Available pentest tools with install commands for missing ones

## Per-Project Context

Create a `.clai/context.md` file in your project root to automatically inject project context into every prompt:

```md
This is a Node.js project using Express and PostgreSQL.
The API server runs on port 3000.
Database migrations are in the `migrations/` directory.
```

## Configuration

Configuration is stored at `~/.config/clai/config.json` (varies by OS):

```sh
# Print config path and current settings
clai config

# Set default mode
clai mode agent

# Set model for current provider
clai model llama-3.3-70b-versatile
```

## Development

```sh
# Install dependencies
npm install

# Run in development mode
npm run dev

# Type check
npm run typecheck

# Build TypeScript
npm run build

# Run tests
npm test

# Build native binaries (requires Bun)
npm run compile
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
│  │   ├─ history.ts        # SQLite sessions + JSONL fallback
│  │   ├─ keys.ts           # Keychain + fallback key storage
│  │   ├─ logs.ts           # Audit log with rotation
│  │   └─ project.ts        # Per-project context loader
│  ├─ commands/
│  │   ├─ doctor.ts         # System diagnostics
│  │   └─ providers.ts      # Provider management commands
│  └─ prompts/
│      ├─ index.ts          # Prompt template renderer
│      ├─ system.ask.md     # Ask mode system prompt
│      └─ system.agent.md   # Agent mode system prompt
├─ bin/clai                 # Shebang launcher
├─ scripts/build.ts         # Bun compile per target
├─ .github/workflows/
│   └─ release.yml          # CI: build + publish binaries
├─ manifests/
│   ├─ homebrew/clai.rb     # Homebrew formula
│   └─ scoop/clai.json      # Scoop manifest
├─ install/install.sh       # curl installer
├─ package.json
├─ tsconfig.json
└─ README.md
```

## License

MIT
