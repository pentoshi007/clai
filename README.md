# clai

`clai` is a cross-platform terminal AI assistant with two modes:

- `/ask`: read-only guidance. It suggests commands and explains them, but never executes tools.
- `/agent`: agent-oriented workflow. The v1 skeleton includes safety classification and command planning; tool execution is being built behind confirmation gates.

This repository is being implemented from `SRS.md`.

## Development

```sh
npm install
npm run dev
npm run typecheck
npm run build
```

## CLI examples

```sh
clai
clai --mode ask "create a python venv and install requests"
clai set groq gsk_xxxxxxxxxxxxxxxx
clai keys
clai use groq
clai doctor
```

## Provider environment variables

Runtime environment variables override stored keys:

- `GROQ_API_KEY`
- `GEMINI_API_KEY`
- `OPENROUTER_API_KEY`
- `OPENAI_API_KEY`
- `ANTHROPIC_API_KEY`
- `OLLAMA_HOST`
