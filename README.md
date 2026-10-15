# clai

clai is a terminal AI assistant for software development, debugging, shell tasks, and authorized security testing. It can inspect a repository, edit files, run checks, manage background processes, and delegate independent research to subagents.

Use a hosted API, an account sign-in, or a local Ollama model. Interactive sessions support live reattachment from multiple terminals on the same machine, so you can reconnect over SSH and continue working with the same agent.

- **Persistent sessions:** streaming output and agent work continue after a terminal disconnect or `/minimise`; each attached terminal keeps its own size, draft, and scrolling.
- **Three working modes:** ask questions, execute tasks, or review a plan before implementation.
- **Provider flexibility:** multiple credentials, automatic key rotation, and optional fallback between configured providers.
- **Tools and integrations:** file editing, shell commands, background jobs, interactive terminals, web search, MCP servers, and Agent Skills.
- **Long sessions:** saved transcripts, durable subagent findings, context compaction, and pagers for large outputs.

[Installation](#installation) · [Quick start](#quick-start) · [Persistent sessions](#persistent-sessions) · [Providers](#supported-providers) · [Terminals](#terminal-compatibility-and-recommendations) · [Commands](#commands) · [Contributing](CONTRIBUTING.md)

## Installation

This guide follows the `main` branch. Packaged releases can lag recent changes; use [source setup](CONTRIBUTING.md#source-setup) to run the current development version.

Native releases are available for macOS, Linux, and Windows on x64 and ARM64. They include the runtime; Node.js is required for the npm package and development from source.

### macOS and Linux

```sh
curl -fsSL https://downloads.clai.aniketpandey.website/install/install.sh | sh
```

The installer verifies the binary's published SHA256 checksum. It installs to `/usr/local/bin` by default; `CLAI_BIN_DIR` selects another directory.

Homebrew is also available:

```sh
brew tap pentoshi007/clai
brew install clai
```

### Windows

Run in PowerShell:

```powershell
irm https://downloads.clai.aniketpandey.website/install/install.ps1 | iex
```

### npm

Requires Node.js 22 or later:

```sh
npm install -g @pentoshi/clai
```

On macOS and Linux, the npm installer sets up Bun for the OpenTUI interface when needed. Set `CLAI_NO_BUN_AUTO_INSTALL=1` to skip that setup and use `clai --classic`.

For manual downloads, use [GitHub Releases](https://github.com/pentoshi007/clai/releases). For a source checkout, follow [CONTRIBUTING.md](CONTRIBUTING.md).

## Updating

Run `/update` inside clai, or `clai update` from your terminal. The updater identifies the installation that launched the running process, including symlinks and Node-to-Bun handoffs; it does not choose another copy from `PATH`. Repeated `where clai` entries pointing to the same file do not create separate installations. A path such as `/opt/homebrew/bin/clai` alone does not establish Homebrew ownership.

| Installation | Update behavior |
| --- | --- |
| Official native binary or install script | Downloads for the running OS/architecture, checks SHA256 and executable version, then replaces the canonical executable. Failed post-install verification restores the previous executable. |
| Homebrew on macOS/Linux | Uses the owning Homebrew prefix, refreshes formulas, upgrades clai and verifies its stable executable path. |
| Identifiable global/local npm, Bun, pnpm or Yarn Classic package | Uses the owning package directory and manager, pins the requested version and verifies that installation's launcher. Local packages stay local. pnpm isolated bundles retain their installed sibling versions. |
| Scoop on Windows | Refreshes manifests and updates the owning user/global installation, then verifies it. |
| Source checkout | Requires a clean, upstream-tracking checkout of the official repository. Builds in an isolated worktree, fast-forwards and verifies; application failure restores the old checkout and build. |

Native assets support macOS, Linux and Windows on x64/ARM64. Homebrew and Scoop can install a newer formula/manifest version than the release initially checked; the updater verifies and reports the actual version. Unknown ownership, dirty/divergent source checkouts, unsupported custom pnpm bundle dependencies and unsafe percent-containing paths through unidentified Windows `.cmd` wrappers are refused with guidance rather than modifying a guessed installation. Package-manager updates follow that manager's installation semantics.

Configuration, history and stored credentials are not replaced. Protected POSIX installations use the masked administrator prompt or cached/noninteractive sudo; the plain CLI reports guidance instead of hanging for a hidden password. Cancellation is supported before native promotion; an atomic replacement already underway finishes verification or rollback.

Windows updates are **staged**, not reported as already installed. Close the running installation and reopen clai afterwards. The worker waits up to two minutes for that process and, for native binaries, other holders of the exact executable. It verifies the result and writes the persistent JSON receipt path shown by `/update` or `clai update`. Inspect that receipt for `applied` or `failed`; if waiting times out, close all instances and retry. Protected Windows installations may request UAC approval.

These updater changes describe the current `main` branch; an older packaged release does not acquire them until a new release is published.

## Quick start

```sh
clai
```

A fresh configuration uses the keyless Free provider and **ask** mode. Hosted availability and limits depend on the provider. Use `/agent` to enable task execution or `/plan` to prepare a plan for review.

To sign in with an existing account, for example ChatGPT:

```sh
clai auth chatgpt
clai use chatgpt
clai
```

To use an API key, `clai set` prompts with hidden input when the key is omitted:

```sh
clai set deepseek
clai use deepseek
clai
```

For a local model, start Ollama and download the model you intend to use, then configure its endpoint:

```sh
clai set ollama --url http://localhost:11434
clai use ollama
clai model <downloaded-model>
clai
```

You can also run a prompt directly or pipe input:

```sh
clai "explain this repository and identify its entrypoint"
clai --mode agent "add a health endpoint and run the relevant tests"
git diff | clai --quiet "review this diff for bugs"
```

## Persistent sessions

### Detach and resume

Run `/minimise` inside the interactive console to return to your shell while the agent continues. `/minimize` and `/minmize` are aliases. The detach message includes the session ID and a resume command.

| Command | Behavior |
| --- | --- |
| `clai --resume` | Resume the most recently updated live or saved session across directories. |
| `clai --resume <id>` | Resume a specific session; a unique ID prefix also works. |
| `clai -c` or `clai --continue` | Prefer the latest session for the current directory, with a saved-session fallback when none matches. |
| `clai history` or `/history` | Find saved sessions and see whether an agent is running, attached, or detached. |

Reattaching to a live session opens a terminal view of the running agent. Resuming a saved session restores its conversation and transcript. Bare `--resume` also uses the original working directory if it still exists. Resume flags apply to interactive sessions; prompts supplied on the command line run separately.

### SSH and multiple terminals

After an SSH disconnect, reconnect to the same machine as the same OS user and run `clai --resume`. To share a particular live session, run `clai --resume <id>` in another terminal or SSH connection.

Every attachment receives the same live conversation and can type immediately, including prompts and shortcuts. Each terminal has its own screen dimensions, draft, scroll position, selection, and panels. Resizing a phone or scrolling on a laptop affects that view alone. Submitted prompts and agent actions belong to one shared session; attaching another terminal does not start another agent or model request.

For example, start clai on a cloud VM, then connect from Termux on a phone over SSH and run `clai --resume`. The phone renders the conversation at its own width while the original terminal keeps its layout. Each attachment can choose `--classic` or `--tui`; narrow terminals use Classic automatically when OpenTUI's minimum size is unavailable. Closing or minimising one attachment keeps the agent and the other attachments running.

Independent views apply to runtimes started with v4.14.0 or later. Agents already running under an older version retain their existing terminal behavior until saved and restarted with the updated executable.

Durable sessions require an interactive terminal, a compatible PTY transport, and history enabled. Private mode and `--no-history` use foreground sessions. Saved history remains available after the live process ends; an active process still depends on its host machine remaining running.

### History and context

`/new` starts a fresh session and saves the previous one. If work is still running or another terminal is attached, that session remains available to its agent and other viewers. `/save <name>` names a session, and `/prompts` browses sent prompts with their timestamps and provider, model, and effort metadata. Up/Down recalls the active session's sent prompts after reopening it. Prompt text is displayed literally, including placeholders such as `<provider>`.

Each run's “Worked for” summary includes its recorded line additions and removals when available. `/changes` shows the combined counts and per-file counts for the current session; these counts are saved with the session and restored on resume.

Context compaction reduces what the model receives while retaining recent requests, plans, task state, and available research findings. A chronological workstream ledger carries bounded request, response, and tool-evidence excerpts for earlier topics, including unrelated completed work, across repeated compactions and saved sessions. The main memory gives unfinished work the most detail; historical excerpts are not new instructions or proof of completion. Compaction does not erase the saved chat transcript. Use `/compact` to compact manually, `/context` to inspect context size, and `/output` to read retained tool output.

Standing user instructions are carried forward in a dedicated memory section across repeated compactions and saved sessions. If the summary rewords an inherited rule or proposes an unverified change, clai keeps the canonical rule and completes compaction; verified user changes and completed task constraints are reconciled locally. Project instruction files are re-injected separately. When the captured request fits, compaction appends its prompt to that request while preserving its cached prefix, tools, and settings, with no extra request for instruction reconciliation.

`/clear` deletes the current session and starts fresh. `/reset` clears all saved history. These are deletion commands; use `/new` when you want to keep the previous conversation.

## Providers and usage

clai supports API credentials, account sign-ins, and local endpoints. Account integrations include ChatGPT, GitHub Copilot, Cline, Kiro, OmniRush, and Qoder. Freebuff has separate admission requirements described in the [provider guide](PROVIDERS.md#freebuff).

### Supported providers

Account sign-in integrations:

| Provider | Sign-in command | Notes |
| --- | --- | --- |
| ChatGPT (Codex) | `clai auth chatgpt` | Stored as `codex`; browser/headless sign-in or existing Codex CLI import. |
| GitHub Copilot | `clai auth copilot` | Browser/device sign-in or supported credential import. |
| Cline | `clai auth cline` | Account sign-in or supported credential import. |
| Kiro | `clai auth kiro` | Social login, AWS Builder ID, or IAM Identity Center. |
| OmniRush | `clai auth omnirush` | Device-code sign-in or existing OmniRush CLI import. |
| Qoder | `clai auth qoder` | Browser/headless sign-in, CLI import, or PAT via `--pat`. |
| Freebuff | `clai auth freebuff` | Sign-in and catalog support; inference requires server admission. |

API, keyless, and local integrations:

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
| Xiaomi MiMo | `mimo` | `MIMO_API_KEY` |
| NVIDIA NIM | `nvidia` | `NVIDIA_API_KEY` |
| OpenAI | `openai` | `OPENAI_API_KEY` |
| OpenRouter | `openrouter` | `OPENROUTER_API_KEY` |
| Qwen Cloud / DashScope | `qwen-cloud` | `DASHSCOPE_API_KEY` |
| AgentRouter | `agentrouter` | `AGENTROUTER_API_KEY` |
| AWS Mantle | `aws-mantle` | `ANTHROPIC_API_KEY` for the configured Mantle endpoint. |
| Bynara | `bynara` | `BYNARA_API_KEY` |
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

Use `clai set <provider>` for a hidden-input credential prompt, or `--from-env <variable>` to import a credential. The [provider guide](PROVIDERS.md) includes account flows, endpoint setup, and provider-specific behavior. `/model` shows model choices; access, limits, and prices depend on the provider and account.

### Models, rotation, and usage

- `/provider` selects a provider; `/model` selects its model; `/models` browses models across providers.
- `/set` manages up to 10 credentials per provider, including disabled keys and the active key. Applicable authentication, quota, rate-limit, and server failures can trigger rotation.
- `/fallback on` enables cross-provider fallback; it is off by default. `/freeonly on` filters fallback using clai's provider categories. Check the selected model and account's billing terms when controlling spending.
- `/effort` configures reasoning where supported. Qoder uses the selected effort, including `xhigh`, and displays thinking when returned by the model.
- Cline discovers context and output limits and reasoning controls from live catalogs, including new models. `/context` shows the input budget; `/effort` offers the published levels or an on/off toggle. See [Cline setup and discovery](PROVIDERS.md#cline).
- `/usage` shows reported token and cache usage across main turns, subagents, and auxiliary requests. Supported account providers also expose quota or subscription information. Token totals are not a billing invoice.

The [provider guide](PROVIDERS.md) covers authentication, environment variables, endpoint configuration, and provider-specific behavior. Model catalogs and account access can change; use `/model` and the provider's own dashboard for availability.

## Working with clai

### Modes and permissions

| Mode | Purpose |
| --- | --- |
| `ask` | Questions, explanations, and read-only investigation. This is the initial default. |
| `agent` | Execute tasks with file, shell, and other tools under the configured permission policy. |
| `plan` | Gather evidence and prepare a plan. Review it with `/view-plan`, then use `/implement` to approve execution or `/discard` to remove it. |

Switch modes with `/ask`, `/agent`, `/plan`, or `Shift+Tab`. `clai mode <mode>` sets the default for new sessions.

Fresh configurations use **full-access** permissions. `/permissions default` enables the more conservative confirmation policy; `/permissions auto-allow` allows eligible actions automatically while retaining confirmation for out-of-folder or unresolved deletions. Explicitly saved permission choices are preserved. Ask/plan restrictions, OS permissions, engagement scope, and hard safety blocks still apply.

When an approval prompt appears, `Ctrl+O` opens the complete pending operation, including its arguments and working directory. Reading the operation does not approve it. These policies govern clai's tool execution; they are not an OS sandbox.

### Subagents and background work

`/orchestrator` controls delegation and subagent model choices. `/subagents` shows assignments and lets you stop or restart an investigation. Retained findings and delivery state help the parent reuse completed research after compaction or resuming a session.

The agent can keep development servers and long commands running as background jobs. Use `/jobs` to inspect them and `/output` to browse output. Conversation-owned interactive terminals support SSH, Python/Metasploit REPLs, debuggers, and database consoles across model turns.

Interactive tools use `terminal.start` → observe the prompt → `terminal.send` → continue from `page.nextCursor` with `terminal.read` → `terminal.close`. Secret input automatically reuses one clearly labeled password supplied by the user (for example, `password: …` or `password is "…"`), including retained credentials after compaction; it never copies passwords into tool arguments. Missing or ambiguous passwords use the local masked modal. `terminal.send` with `kind:"secret", secretSource:"user"` requires a supplied password without prompting; `secretSource:"prompt"` forces masked entry. Use `terminalMode:"required"` for password SSH and readline consoles. A delivered/unknown action must not be resent after a timeout; read its output instead. Retained output remains readable after exit/close, and status reports process outcome and cleanup. On an output gap, use `earliestAvailableCursor` or the saved artifact. Both UIs preserve terminal text, repeated lines, commands/control actions and cursor diagnostics; plain output is a safe linear transcript, not a full-screen terminal emulator.

`terminal.start.deadlineMs` limits startup only (100–120000 ms, default 10000); it does not keep an SSH session alive. Optional `idleTimeoutMs` (1000–86400000) and `lifetimeTimeoutMs` (1000–604800000) control inactivity and total lifetime and are unset by default. Send uses a 25–5000 ms quiet interval (default 250) and 100–120000 ms deadline (default 30000); read waits at most 30000 ms. Finite commands and SSH version/config probes still use `shell.exec`; unattended services use explicit background jobs.

`/rtk on` optionally compresses eligible foreground shell output through [rtk](https://github.com/rtk-ai/rtk). It is off by default; `/rtk install`, `/rtk update`, and `/rtk status` manage the integration. `/rtk` reports executions and estimated token savings for the current conversation. Each session has its own RTK tracking database, shared by its attachments and retained when resumed; unrelated RTK activity is excluded.

### Authorized security testing

clai can assist with reconnaissance, enumeration, scoped testing, and reporting using installed tools. Test systems you own or have permission to assess.

`clai authorize-pentest AGREE` stores the authorization acknowledgement. Use `clai scope` to configure the default engagement scope inherited by new sessions, or `/scope` to configure the current session. Scope can define authorized targets, exclusions, phases, and limits. Plan mode supports evidence gathering before you approve implementation.

## Terminal interface

OpenTUI is selected by default on macOS and Linux when the terminal is at least 60 columns by 14 rows and the runtime is available. Windows and smaller terminals use Classic, which runs on React and Ink. `clai --classic` selects Classic explicitly; `clai --tui` requests OpenTUI with a Classic fallback when unavailable.

Both interfaces provide streaming chat, tool output, plans, session history, and provider controls.

### Terminal compatibility and recommendations

Choose a terminal for the OS on your local device. These recommendations link to each terminal's official setup information:

| Local OS | Recommended terminal | Alternatives |
| --- | --- | --- |
| Linux | [Kitty](https://sw.kovidgoyal.net/kitty/binary/) | [WezTerm](https://wezterm.org/installation.html) or [Alacritty](https://alacritty.org/). |
| macOS | [iTerm2](https://iterm2.com/) | [Kitty](https://sw.kovidgoyal.net/kitty/binary/), [WezTerm](https://wezterm.org/installation.html), or [Alacritty](https://alacritty.org/); the built-in Terminal app is also an option. |
| Windows | [Windows Terminal](https://learn.microsoft.com/en-us/windows/terminal/) | [WezTerm](https://wezterm.org/installation.html) or [Alacritty](https://alacritty.org/). |

clai selects its interface using the OS where it runs. Native Windows uses Classic; WSL and SSH sessions on a Linux host use the Linux interface selection, even when the local window is Windows Terminal or iTerm2. Over SSH, key, mouse, and clipboard capabilities come from your local terminal and any intervening multiplexer.

Standard terminals can handle ordinary text input and output. Modified keys, mouse motion/hover, and clipboard integration vary by terminal and configuration. In Classic with mouse reporting enabled, click a visible composer row to position the cursor, including wrapped lines and Unicode graphemes; transcript clicks and scrolling leave typing in the composer. The Classic composer spans the original transcript-shell width and shares the startup card's aqua border color. Scrolling does not display a scrollbar. If `Shift+Enter` is not distinguishable from `Enter`, use `Ctrl+N` or `Alt+Enter` for a newline. Use `clai --classic` if OpenTUI cannot start, and `F5` or `/redraw` to repaint a scrambled screen.

Large pastes collapse into a line or character count inside the composer while retaining the full text for submission. In both interfaces, place the cursor near a shortened block and press `Ctrl+E` to expand just that block for editing. `Alt+E` also works. When no shortened block is present, `Ctrl+E` moves to the end of the current line. In OpenTUI, hovering over an inline placeholder opens a preview that stays visible while the pointer remains inside the composer; double-clicking the placeholder or preview also expands it. Pasted transcripts remain one draft, including when a terminal sends unbracketed text in bursts over SSH. Press `Enter` after the paste has finished to submit it.

Type `/` at the start of the draft or after a space to browse commands. Use the arrow keys to select, `Tab` to complete, and `Enter` to run the command. A leading command retains its arguments, such as `/model model-name`; an inline command runs while preserving the surrounding draft. Completed commands also run after the suggestion menu is dismissed. Unknown leading commands show a local warning, and paths such as `/tmp/notes.txt` remain ordinary prompts.

### Keyboard shortcuts

| Action | Shortcut |
| --- | --- |
| Send prompt | `Enter` |
| Insert newline | `Shift+Enter`, `Alt+Enter`, or `Ctrl+N` |
| Expand shortened paste nearest the cursor | `Ctrl+E` or `Alt+E` |
| Cancel current turn | `Esc` |
| Interrupt; press again to quit | `Ctrl+C` |
| Cycle mode | `Shift+Tab` |
| Toggle plan pane / details | `Ctrl+H` / `Ctrl+P` |
| Show / hide queued-message blocks (Classic) | `Ctrl+Z` |
| Background jobs | `Ctrl+J` |
| Expand thinking / tool output | `Ctrl+T` / `Ctrl+O` |
| Return to the latest transcript content | `Ctrl+D` or click the contextual **Jump to latest** control |
| Search transcript when focused | `Ctrl+R` |
| Repaint screen | `F5` or `/redraw` |
| Help / full shortcut reference | `Ctrl+G` / `/shortcuts` |

Type `/` for command suggestions and `@` for file mentions. Terminal support affects which modified key combinations are available; `/shortcuts` lists bindings by context.

Both UIs show the paste shortcut inside shortened-text brackets, for example `[1200 chars pasted #1 · Ctrl+E]`. Expansion and submission restore the original pasted content, without the label. When the transcript is away from its latest content, a clickable **Jump to latest** control appears to the right of the task/queue hints. Clicking it restores automatic following; it disappears when the latest content is visible.

In Classic, `Ctrl+Z` hides or restores the queued-message blocks above the composer. On macOS, use Control rather than Command; no Option-key configuration is needed. `Alt+Q` remains a compatibility alias. The queue count and hidden state appear immediately to the right of the `Ctrl+H` tasks hint. Hiding does not remove, pause, or alter queued messages; selection, send-now, edit, and drop shortcuts still work. Tool headers use the OpenTUI state colors, with cyan inputs and light-blue outputs.

Classic transcripts show shell calls as **Shell**, file reads as **Explored** with option-free file lists, and edits as numbered red/green diffs. Inputs stay on one line; output previews show the first three lines, using the available terminal width. Tool timers match the composer `ctx` color and expansion controls use a subdued shade. Purple **Thinking** shows the complete wrapped stream without expansion controls or `Ctrl+T`. When streaming finishes, **Reasoning** honors the selected collapsed or expanded state, with timing, disclosure, and `Ctrl+T` together on the header. Click **+ click to expand** to reveal an item's complete stored input/output and **- click to collapse** to collapse it again. No external app is required. On terminals without mouse support, `Ctrl+O` toggles tool output, `Ctrl+T` toggles reasoning, and `Enter` toggles the last visible item while the transcript is focused (`Tab`). Saved output is loaded on expansion; exceptionally large artifacts use the clickable **+ full output** built-in paged viewer rather than exhausting terminal memory.

OpenTUI tool-output previews also show only their first three lines; `Ctrl+O` expands them and the full-output pager remains available. Structured file lists and diffs retain their dedicated presentation.

In OpenTUI, task titles and statuses keep their original colors and formatting while extra information starts collapsed. Click the small shaded `+` / `−` button immediately after a task title, or use **Expand all** / **Collapse all** beside the progress bar. Buttons center their glyphs and change background on hover or keyboard focus without brackets or underlines; mouse clicks leave no persistent highlight. Expanded information keeps the original muted text without added fields or headers; controls follow the end of wrapped titles in narrow panes. Scrolling keeps wrapped titles together when they fit the viewport, and keyboard selection reveals the whole title without unrelated progress updates moving your reading position. With the task pane focused, `↑` / `↓` select a task, `Enter` toggles its details, `→` / `←` expand or collapse it, `E` / `C` expand or collapse all, and `PageUp` / `PageDown` scroll. `Ctrl+P` still opens the full plan view.

## Commands

Run `clai --help` for CLI flags and `clai <command> --help` for a subcommand. In the interactive console, `/help` lists slash commands.

| Slash command | Purpose |
| --- | --- |
| `/ask`, `/agent`, `/plan` | Switch working mode. |
| `/view-plan`, `/implement`, `/discard` | Review, execute, or discard a plan. |
| `/provider [name]`, `/model [name]`, `/models [filter]` | Select providers and models. |
| `/set [provider]`, `/unset [provider]`, `/keys`, `/info [provider]` | Configure credentials and inspect provider setup. |
| `/effort [level]`, `/reasoning [level]` | Set reasoning effort or open its picker. |
| `/fallback [on\|off]`, `/freeonly [on\|off]` | Configure fallback. |
| `/orchestrator`, `/subagents` | Manage delegation and inspect subagents. |
| `/rtk [on\|off\|status\|install\|update]` | Manage shell output compression. |
| `/skills [name\|list\|refresh]`, `/mcp` | Manage skills and MCP servers. |
| `/search [provider]`, `/search-provider` | Select the web-search backend. |
| `/scope [show\|new\|add\|clear]` | Configure this session's engagement scope. |
| `/jobs`, `/output [last\|id\|list]` | Inspect jobs and tool output. |
| `/compact`, `/context`, `/usage` | Manage context and inspect usage. |
| `/history`, `/save <name>`, `/new`, `/prompts`, `/changes` | Browse, name, create, and inspect sessions and file-change totals. |
| `/clear`, `/reset` | Delete the current session or all saved history. |
| `/allow <tool>`, `/disallow <tool>`, `/permissions` | Configure tool permissions. |
| `/cwd <path>` | Change the working directory. |
| `/think`, `/thinking` | Show the last response's thinking. |
| `/privacy` | Manage private mode and clear retained data. |
| `/minimise`, `/minimize`, `/minmize` | Detach this terminal. |
| `/redraw`, `/refresh` | Repaint the screen. |
| `/update`, `/help`, `/shortcuts`, `/exit`, `/quit` | Updates, help, and exit. |

Useful CLI flags:

| Flag | Purpose |
| --- | --- |
| `--mode <ask\|agent\|plan>` | Set the mode for this invocation. |
| `--provider <id>`, `--model <name>` | Override the configured provider or model. |
| `--resume [id]`, `-c`, `--continue` | Resume an interactive session. |
| `--classic`, `--tui`, `--ui <classic\|tui>` | Select the interactive interface. |
| `--no-history` | Disable history persistence for this invocation. |
| `-y`, `--yes` | Auto-confirm eligible tool actions in a one-shot agent run. |
| `--quiet`, `--verbose`, `--show-thinking` | Control one-shot answer, tool output, and reasoning display. |

## Project context, skills, and MCP

Place project notes in `.clai/context.md` in the working directory to supply architecture, conventions, or testing context. Project skills live under `.clai/skills/` as `SKILL.md` playbooks; `/skills list` shows discovered skills and `/skills refresh` rescans them.

MCP servers can expose local or remote tools. Tools are disabled by default; activate a server with an `@mcp:<server>` prompt mention or enable all configured servers with `/mcp all`. Submitted selections remain available for follow-up prompts until changed or disabled with `/mcp off`. `/mcp` also supports configuration, connection status, authentication, and tool discovery.

Use the picker to add a catalog server or paste its JSON configuration. API keys, OAuth browser sign-in, device codes, and pasted callbacks over SSH are supported. Large tool catalogs are searched on demand, keeping schemas out of repeated model requests. See the [MCP guide](MCP.md) for setup, authentication, configuration compatibility, and troubleshooting.

Example `.clai/mcp.json`:

```json
{
  "servers": {
    "local": {
      "command": "my-mcp-server",
      "args": ["--root", "${workspaceFolder}"],
      "env": { "MCP_TOKEN": "${env:MCP_TOKEN}" }
    },
    "remote": {
      "url": "https://mcp.example.com/mcp",
      "headers": { "Authorization": "Bearer ${env:MCP_TOKEN}" }
    }
  }
}
```

## Configuration and privacy

`clai config` prints the configuration and its location. Use `clai mode`, `clai model`, and `clai use` to change defaults. History, prompt journals, logs, and runtime data normally live under `~/.clai/`; saved chat records include `history.jsonl`. Large outputs may also use per-session temporary directories.

```sh
clai privacy status
clai privacy on
clai privacy off
clai privacy retention 0
```

Private mode disables chat and prompt persistence and durable background attachment; `--no-history` applies to a single invocation. Retention defaults to `0` (unlimited saved sessions). These settings do not erase previously saved data. `clai privacy clear-history`, `clear-logs`, `clear-artifacts`, and `clear-all` explicitly delete retained data; the corresponding `/privacy` actions are available in the UI.

Credentials saved with `clai set` or account sign-in are retained in `~/.clai/keys.json`, a **plaintext** file with restricted permissions (`0600` on POSIX). clai also attempts to store them in the OS keyring when available; the local file is retained for recovery. Recognized secrets are masked or redacted in supported displays and storage paths, but review logs and transcripts before sharing them.

Cloud requests send the model's context and relevant tool results to the selected provider. Provider-specific metadata uploads, including OmniRush's optional lifecycle upload, are described in the [provider guide](PROVIDERS.md#omnirush-lifecycle-uploads).

## Development and support

See [CONTRIBUTING.md](CONTRIBUTING.md) for source setup, architecture boundaries, and the CI checks. Report reproducible bugs through [GitHub Issues](https://github.com/pentoshi007/clai/issues), and use [Discussions](https://github.com/pentoshi007/clai/discussions) for questions. Follow [SECURITY.md](SECURITY.md) for vulnerability reporting and the [Code of Conduct](CODE_OF_CONDUCT.md) when participating.

Licensed under the [MIT License](LICENSE).
