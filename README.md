<div align="center">

# clai

**An open-source AI coding and security agent for your terminal.**

Use 35+ model providers from one CLI: free keyless models, your ChatGPT, GitHub Copilot or Kiro account, any API key, or a local Ollama model.

[![CI](https://github.com/pentoshi007/clai/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/pentoshi007/clai/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/pentoshi007/clai?label=release&color=2eebff)](https://github.com/pentoshi007/clai/releases)
[![npm](https://img.shields.io/npm/v/@pentoshi/clai?color=cb3837&logo=npm)](https://www.npmjs.com/package/@pentoshi/clai)
[![License: MIT](https://img.shields.io/badge/license-MIT-4ade80)](LICENSE)
[![Platforms](https://img.shields.io/badge/platforms-macOS%20%7C%20Linux%20%7C%20Windows-64748b)](#install)
[![GitHub stars](https://img.shields.io/github/stars/pentoshi007/clai?style=flat&logo=github&color=f5b351)](https://github.com/pentoshi007/clai/stargazers)

[Install](#install) · [Quick start](#quick-start) · [Features](#why-clai) · [Providers](#supported-providers) · [Docs](#documentation) · [Contributing](CONTRIBUTING.md)

<img src=".github/assets/clai-opentui.svg" alt="clai editing a file, running tests and summarizing the result in the OpenTUI interface" width="900">

</div>

## Why clai

clai reads your repository, edits files with reviewable diffs, runs commands and tests, and keeps working when you close the terminal. It is a single native binary with no account required to start.

| | |
| --- | --- |
| 🆓 **Free to start** | The keyless Free provider works out of the box: no sign-up and no API key. Availability and limits depend on the hosted service. |
| 🔌 **Bring any model** | 35+ providers, including ChatGPT, GitHub Copilot, Kiro, Cline and Qoder account sign-ins, Anthropic, OpenAI, Gemini, DeepSeek, OpenRouter, NVIDIA NIM and local Ollama. Multiple keys per provider rotate automatically, and cross-provider fallback is optional. |
| 🔁 **Sessions that survive disconnects** | `/minimise` detaches while the agent keeps working. Reattach later from another terminal or over SSH, even from your phone. Several terminals can share one live session, each with its own size and scroll position. |
| 🧭 **Ask, agent and plan modes** | Ask questions without side effects, let the agent execute, or have it gather evidence and propose a plan you approve with `/implement`. |
| 🛠️ **Real tools** | File edits with diffs, shell commands, background jobs, interactive terminals (SSH, REPLs, debuggers, database consoles), web search, MCP servers, Agent Skills and parallel subagents. |
| 📜 **Long sessions, nothing lost** | Every transcript item stays reachable. Context compaction keeps the model focused without losing your instructions. `/changes` shows per-file line counts and diffs for the session, and `/prompts` lists every prompt you sent. |
| 🖥️ **Two interfaces** | A fast OpenTUI interface on macOS and Linux, and the Classic interface everywhere, including Windows and narrow terminals. |
| 🛡️ **Authorized security testing** | Scoped engagements with authorized targets, exclusions, phases and rate limits for testing systems you own or have permission to assess. |
| 📦 **Native and self-updating** | Checksum-verified binaries for macOS, Linux and Windows on x64 and ARM64, plus Homebrew and npm. `clai update` updates the installation you are running. |

## Install

**macOS and Linux**

```sh
curl -fsSL https://downloads.clai.aniketpandey.website/install/install.sh | sh
```

**Homebrew**

```sh
brew tap pentoshi007/clai && brew install clai
```

**Windows (PowerShell)**

```powershell
irm https://downloads.clai.aniketpandey.website/install/install.ps1 | iex
```

**npm** (Node.js 22 or later)

```sh
npm install -g @pentoshi/clai
```

The install script verifies the binary's published SHA256 checksum and installs to `/usr/local/bin` by default; set `CLAI_BIN_DIR` to choose another directory. Native releases include the runtime, so Node.js is only needed for the npm package. On macOS and Linux, the npm installer sets up Bun for the OpenTUI interface when needed; set `CLAI_NO_BUN_AUTO_INSTALL=1` to skip it and use `clai --classic`. Manual downloads are on [GitHub Releases](https://github.com/pentoshi007/clai/releases).

This README follows the `main` branch; packaged releases can lag behind it. Use [source setup](CONTRIBUTING.md#source-setup) to run the current development version. To update, run `/update` inside clai or `clai update` in your shell ([how updates work](guides/updating.md)).

## Quick start

```sh
clai
```

A fresh setup uses the keyless **Free** provider in **ask** mode. Type `/agent` to let clai execute tasks, or `/plan` to review a plan first.

Sign in with an account you already have:

```sh
clai auth chatgpt      # or: copilot, kiro, cline, qoder, omnirush
clai use chatgpt
```

Use an API key (you are prompted with hidden input):

```sh
clai set deepseek
clai use deepseek
```

Run a local model with Ollama (start Ollama and pull a model first):

```sh
clai set ollama --url http://localhost:11434
clai use ollama
clai model <downloaded-model>
```

Run one-shot prompts and pipelines:

```sh
clai "explain this repository and identify its entrypoint"
clai --mode agent "add a health endpoint and run the relevant tests"
git diff | clai --quiet "review this diff for bugs"
```

## Modes

| Mode | What it does |
| --- | --- |
| `ask` | Questions, explanations and read-only investigation. The default for new setups. |
| `agent` | Executes tasks with file, shell and other tools under your permission policy. |
| `plan` | Gathers evidence and writes a plan. Review it with `/view-plan`, run it with `/implement` or drop it with `/discard`. |

Switch with `/ask`, `/agent`, `/plan` or `Shift+Tab`. Fresh setups use **full-access** permissions; `/permissions default` asks before actions and `/permissions auto-allow` approves eligible actions automatically. These policies govern clai's own tools and are not an OS sandbox. See [working with clai](guides/usage.md#modes-and-permissions).

## Persistent sessions

```sh
/minimise              # inside clai: detach and keep the agent running
clai --resume          # reattach to the latest live or saved session
clai --resume <id>     # a specific session (a unique prefix works)
clai -c                # the latest session for this directory
clai history           # list sessions and whether an agent is running
```

Start clai on a cloud VM, detach, reconnect from a laptop or a phone over SSH, and keep going with the same agent. Every attached terminal sees the same conversation and can type, with its own size, draft and scroll position. Attaching another terminal never starts a second agent. On Linux and macOS, `sudo clai` uses your own account's history and configuration, so normal and elevated launches share sessions. Details: [persistent sessions](guides/sessions.md).

## Supported providers

Account sign-ins, API keys, keyless access and local endpoints are all supported. Run `clai set <provider>` to add a key (or `--from-env <variable>` to import one), `/model` to pick a model, and `/usage` to see token and cache usage. The [provider guide](PROVIDERS.md) covers each provider's setup.

<details>
<summary><b>Account sign-ins</b> (ChatGPT, GitHub Copilot, Cline, Kiro, OmniRush, Qoder, Freebuff)</summary>

| Provider | Sign-in command | Notes |
| --- | --- | --- |
| ChatGPT (Codex) | `clai auth chatgpt` | Stored as `codex`; browser/headless sign-in or existing Codex CLI import. |
| GitHub Copilot | `clai auth copilot` | Browser/device sign-in or supported credential import. |
| Cline | `clai auth cline` | Account sign-in or supported credential import. |
| Kiro | `clai auth kiro` | Social login, AWS Builder ID, or IAM Identity Center. |
| OmniRush | `clai auth omnirush` | Device-code sign-in or existing OmniRush CLI import. |
| Qoder | `clai auth qoder` | Browser/headless sign-in, CLI import, or PAT via `--pat`. |
| Freebuff | `clai auth freebuff` | Sign-in and catalog support; inference requires server admission. |

</details>

<details>
<summary><b>API, keyless and local providers</b> (30 providers including Free, Ollama, Anthropic, OpenAI, Gemini, DeepSeek, OpenRouter)</summary>

| Provider | Provider ID | Credential or endpoint variable |
| --- | --- | --- |
| Free | `free` | Keyless models; optional `FREE_API_KEY` for authenticated access. |
| Ollama | `ollama` | Local endpoint through `OLLAMA_HOST` or `clai set ollama --url <url>`. |
| Anthropic | `anthropic` | `ANTHROPIC_API_KEY` |
| DeepSeek | `deepseek` | `DEEPSEEK_API_KEY` |
| Google Gemini | `gemini` | `GEMINI_API_KEY` |
| GLM / Zhipu | `glm` | `GLM_API_KEY`, `ZHIPU_API_KEY`, or `ZAI_API_KEY` |
| Kimi / Moonshot | `kimi` | `KIMI_API_KEY` or `MOONSHOT_API_KEY` |
| MiniMax | `minimax` | `MINIMAX_API_KEY` |
| Mistral | `mistral` | `MISTRAL_API_KEY`; optional `MISTRAL_BASE_URL` for regional endpoints. |
| River | `river` | `RIVER_API_KEY`; optional `RIVER_BASE_URL`. Dynamic models, per-model efforts, images, tools, streamed reasoning, and automatic prefix caching. |
| Xiaomi MiMo | `mimo` | `MIMO_API_KEY` |
| NVIDIA NIM | `nvidia` | `NVIDIA_API_KEY` |
| OpenAI | `openai` | `OPENAI_API_KEY` |
| OpenRouter | `openrouter` | `OPENROUTER_API_KEY` |
| Qwen Cloud / DashScope | `qwen-cloud` | `DASHSCOPE_API_KEY` |
| AgentRouter | `agentrouter` | `AGENTROUTER_API_KEY` |
| AWS Mantle | `aws-mantle` | `ANTHROPIC_API_KEY` for the configured Mantle endpoint. |
| Bynara | `bynara` | `BYNARA_API_KEY` |
| Constellation Gate | `constellation` | `GATE_API_KEY` |
| ExpLabs | `explabs` | `EXPLABS_API_KEY` |
| Fireworks | `fireworks` | `FIREWORKS_API_KEY` |
| Hetzner | `hetzner` | `HETZNER_API_KEY` |
| Lightning AI | `lightning` | `LIGHTNING_API_KEY` |
| Merge Gateway | `merge-gateway` | `MERGE_GATEWAY_API_KEY` |
| Meta Model API | `meta` | `MODEL_API_KEY` |
| Modal | `modal` | Both `MODAL_PROXY_TOKEN_ID` and `MODAL_PROXY_TOKEN_SECRET`; deployed endpoint required. |
| OrcaRouter | `orcarouter` | `ORCAROUTER_API_KEY` |
| Token Harbor | `tokenharbor` | `TOKENHARBOR_API_KEY` |
| TokenRouter | `tokenrouter` | `TOKENROUTER_API_KEY` |
| Vercel AI Gateway | `vercel` | `AI_GATEWAY_API_KEY` |

</details>

## Common commands

| Command | Purpose |
| --- | --- |
| `/agent`, `/ask`, `/plan` | Switch mode |
| `/provider`, `/model`, `/models` | Choose a provider and model |
| `/effort` | Set reasoning effort where supported |
| `/changes` | Per-file line counts and full diffs for this session |
| `/history`, `/new`, `/save <name>`, `/prompts` | Browse, start, name and inspect sessions |
| `/compact`, `/context`, `/usage` | Manage context and see token usage |
| `/jobs`, `/output` | Background jobs and retained tool output |
| `/subagents`, `/orchestrator` | Delegate research to subagents |
| `/mcp`, `/skills` | MCP servers and Agent Skills |
| `/minimise` | Detach and keep the agent running |

Type `/` for suggestions and `@` to mention files. `/help` lists everything and `/shortcuts` shows key bindings. See the [full command reference](guides/commands.md).

## Documentation

| Guide | Contents |
| --- | --- |
| [Persistent sessions](guides/sessions.md) | Detach and resume, SSH and multiple terminals, sudo, history and context compaction |
| [Working with clai](guides/usage.md) | Modes and permissions, subagents, background jobs and interactive terminals, security testing, models and key rotation, project context, skills and MCP |
| [Terminal interface](guides/interface.md) | OpenTUI and Classic, recommended terminals, keyboard shortcuts, paste and transcript controls |
| [Commands](guides/commands.md) | Every slash command and CLI flag |
| [Configuration and privacy](guides/configuration.md) | Config file, private mode, retention, credential storage and the encrypted `/creds` vault |
| [Updating](guides/updating.md) | How `clai update` handles each installation method |
| [Providers](PROVIDERS.md) | Account flows, API keys, endpoints and provider-specific behavior |
| [MCP](MCP.md) | Adding, authenticating and troubleshooting MCP servers |

## Privacy and security

- History, prompt journals and logs stay on your machine under `~/.clai/`. Private mode (`clai privacy on`) and `--no-history` turn persistence off.
- Credentials saved with `clai set` or account sign-in are kept in `~/.clai/keys.json`, a **plaintext** file with `0600` permissions on POSIX, and in the OS keyring when one is available. Freeform secrets in `/creds` are encrypted with AES-256-GCM.
- Cloud requests send the conversation context and relevant tool results to the provider you select.

Read [configuration and privacy](guides/configuration.md) and [SECURITY.md](SECURITY.md) before using clai with sensitive data. Report vulnerabilities as described in [SECURITY.md](SECURITY.md).

## Contributing

Contributions are welcome. [CONTRIBUTING.md](CONTRIBUTING.md) covers source setup, architecture boundaries and the CI checks. Report bugs in [Issues](https://github.com/pentoshi007/clai/issues), ask questions in [Discussions](https://github.com/pentoshi007/clai/discussions), and follow the [Code of Conduct](CODE_OF_CONDUCT.md).

If clai is useful to you, a ⭐ helps other developers find it.

[![Star History Chart](https://api.star-history.com/svg?repos=pentoshi007/clai&type=Date)](https://star-history.com/#pentoshi007/clai&Date)

## License

[MIT](LICENSE) © pentoshi007
