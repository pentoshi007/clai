# Try the OpenTUI v2 UI locally

Requires a **real interactive terminal** (Terminal.app, iTerm, Kitty, Ghostty,
Windows Terminal, etc.). IDE “output” panels that are not a TTY will fall back
to Ink or the line REPL.

## Prerequisites

```sh
cd /path/to/clai-v2
npm install
# optional but recommended for OpenTUI native path
# install Bun: https://bun.sh
```

Configure at least one provider key if you want agent replies:

```sh
npm run dev -- set groq          # interactive, or:
npm run dev -- set groq gsk_...
npm run doctor                   # check keys + UI host
```

## Launch v2 (pick one)

```sh
# simplest (tsx / Node)
npm run dev:v2

# equivalent
npm run dev -- --ui=v2

# env opt-in (any subsequent `npm run dev` stays on v2 until unset)
CLAI_UI=v2 npm run dev

# preferred when Bun is installed (native OpenTUI FFI)
npm run dev:v2:bun
# or
bun run src/index.ts --ui=v2
```

Leave the session with `Ctrl+C` (configured to exit) or `/exit`.

## What you should see

- Alternate-screen full UI: status, chat, composer
- Type a prompt, `Enter` to submit (agent/ask depending on mode)
- `/` slash commands; `@path` mentions
- `Ctrl+H` plan toggle · `Ctrl+P` plan detail · `Ctrl+J` jobs · `Ctrl+R` search
- `Ctrl+T` thinking · `Ctrl+O` tool output expand

## Rollback to Ink / classic

```sh
npm run dev                 # default Ink TUI
npm run dev -- --ui=tui
npm run dev -- --classic    # line REPL
npm run dev -- --ui=legacy
unset CLAI_UI
```

## Troubleshooting

| Symptom | Fix |
|---|---|
| “v2 UI unavailable (not a TTY)” | Run in a real terminal app, not a non-interactive pipe |
| “terminal too small” | Resize ≥ 60×14 |
| Blank / crash on native load | Try `npm run dev:v2:bun` (Bun) |
| No model answers | `npm run doctor` → set a provider key |
| Want Ink back | omit `--ui=v2` / unset `CLAI_UI` |

## Headless smoke (no interactive UI)

```sh
npm run typecheck
npm test
npm run spike    # Bun headless OpenTUI spikes
```
