# Working with clai

[← Back to README](../README.md)

## Modes and permissions

| Mode | Purpose |
| --- | --- |
| `ask` | Questions, explanations, and read-only investigation. This is the initial default. |
| `agent` | Execute tasks with file, shell, and other tools under the configured permission policy. |
| `plan` | Gather evidence and prepare a plan. Review it with `/view-plan`, then use `/implement` to approve execution or `/discard` to remove it. |

Switch modes with `/ask`, `/agent`, `/plan`, or `Shift+Tab`. `clai mode <mode>` sets the default for new sessions.

Fresh configurations use **full-access** permissions. `/permissions default` enables the more conservative confirmation policy; `/permissions auto-allow` allows eligible actions automatically while retaining confirmation for out-of-folder or unresolved deletions. Explicitly saved permission choices are preserved. Ask/plan restrictions, OS permissions, engagement scope, and hard safety blocks still apply.

When an approval prompt appears, `Ctrl+O` opens the complete pending operation, including its arguments and working directory. Reading the operation does not approve it. These policies govern clai's tool execution; they are not an OS sandbox.

## Goals

`/goal <condition>` keeps clai working until a condition holds, without a prompt for each step. Setting a goal starts a turn immediately with the condition as the directive. After every turn, an evaluator reads the conversation and returns one of these verdicts:

- **Not met**: clai starts another turn and uses the evaluator's reason and suggested next step as guidance.
- **Met**: the goal is cleared and the transcript records it as achieved, with its duration, evaluated turns and token spend.
- **Impossible**: the goal is cleared and the transcript records it as failed, with the reason.
- **Blocked**: the goal pauses when progress needs something only you can provide, such as a decision or credentials.

The evaluator does not run tools. Write the condition as something the conversation can show, with one measurable end state and how to check it, for example `/goal all tests in test/auth pass and npm run lint exits 0`. Conditions can be up to 4,000 characters. A goal does not change the mode or the permission policy; use agent mode with suitable permissions for unattended work.

| Command | Effect |
| --- | --- |
| `/goal <condition>` | Set the goal, replacing any current one. If a turn is running, the goal starts after it. |
| `/goal` | Show the condition, running time, evaluated turns, tokens spent and the last evaluator reason. After a goal is achieved, shows that goal's result. |
| `/goal pause`, `/goal resume` | Stop or restart automatic turns without clearing the goal. |
| `/goal clear` | Remove the goal. `stop`, `off`, `reset`, `none` and `cancel` are aliases. `/clear` also removes it, and `/new` starts a session without it. |

A strip above the composer shows `◎ goal active` with the elapsed time and evaluated turns, or `goal paused` with how to continue. Click it in OpenTUI to open the status view.

The goal pauses and your next message resumes it when you interrupt a goal turn with `Esc`, when three turns in a row make no tool calls, after 50 automatic turns, or after a rate or usage limit. Network and server errors retry after 15 s, 30 s and 60 s, then pause. Authentication failures, exhausted credits, an unavailable model, and context overflow clear the goal; fix the cause and run `/goal` again. `/goal pause` waits for `/goal resume`.

While a subagent or background job runs, evaluation waits and resumes after the result is delivered. After 30 minutes of waiting, clai starts a check-in turn that reviews the running work, then waits twice as long before each later check-in, up to two hours and at most three times until you send a message. Plan mode also defers evaluation until you switch modes.

Resuming a session restores a goal that was still active or paused, with its timer, turn count and token baseline reset. It does not start a turn until you send a message or run `/goal resume`. Achieved and cleared goals are not restored. Private mode and `--no-history` keep the goal in memory only.

Evaluation reuses the conversation's prompt cache. The evaluator request repeats the last model request unchanged, with the same tools and reasoning settings, and adds the evaluation question at the end. The question is never written to history, and continuation prompts are appended as hidden messages, so the cached prefix stays the same for the next turn. When no reusable request exists, for example right after compaction or a model switch, clai evaluates a bounded transcript excerpt as a separate background request that uses its own cache key.

## Subagents and background work

`/orchestrator` controls delegation and subagent model choices; delegation is off by default, and `/orchestrator on` enables it. `/subagents` shows assignments and lets you stop or restart an investigation. Retained findings and delivery state help the parent reuse completed research after compaction or resuming a session.

The agent can keep development servers and long commands running as background jobs. Use `/jobs` to inspect them and `/output` to browse output. Conversation-owned interactive terminals support SSH, Python/Metasploit REPLs, debuggers, and database consoles across model turns.

Interactive tools use `terminal.start` → observe the prompt → `terminal.send` → continue from `page.nextCursor` with `terminal.read` → `terminal.close`. Secret input automatically reuses one clearly labeled password supplied by the user (for example, `password: …` or `password is "…"`), including retained credentials after compaction; it never copies passwords into tool arguments. Missing or ambiguous passwords use the local masked modal. `terminal.send` with `kind:"secret", secretSource:"user"` requires a supplied password without prompting; `secretSource:"prompt"` forces masked entry. Use `terminalMode:"required"` for password SSH and readline consoles. A delivered/unknown action must not be resent after a timeout; read its output instead. Retained output remains readable after exit/close, and status reports process outcome and cleanup. On an output gap, use `earliestAvailableCursor` or the saved artifact. Both UIs preserve terminal text, repeated lines, commands/control actions and cursor diagnostics; plain output is a safe linear transcript, not a full-screen terminal emulator.

`terminal.start.deadlineMs` limits startup only (100–120000 ms, default 10000); it does not keep an SSH session alive. Optional `idleTimeoutMs` (1000–86400000) and `lifetimeTimeoutMs` (1000–604800000) control inactivity and total lifetime and are unset by default. Send uses a 25–5000 ms quiet interval (default 250) and 100–120000 ms deadline (default 30000); read waits at most 30000 ms. Finite commands and SSH version/config probes still use `shell.exec`; unattended services use explicit background jobs.

`/rtk on` optionally compresses eligible foreground shell output through [rtk](https://github.com/rtk-ai/rtk). It is off by default; `/rtk install`, `/rtk update`, and `/rtk status` manage the integration. `/rtk` reports executions and estimated token savings for the current conversation. Each session has its own RTK tracking database, shared by its attachments and retained when resumed; unrelated RTK activity is excluded.

## Authorized security testing

clai can assist with reconnaissance, enumeration, scoped testing, and reporting using installed tools. Test systems you own or have permission to assess.

`clai authorize-pentest AGREE` stores the authorization acknowledgement. Use `clai scope` to configure the default engagement scope inherited by new sessions, or `/scope` to configure the current session. Scope can define authorized targets, exclusions, phases, and limits. Plan mode supports evidence gathering before you approve implementation.

## Models, rotation, and usage

- `/provider` selects a provider; `/model` selects its model; `/models` browses models across providers. A fetched model list is reused for two minutes. `/model refresh` and `/models refresh` fetch it again right away, and a list that could not be fetched is never reused: when a provider is unreachable clai shows its built-in list marked as not live, and the next `/model` tries the provider again.
- `/set` manages up to 10 credentials per provider, including disabled keys and the active key. Applicable authentication, quota, rate-limit, and server failures can trigger rotation.
- `/fallback on` enables cross-provider fallback; it is off by default. `/freeonly on` filters fallback using clai's provider categories. Check the selected model and account's billing terms when controlling spending.
- `/effort` configures reasoning where supported. Qoder uses the selected effort, including `xhigh`, and displays thinking when returned by the model.
- Cline discovers context and output limits and reasoning controls from live catalogs, including new models. `/context` shows the input budget; `/effort` offers the published levels or an on/off toggle. See [Cline setup and discovery](../PROVIDERS.md#cline).
- `/usage` shows reported token and cache usage across main turns, subagents, and auxiliary requests. Supported account providers also expose quota or subscription information. Token totals are not a billing invoice.

The [provider guide](../PROVIDERS.md) covers authentication, environment variables, endpoint configuration, and provider-specific behavior. Model catalogs and account access can change; use `/model` and the provider's own dashboard for availability.

## Project context, skills, and MCP

Place project notes in `.clai/context.md` in the working directory to supply architecture, conventions, or testing context. Project skills live under `.clai/skills/` as `SKILL.md` playbooks; `/skills list` shows discovered skills and `/skills refresh` rescans them.

clai ships [`clai-superman-skill`](security-skill.md), an on-demand security investigation library spanning pentesting, vulnerability research, code audits and security operations. The model discovers its description and loads relevant guidance when needed; request it explicitly with `skill:clai-superman-skill`. Project/user/custom skills with the same name override the bundled version. It emphasizes evidence, coverage and productive persistence—not guaranteed findings or endless scanning.

MCP servers can expose local or remote tools. Tools are disabled by default; activate a server with an `@mcp:<server>` prompt mention or enable all configured servers with `/mcp all`. Submitted selections remain available for follow-up prompts until changed or disabled with `/mcp off`. `/mcp` also supports configuration, connection status, authentication, and tool discovery.

Use the picker to add a catalog server or paste its JSON configuration. API keys, OAuth browser sign-in, device codes, and pasted callbacks over SSH are supported. Large tool catalogs are searched on demand, keeping schemas out of repeated model requests. See the [MCP guide](../MCP.md) for setup, authentication, configuration compatibility, and troubleshooting.

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
