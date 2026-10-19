# Persistent sessions

[← Back to README](../README.md)

## Detach and resume

Run `/minimise` inside the interactive console to return to your shell while the agent continues. `/minimize` and `/minmize` are aliases. The detach message includes the session ID and a resume command.

| Command | Behavior |
| --- | --- |
| `clai --resume` | Resume the most recently updated live or saved session across directories. |
| `clai --resume <id>` | Resume a specific session; a unique ID prefix also works. |
| `clai -c` or `clai --continue` | Prefer the latest session for the current directory, with a saved-session fallback when none matches. |
| `clai history` or `/history` | Find saved sessions and see whether an agent is running, attached, or detached. |

Reattaching to a live session opens a terminal view of the running agent. Resuming a saved session restores its conversation and transcript. Bare `--resume` also uses the original working directory if it still exists. Resume flags apply to interactive sessions; prompts supplied on the command line run separately.

## SSH and multiple terminals

After an SSH disconnect, reconnect to the same machine as the same OS user and run `clai --resume`. To share a particular live session, run `clai --resume <id>` in another terminal or SSH connection.

Every attachment receives the same live conversation and can type immediately, including prompts and shortcuts. Each terminal has its own screen dimensions, draft, scroll position, selection, and panels. Resizing a phone or scrolling on a laptop affects that view alone. Submitted prompts and agent actions belong to one shared session; attaching another terminal does not start another agent or model request.

For example, start clai on a cloud VM, then connect from Termux on a phone over SSH and run `clai --resume`. The phone renders the conversation at its own width while the original terminal keeps its layout. Each attachment can choose `--classic` or `--tui`; narrow terminals use Classic automatically when OpenTUI's minimum size is unavailable. Closing or minimising one attachment keeps the agent and the other attachments running.

Independent views apply to runtimes started with v4.14.0 or later. Agents already running under an older version retain their existing terminal behavior until saved and restarted with the updated executable.

Durable sessions require an interactive terminal, a compatible PTY transport, and history enabled. Private mode and `--no-history` use foreground sessions. Saved history remains available after the live process ends; an active process still depends on its host machine remaining running.

## Elevated launches

On Linux and macOS, `sudo clai` uses the invoking account's configuration, history, and runtime identity. A normal `clai --resume` can reconnect to a session minimised from `sudo clai`, and vice versa. Explicit `CLAI_*_DIR` overrides still apply. Existing separate root-account history is left untouched rather than silently imported into another account; keep it when reviewing older sessions. Windows uses the current account's storage, including same-account elevation.

## History and context

Long transcripts retain every saved item while rendering and laying out only the visible window. Scrolling back, searching, and copying can still reach earlier items. Loading feedback appears before session restoration; prompt journals have per-session locks so an unrelated history save does not block `/prompts`.

`/new` starts a fresh session and saves the previous one. If work is still running or another terminal is attached, that session remains available to its agent and other viewers. `/save <name>` names a session, and `/prompts` browses sent prompts with their timestamps and provider, model, and effort metadata. Up/Down recalls the active session's sent prompts after reopening it. Prompt text is displayed literally, including placeholders such as `<provider>`.

Each run's “Worked for” summary includes its recorded line additions and removals when available. `/changes` shows the combined counts and per-file counts for the current session; these counts are saved with the session and restored on resume.

Context compaction reduces what the model receives while retaining recent requests, plans, task state, and available research findings. A chronological workstream ledger carries bounded request, response, and tool-evidence excerpts for earlier topics, including unrelated completed work, across repeated compactions and saved sessions. The main memory gives unfinished work the most detail; historical excerpts are not new instructions or proof of completion. Compaction does not erase the saved chat transcript. Use `/compact` to compact manually, `/context` to inspect context size, and `/output` to read retained tool output.

Standing user instructions are carried forward in a dedicated memory section across repeated compactions and saved sessions. If the summary rewords an inherited rule or proposes an unverified change, clai keeps the canonical rule and completes compaction; verified user changes and completed task constraints are reconciled locally. Project instruction files are re-injected separately. When the captured request fits, compaction appends its prompt to that request while preserving its cached prefix, tools, and settings, with no extra request for instruction reconciliation.

`/clear` deletes the current session and starts fresh. `/reset` clears all saved history. These are deletion commands; use `/new` when you want to keep the previous conversation.
