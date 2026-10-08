# Provider setup

clai connects to hosted models through API credentials or account sign-in, and to local models through Ollama. This guide documents clai's configuration. Access, pricing, rate limits, and model availability are controlled by each provider and account.

Use `/provider` to switch providers, `/model` to select a model, `/models` to browse catalogs, and `/info <provider>` for the integration's setup details. Account-visible catalogs are used where supported, with cached or bundled choices when discovery is unavailable. A model appearing in a catalog does not guarantee your account can use it.

## Account sign-in

| Integration | Command | Supported setup |
| --- | --- | --- |
| ChatGPT (Codex) | `clai auth chatgpt` | Browser or headless sign-in; `--import` reuses an existing Codex CLI login. The stored provider ID is `codex`. |
| GitHub Copilot | `clai auth copilot` | Browser/device sign-in or supported local credential import. |
| Cline | `clai auth cline` | Account sign-in or supported local credential import. |
| Kiro | `clai auth kiro` | Social login, AWS Builder ID, or IAM Identity Center; supported local sign-ins can be imported. |
| OmniRush | `clai auth omnirush` | Device-code sign-in; `--import` reuses an existing OmniRush CLI login. |
| Qoder | `clai auth qoder` | Browser or headless sign-in, Qoder CLI import, or personal access token via `--pat`. |
| Freebuff | `clai auth freebuff` | Browser/headless sign-in or token import; generation requires separate server admission. See [Freebuff](#freebuff). |

Authentication stores a credential; `clai use <provider>` selects the default provider:

```sh
clai auth qoder --headless
clai use qoder
clai
```

Use `clai auth <provider> --help` to inspect the flags. The flow and import sources depend on the integration; an upstream CLI is only needed for imports or features that explicitly invoke it.

### ChatGPT

```sh
clai auth chatgpt --headless
clai use chatgpt
```

`/model` uses the account-visible catalog where available, including model context limits and supported reasoning levels. `/usage` shows subscription limits, reset times, and credits when the account reports them. These account allowances are separate from session token totals. OpenAI API credentials use the separate `openai` integration.

### Qoder

```sh
clai auth qoder --import
clai use qoder
```

`--import` reuses a Qoder CLI sign-in. `clai auth qoder --pat` prompts for a personal access token with hidden input. Browser and headless methods are also available.

Select reasoning with `/effort`, for example `/effort xhigh`. clai sends Qoder's native thinking controls using the selected effort and renders streamed reasoning when the model provides it. Model capabilities and account limits still determine what is available.

`/models` retrieves Qoder's account-visible catalog, with cached or bundled choices if discovery is unavailable. When Qoder queues a model request, clai displays the queue status and resumes the request when the model becomes available. The default queue wait limit is one hour; `QODER_MODEL_QUEUE_MAX_WAIT_MS` sets a different limit in milliseconds. Cancelling the turn stops the wait and releases the queue lease. Reported input, output, cache, and reasoning usage feeds the session totals.

### Freebuff

Freebuff sign-in and model discovery are supported. Generation first requests a server session with a zero wallet-spend limit. Admission can be refused because of server compatibility, account restrictions, concurrent-session limits, quota, or model availability; successful sign-in and a visible model catalog do not establish inference access.

If generation is refused, follow the provider's message, use a supported Freebuff client, or choose another clai provider. Freebuff is excluded from automatic cross-provider fallback. clai does not automatically approve wallet-spend consent.

`clai auth freebuff --import` checks `FREEBUFF_API_KEY`, `CODEBUFF_API_KEY`, and supported upstream credentials, including `~/.config/manicode/credentials.json`. `FREEBUFF_CONFIG_DIR` can select the upstream configuration directory.

### OmniRush lifecycle uploads

For OmniRush sessions, clai can invoke the installed, signed-in OmniRush CLI after turns and at session close. The uploaded workspace is generated from lifecycle metadata: session ID, sequence, phase, status, and timestamp. It does not include project source, prompts, or the tool-output transcript.

Disable this feature with `CLAI_OMNIRUSH_SESSION_UPLOAD=0`. It is also disabled by private mode and `--no-history`. `OMNIRUSH_CLI_PATH` selects a custom executable. A missing CLI or login failure produces a notice without failing the agent turn.

## API credentials

`clai set <provider>` prompts for a key with hidden input. To import an existing environment variable:

```sh
clai set gemini --from-env GEMINI_API_KEY
clai use gemini
```

An environment credential is also used directly when no stored credentials take precedence. The table lists canonical provider IDs and recognized environment variables; it avoids pinning model names or prices that can change independently of clai.

| Integration | Provider ID | Environment variable |
| --- | --- | --- |
| Keyless Free | `free` | None required; optional `FREE_API_KEY`. |
| Anthropic | `anthropic` | `ANTHROPIC_API_KEY` |
| DeepSeek | `deepseek` | `DEEPSEEK_API_KEY` |
| Google Gemini | `gemini` | `GEMINI_API_KEY` |
| GLM / Zhipu | `glm` | `GLM_API_KEY`, `ZHIPU_API_KEY`, or `ZAI_API_KEY` |
| Kimi / Moonshot | `kimi` | `KIMI_API_KEY` or `MOONSHOT_API_KEY` |
| MiniMax | `minimax` | `MINIMAX_API_KEY` |
| Xiaomi MiMo | `mimo` | `MIMO_API_KEY` |
| NVIDIA NIM | `nvidia` | `NVIDIA_API_KEY` |
| OpenAI | `openai` | `OPENAI_API_KEY` |
| OpenRouter | `openrouter` | `OPENROUTER_API_KEY` |
| Qwen Cloud / DashScope | `qwen-cloud` | `DASHSCOPE_API_KEY` |
| AgentRouter | `agentrouter` | `AGENTROUTER_API_KEY` |
| AWS Mantle | `aws-mantle` | `ANTHROPIC_API_KEY` for this integration's configured endpoint. |
| Bynara | `bynara` | `BYNARA_API_KEY` |
| ExpLabs | `explabs` | `EXPLABS_API_KEY` |
| Fireworks | `fireworks` | `FIREWORKS_API_KEY` |
| Hetzner | `hetzner` | `HETZNER_API_KEY` |
| Lightning AI | `lightning` | `LIGHTNING_API_KEY` |
| Merge Gateway | `merge-gateway` | `MERGE_GATEWAY_API_KEY` |
| Meta Model API | `meta` | `MODEL_API_KEY` |
| Modal | `modal` | Both `MODAL_PROXY_TOKEN_ID` and `MODAL_PROXY_TOKEN_SECRET`. |
| OrcaRouter | `orcarouter` | `ORCAROUTER_API_KEY` |
| Token Harbor | `tokenharbor` | `TOKENHARBOR_API_KEY` |
| TokenRouter | `tokenrouter` | `TOKENROUTER_API_KEY` |
| Vercel AI Gateway | `vercel` | `AI_GATEWAY_API_KEY` |

For model choice, use `/model` or `clai model <name>`. Use the `/provider` picker's custom-provider option to add an OpenAI-compatible endpoint.

### Local and configurable endpoints

Ollama uses `OLLAMA_HOST` or an explicitly saved URL:

```sh
clai set ollama --url http://localhost:11434
clai use ollama
clai model <downloaded-model>
```

Modal needs the URL of your deployed endpoint in addition to its credentials:

```sh
clai set modal --url https://your-deployment.example.com --from-env MODAL_CREDENTIAL
```

Here, `MODAL_CREDENTIAL` contains `token-id:token-secret`. Alternatively, supply both native Modal environment variables and configure the endpoint URL separately. `MODAL_BASE_URL` is also supported. Lightning, TokenRouter, and Token Harbor support configured endpoints and the corresponding `LIGHTNING_BASE_URL`, `TOKENROUTER_BASE_URL`, and `TOKENHARBOR_BASE_URL` variables.

## Credential management and fallback

- Repeating `clai set <provider>` adds credentials, up to 10 per provider. `--stdin` reads a credential from standard input; `--skip-ping` saves it without provider validation.
- `/set` opens the key editor. Select an active key or disable a key without deleting it; disabled keys are skipped during rotation.
- `clai keys` and `/keys` display masked credentials. `clai unset <provider>` removes stored credentials; environment credentials remain available while set in the launching environment.
- Applicable authentication, quota, rate-limit, and server failures can rotate credentials. The most recently successful credential is preferred.
- Cross-provider fallback is opt-in through `/fallback on`. `/freeonly on` restricts fallback by clai's configured provider categories; this filter does not determine a model's price or account bill.

Saved credentials are retained in the plaintext recovery file `~/.clai/keys.json`, with restricted POSIX permissions, and are also written to the OS keyring when available. See [configuration and privacy](README.md#configuration-and-privacy).

## Web search

Web search is configured independently from the model provider.

| Search backend | Environment variable |
| --- | --- |
| DuckDuckGo | None required; initial default. |
| Brave | `BRAVE_SEARCH_API_KEY` |
| Tavily | `TAVILY_API_KEY` |
| Exa | `EXA_API_KEY` |

```sh
clai set tavily --from-env TAVILY_API_KEY
clai search-provider tavily
```

In the interactive console, `/search` opens the search picker; `/search <provider>` switches directly and `/search-provider` is an alias.
