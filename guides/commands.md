# Commands

[← Back to README](../README.md)

Run `clai --help` for CLI flags and `clai <command> --help` for a subcommand. In the interactive console, `/help` lists slash commands.

| Slash command | Purpose |
| --- | --- |
| `/ask`, `/agent`, `/plan` | Switch working mode. |
| `/view-plan`, `/implement`, `/discard` | Review, execute, or discard a plan. |
| `/provider [name]`, `/model [name]`, `/models [filter]` | Select providers and models. |
| `/set [provider]`, `/unset [provider]`, `/keys`, `/info [provider]` | Configure provider credentials and inspect provider setup. |
| `/creds` | Manage encrypted freeform credentials and this machine's sudo password. |
| `/effort [level]`, `/reasoning [level]` | Set reasoning effort or open its picker. |
| `/fallback [on\|off]`, `/freeonly [on\|off]` | Configure fallback. |
| `/orchestrator`, `/subagents` | Manage delegation and inspect subagents. |
| `/rtk [on\|off\|status\|install\|update]` | Manage shell output compression. |
| `/rea [install\|setup\|update\|use\|on\|off\|status\|reconnect\|guide\|<task>]` | Install, update and use [Reverse Engineer Anything](../REA.md); attach it to a prompt with `@rea`. |
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
