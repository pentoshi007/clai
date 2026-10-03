# clai

> A fast, terminal-native AI agent that runs real tools — built to run on **free API tiers and subscriptions you already pay for**, stay alive across rate limits with **multi-key + multi-provider switching**, and do serious work: **building, debugging, and scope-based pentesting / bug bounty**.

`clai` is an agentic CLI. It doesn't just describe what to do — it edits files, runs shell commands, scans hosts, fetches HTTP evidence, keeps a durable task plan, and verifies its own work before claiming success. It runs in your terminal with three full surfaces — an OpenTUI full-screen console (default on macOS/Linux), a classic Ink UI (default on Windows), and a noninteractive stream renderer for prompts and pipes. Every interactive surface is a full-screen app sharing the same features, commands, and session state.

Why people pick it over other agent CLIs:

- **Zero cost of entry.** A fresh install runs **keyless out of the box** on the built-in Free provider — no signup, no API key, no card. It stays useful at $0: Freebuff, Gemini, OpenRouter, NVIDIA NIM, Cline, Hetzner and Bynara are all first-class free options, and `/freeonly on` restricts cross-provider fallback to configured free-tier providers.
- **Account sign-in in the terminal.** Freebuff, ChatGPT, GitHub Copilot, Cline, and Kiro support account-based sign-in. Freebuff uses its browser/device approval flow and a hosted session; the subscription-backed providers use their respective subscription credentials.
- **One agent, ~25 providers.** DeepSeek, Kimi, GLM, MiniMax, MiMo, Qwen, OpenAI, Anthropic, Gemini, local Ollama, and a dozen OpenAI-compatible gateways — switch with one command, mid-session if you like.
- **It doesn't die on rate limits.** Up to 10 keys per provider with sticky rotation, optional cross-provider fallback, and retry/backoff tuned per provider. Long jobs survive flaky free tiers.
- **It's honest.** Findings need real tool output. Builds get typechecked/run before "done." Compaction and history keep long sessions coherent instead of hallucinating progress.

---

## Highlights

- **Free-tier first.** Built-in **keyless Free** gateway (`free-2/kilo-auto/free`) so a fresh install runs at no cost with zero setup — no API key required.
- **Account sign-in.** `clai auth <freebuff|cline|chatgpt|copilot|kiro|omnirush>` — provider-specific browser/device approval, with supported `--import` paths and multi-credential rotation.
- **Multi-key smart switching.** Up to 10 keys per provider with a *sticky* active key and circular rotation on rate-limit, quota, transient, or 5xx errors. Disable any key to skip it without deleting it. Optional cross-provider fallback and a free-only filter.
- **Broad provider support.** 25+ built-in providers: Freebuff, DeepSeek, Kimi (Moonshot), GLM (Zhipu AI), MiniMax, Xiaomi MiMo, OpenAI, Anthropic, Google Gemini, Ollama, NVIDIA NIM, OpenRouter, Qwen Cloud, Cline, Codex (ChatGPT), GitHub Copilot, Kiro, OmniRush, AgentRouter, AWS Mantle, TokenRouter, Token Harbor, Lightning AI, Modal, Meta, Fireworks, Hetzner, OrcaRouter, Merge Gateway, ExpLabs, Vercel AI Gateway — plus custom OpenAI-compatible endpoints.
- **Parallel subagents.** Independent investigations (recon, research, large refactors) run as read-only subagents concurrently; `/orchestrator` and `/subagents` control and inspect them, with per-role model chains.
- **Agent Skills.** Loads `SKILL.md`-based skills on demand — `/skills` manages them, and relevant skills surface automatically per prompt.
- **Scope-based pentesting.** Opt-in engagement scope with authorized/excluded targets, allowed phases, rate and concurrency ceilings, redirect and DNS-rebinding escape detection, and out-of-scope flagging — designed for authorized pentests and bug-bounty programs.
- **Real building & debugging.** Scaffolds apps, edits code surgically, installs packages, runs builds/tests, starts dev servers as background jobs, and probes them before reporting success.
- **Durable plans.** `plan.create` / `task.update` drive a live checklist that survives context compaction and reloads with `/history` — the agent works task-by-task and won't fake completion.
- **State-preserving compaction.** Automatic and manual `/compact` keep the latest user request verbatim alongside a deterministic work envelope: subagents (id, title, status, and a digest of results already read), live and finished background jobs, Responder-delegated tasks with their read state, touched files, and any credentials you supplied for the task. Before each model dispatch, clai estimates the current assembled request, including the incoming prompt and tool schemas, calibrated with provider-reported usage when available; it does not ask the model to guess its context size. Injected system blocks cannot displace the latest prompt, and successful manual compaction is saved even when the message count stays unchanged. When the history fits the model's window, the summary request replays the cached conversation prefix, so compaction is mostly a cache read.
- **Durable agent sessions.** Interactive sessions run behind a local broker, so an agent keeps working after `/minimise`, an SSH disconnect, or switching to another history session; `clai --resume <id>` reattaches to the same live UI and output stream.
- **Persistent interactive terminals.** Conversation-owned PTY or pipe sessions keep REPLs such as Python, Metasploit, Meterpreter, database consoles, and debuggers open across model turns.
- **Native + text tool calling.** Uses provider-native function calling where available, with a text-fence fallback (`toolCalling: auto|native|text`).
- **MCP, explicitly controlled.** Discovers local stdio and remote HTTP/SSE servers from project configs. MCP tools are off by default; `/mcp` inspects and adds servers, and picking one drops an editable `@mcp:<server>` token into your prompt.
- **Safety gate you control.** Every action is classified safe / confirm / block; deletes always confirm with a preview; destructive patterns are blocked.

---

## Install

### macOS
```sh
brew tap pentoshi007/clai && brew install clai
# or
curl -fsSL https://downloads.clai.aniketpandey.website/install/install.sh | sh
```

### Linux
```sh
curl -fsSL https://downloads.clai.aniketpandey.website/install/install.sh | sh
```

### Windows
```powershell
irm https://downloads.clai.aniketpandey.website/install/install.ps1 | iex
# or
scoop bucket add clai https://github.com/pentoshi007/clai && scoop install clai
```

### npm / from source
```sh
npm i -g @pentoshi/clai
# or
git clone https://github.com/pentoshi007/clai.git
cd clai && npm install && npm run build && npm start
```

Node.js ≥ 22. Type `clai` in any terminal to start.

> **Tip for Linux users:** For the best mouse and hover support in the full-screen TUI, modern GPU-rendered terminals like **Kitty**, **Alacritty**, or **WezTerm** are recommended. On macOS, **iTerm2** and the default Terminal work out of the box.

---

## Quick start

Out of the box, `clai` runs **keyless** on the built-in Free provider — no signup, no API key:

```sh
clai          # launch the full-screen agent console (already on the free provider)
```

Have a ChatGPT, Copilot, Cline, or Kiro subscription? Sign in instead of buying API credit:

```sh
clai auth chatgpt      # browser or device-code sign-in
clai use chatgpt
clai
```

Prefer a plain API key? Set it and start:

```sh
# Add an API key (DeepSeek shown; Gemini, OpenAI, Anthropic, Kimi, etc. work the same)
clai set deepseek sk-your_key_here
clai use deepseek

# Launch the full-screen agent console
clai

# Or one-shot directly from the shell
clai "explain what this repo does and find the entrypoint"
clai --mode agent "add a /health endpoint to the Express app and run the tests"
```

Prefer fully local and offline? Point at Ollama:

```sh
clai set ollama --url http://localhost:11434
clai use ollama
```

---

## Providers & Key Management

### Account sign-in providers (no conventional API key needed)

Sign in with an account you already have. Browser/device-code flows work on headless servers through a copyable link; `--import` reuses supported local sign-ins or imports provider tokens.

| Provider | Sign-in | Notes |
|----------|---------|-------|
| **Freebuff** | `clai auth freebuff` | Free, session-gated catalog; browser sign-in or headless link |
| **ChatGPT (Codex)** | `clai auth chatgpt` | Any ChatGPT tier incl. Free; mimics the official Codex CLI |
| **GitHub Copilot** | `clai auth copilot` | Incl. Copilot Free; mimics VS Code Copilot Chat |
| **Cline** | `clai auth cline` | Free `cline-free/*` models plus frontier catalog |
| **Kiro (AWS)** | `clai auth kiro` | AWS Builder ID, Google/GitHub social login, or IAM Identity Center SSO |
| **OmniRush** | `clai auth omnirush` | Device-code sign-in; `--import` reuses an existing OmniRush CLI login |

Up to 10 credentials can be stored per provider, with automatic key rotation on applicable authentication/quota errors. `clai auth <p> --import` imports supported local sign-ins; Freebuff also imports `FREEBUFF_API_KEY`, `CODEBUFF_API_KEY`, or the upstream `~/.config/manicode/credentials.json` token.

### API-key providers

| Provider | Default Model | Tier | Environment Variable |
|----------|---------------|------|----------------------|
| **Free (keyless)** | `free-2/kilo-auto/free` | Free · Keyless | — (no key needed) |
| **DeepSeek** | `deepseek-chat` | Paid / Usage | `DEEPSEEK_API_KEY` |
| **Kimi (Moonshot)** | `kimi-k3` | Paid / Usage | `KIMI_API_KEY` / `MOONSHOT_API_KEY` |
| **GLM (Zhipu AI)** | `glm-4-plus` | Free tier / Paid | `GLM_API_KEY` / `ZHIPU_API_KEY` |
| **MiniMax** | `MiniMax-Text-01` | Paid / Usage | `MINIMAX_API_KEY` |
| **Xiaomi MiMo** | `mimo-v2.6-pro` | Paid / Usage | `MIMO_API_KEY` |
| **Google Gemini** | `gemini-3.5-flash` | Free tier / Paid | `GEMINI_API_KEY` |
| **NVIDIA NIM** | `openai/gpt-oss-20b` | Free tier | `NVIDIA_API_KEY` |
| **OpenRouter** | `meta-llama/llama-3.3-70b-instruct:free` | Free / Paid | `OPENROUTER_API_KEY` |
| **Ollama** | `llama3.1:8b` | Local / Free | `OLLAMA_HOST` |
| **OpenAI** | `gpt-5.4-mini` | Paid | `OPENAI_API_KEY` |
| **Anthropic** | `claude-3-5-haiku-latest` | Paid | `ANTHROPIC_API_KEY` |
| **Qwen Cloud** | `qwen3.7-plus` | Paid (DashScope) | `DASHSCOPE_API_KEY` |
| **Bynara** | `mimo-v2.5-free` | Free | `BYNARA_API_KEY` |
| **Hetzner** | `Qwen/Qwen3.6-35B-A3B-FP8` | Free (experiment) | `HETZNER_API_KEY` |
| **AgentRouter** | `claude-opus-4-6` | Paid gateway | `AGENTROUTER_API_KEY` |
| **AWS Mantle** | `anthropic.claude-haiku-4-5` | Paid (AWS) | `ANTHROPIC_API_KEY` |
| **TokenRouter** | `moonshotai/kimi-k3` | Paid gateway | `TOKENROUTER_API_KEY` |
| **Token Harbor** | `claude-sonnet-5.5` | Paid gateway (free tier) | `TOKENHARBOR_API_KEY` |
| **Lightning AI** | `openai/gpt-5` | Free grant / Paid | `LIGHTNING_API_KEY` |
| **Modal** | `moonshotai/Kimi-K3` | Your own endpoint ($30/mo credit) | `MODAL_PROXY_TOKEN_ID` |
| **Meta (Muse)** | `muse-spark-1.2` | Paid | `MODEL_API_KEY` |
| **Fireworks** | `accounts/fireworks/models/kimi-k2p6` | Paid | `FIREWORKS_API_KEY` |
| **OrcaRouter** | `openai/gpt-4o-mini` | Paid gateway (zero markup) | `ORCAROUTER_API_KEY` |
| **Merge Gateway** | `openai/gpt-5.2` | Paid gateway | `MERGE_GATEWAY_API_KEY` |
| **ExpLabs** | `claude-fable-5.1` | Paid / BYOK gateway | `EXPLABS_API_KEY` |
| **Vercel AI Gateway** | `openai/gpt-5.4-mini` | Paid gateway | `AI_GATEWAY_API_KEY` |

Model catalogs use each provider's supported discovery source; most expose a dedicated models endpoint. Freebuff does not: clai reads account-visible model IDs from its read-only session endpoint and merges them with a source-versioned fallback. You can switch models anytime using `/model` or `clai model <name>`, browse the whole fleet with `/models`, and read setup details for any provider with `/info <provider>`.

### Freebuff setup and behavior

Freebuff is a hosted, free-tier provider that requires an account sign-in. Free-mode inference is only served to the genuine freebuff CLI: the server refuses direct API calls (free_mode_cli_required), so clai manages sign-in and the live model catalog but refuses generation requests fast with an actionable message. The default model is `z-ai/glm-5.3-flash`.

```sh
clai auth freebuff             # sign in, then approve in your browser
clai use freebuff
clai                           # start the interactive agent
clai model z-ai/glm-5.3-flash  # set a model from the catalog
# in the interactive console: /model · /info freebuff
```

On a desktop, `clai auth freebuff` opens the approval page when possible. On SSH/headless Linux it prints a URL to open on any device; no localhost callback or port-forwarding is required. To import an existing token, use `clai auth freebuff --import`. Import checks `FREEBUFF_API_KEY`, `CODEBUFF_API_KEY`, then the upstream `~/.config/manicode/credentials.json` file (or `FREEBUFF_CONFIG_DIR`). A token can also be entered with `clai set freebuff <token>`. clai stores credentials through its existing secure key storage; up to 10 credentials can be configured and rotated on authentication or quota errors.

The login token is an opaque bearer credential. It has no refresh token or documented expiry; if the server returns 401, sign in again or replace the token. Keep it secret and do not paste it into chat or commit it to a repository.

#### Sessions, models, and spending

clai admits no Freebuff session for inference and spends no wallet Freebucks: every direct inference attempt is refused server-side, so the request stops before any session state mutates. To use these models, run the genuine client (`npm i -g freebuff`, then `freebuff`). Because inference is unavailable, Freebuff is intentionally excluded from automatic cross-provider fallback; select it explicitly only for sign-in and catalog browsing.

`/model` lists only the models the server currently reports as applicable to the signed-in account (live rate-limit pools plus zero-price models, minus plan-gated ids), cached per credential for up to 30 minutes. The bundled model-ID table is only an offline fallback when the session probe is unreachable; nothing is hardcoded into the live list. Freebuff does not provide the separately probed `/api/v1/models` endpoint, nor does the session catalog publish per-model context-window limits. Context sizes therefore use clai's generic estimates rather than claimed live Freebuff limits. Modality and reasoning support are recognized from known model patterns; not every catalog item is guaranteed to support images or a configurable effort.

#### Tools, images, thinking, and caching

clai does not run Freebuff inference, so no Chat Completions or SSE streaming path is exercised against this provider. `/model` lists only the models the server currently reports as applicable to the signed-in account (live rate-limit pools plus zero-price models, minus plan-gated ids), cached per credential for up to 30 minutes. The bundled model-ID table is only an offline fallback when the session probe is unreachable; nothing is hardcoded into the live list.

On clean TUI shutdown and after a noninteractive run, clai awaits best-effort deletion of its own CLI session claims. Forced termination, process crashes, or an unreachable server can prevent that request; the server-side session expiry still applies. clai never sends a delete for a claim it does not own.

#### Troubleshooting

- **401 / invalid token:** run `clai auth freebuff` again or replace the saved token. There is no refresh-token flow.
- **409 session_superseded / 403 free_mode_cli_required on generation:** expected. The server only serves free-mode turns to the genuine freebuff CLI; clai refuses before spending anything. Use `freebuff` for these models or `/provider` for another provider.
- **Quota, model-unavailable, country, or account refusal:** follow the server's message; wait for the indicated reset/window or choose a currently available model with `/model`.
- **Wallet consent required:** clai has not spent anything. It always requests zero wallet spend; use a free-eligible model or review the purchase in a Freebuff-supported surface.
- **Catalog does not refresh:** `/model` uses the account-visible session response and a 30-minute per-account cache. If the session probe is unreachable, clai displays its bundled catalog fallback; the hosted `/api/v1/models` endpoint is not available.
- **Session remains after a forced stop:** clean exits attempt deletion; otherwise Freebuff's server-side expiry clears it.

### ChatGPT (Codex) subscription behavior

- `clai auth chatgpt` signs in with ChatGPT; `--headless` uses a device code, and `--import` reuses an existing Codex CLI sign-in.
- `/model` uses the live account-visible catalog and installed Codex client version. Model context limits and supported reasoning levels follow the catalog; account-scoped results refresh every five minutes and are cached for offline use.
- `/usage` shows ChatGPT subscription limits, reset times, and credits when the account reports them, alongside session token and cache usage. Subscription allowances are separate from session token totals.

### OmniRush session uploads

For OmniRush sessions, clai invokes the OmniRush CLI to upload a **synthetic lifecycle workspace** after turns and at session close. It contains the session id, sequence, lifecycle phase, status, and timestamp—not your project source, prompts, or tool-output transcript. The CLI must be available and signed in; missing CLI or login errors produce a notice without failing the agent turn.

Uploads are disabled by `--no-history`, private mode (`/privacy on`), or `CLAI_OMNIRUSH_SESSION_UPLOAD=0` (also accepts `false`, `off`, or `no`). `OMNIRUSH_CLI_PATH` selects a custom OmniRush executable.

### Manage Keys

```sh
clai set deepseek sk-first_key         # store a key
clai set deepseek sk-second_key        # add another key for multi-key rotation
clai set gemini --from-env GEMINI_API_KEY
echo "sk-..." | clai set deepseek --stdin
clai set ollama --url http://localhost:11434
clai keys                              # list providers with masked keys (★ active)
clai use deepseek                      # set active provider
clai provider                          # interactive provider/model selector
clai unset deepseek                    # remove keys for a provider
```

In the interactive console:
- **`/set`** opens the multi-row key editor. Add keys (`+`), set the active key (★), or disable a key (`○`) without deleting it.
- **`/keys`** displays configured keys (masked) and active status.
- **`/provider`** and **`/model`** open interactive pickers for switching providers and models on the fly.
- **`/info <provider>`** shows per-provider setup, pricing, and endpoint details.

### Smart Switching & Resilience

- **Multi-key rotation** — Store up to **10 keys per provider**. The last key that worked is *sticky*. On encountering a rate limit (HTTP 429), quota limit, auth error, or 5xx server error, `clai` automatically rotates to the next available key.
- **Disable without deleting** — Toggle any key disabled in the `/set` editor; rotation skips it until you re-enable it.
- **Cross-provider fallback** *(opt-in)* — `/fallback on` lets `clai` fall back to other configured providers when the active provider is exhausted.
- **Token-saving shell output** *(opt-in)* — `/rtk on` routes foreground `shell.exec` commands through [rtk](https://github.com/rtk-ai/rtk) via `rtk rewrite`, so the model reads compact output. Only the executed command changes: the model's tool call, approvals, and history keep the original, and the system prompt and tool schemas never change, so the prompt cache prefix is never invalidated. Background jobs, interactive/PTY sessions, sudo, and commands clai already reduces (nmap, ffuf, …) are never rewritten; if rtk is missing, busy updating, or fails, commands run unmodified. No rtk yet? `/rtk install` (or **Install rtk** on the `/rtk` screen) uses Homebrew, else rtk's checksum-verified installer, else cargo (winget, else cargo, on Windows) in the background; `/rtk update` upgrades through whichever tool installed it. rtk is found even when its directory is not on `PATH`, and a same-named impostor binary is skipped. All rewrite rules live in rtk itself, so updating rtk never requires a clai release.
- **Free-only mode** *(opt-in)* — `/freeonly on` restricts fallback strictly to free tiers (Free, Gemini, OpenRouter, NIM, Bynara, Hetzner, and the free-lane subscription providers) so you never accidentally spend.
- **Usage visibility** — `/usage` shows token consumption per provider and model, including cache reads and writes, so you can see what a session actually cost. It counts every billed request: subagents, title generation, compaction, and retried attempts whose stream died after the provider had already billed the prompt.

---

## What clai is good at

### Building & debugging

The same agent that runs recon also ships code. It explores before it writes, matches your existing stack from lockfiles, edits surgically, and proves the result:

- Scaffolds and extends apps; replaces starter boilerplate with real features.
- Surgical file tools: `fs.edit`, `fs.replaceLines`, `fs.append`, plus multi-file writes.
- Runs the checks that apply — typecheck, build, unit/integration tests — and fixes failures before claiming success.
- Starts dev servers as background jobs, tails until ready, probes `localhost`, and reports the URL / port / job id with the server left running.
- Debugging loop: reproduce → read the actual error → fix root cause → re-verify.

```sh
clai --mode agent "convert this Vite React app to Next.js App Router, keep all features, run the build"
clai --mode agent "this test is flaky — find the race and fix it"
```

### Parallel subagents & Agent Skills

For work with several independent threads — recon on multiple targets, researching unrelated bugs, surveying a large codebase — `clai` delegates read-only investigations to **subagents** that run concurrently and report back with evidence:

- `/orchestrator on|off|status|models` — control delegation and assign cheaper models to subagent roles.
- `/subagents` — inspect live assignments; stop or restart one by id.

**Agent Skills** extend the agent with reusable `SKILL.md` playbooks (bundled or your own). Skills are discovered from standard locations, ranked per prompt, and loaded on demand; `/skills list|refresh` manages them.

### Scope-based pentesting & bug bounty

`clai` is built to run real, authorized security work — not to narrate it. It follows a recon-first methodology and keeps you inside the boundaries you set.

```
recon / discovery  →  fingerprint stack  →  plan.create (kind=pentest)
        ↑                      │
        │              /implement (approve)
        │                      ↓
        └──── enumerate → exploit → post-ex → report
              (revise the plan as surface grows; keep completed tasks)
```

1. **Authorize once**, then optionally **define scope** — authorized targets, exclusions, allowed phases, rate/concurrency ceilings, and an expiry.
2. **Recon first** (read-only discovery needs no plan): whois, DNS, `net.pingSweep`, `http.fetch`, and shell tools like `nmap`, `ffuf`, `nuclei`, `sqlmap` — orchestrated with durable checkpoints.
3. **Analyze real evidence**, then `plan.create` with `kind=pentest` from actual ports/services/endpoints — then stop for your approval.
4. `/implement` and execute task-by-task; expand the plan as new attack surface appears without wiping completed work.
5. **Report** with structure — title, severity, evidence, reproduction, impact, remediation — and honest residual/untested notes.

**Scope enforcement is real, not cosmetic.** When scope is active, `clai` checks each target against your authorized/excluded lists, enforces token-bucket rate limits and a concurrency ceiling, detects **redirects that leave scope** and **DNS-rebinding escapes**, and flags out-of-scope hosts instead of touching them.

```sh
clai authorize-pentest AGREE
clai scope new --targets lab.example.com,10.10.0.0/24 --exclude prod.example.com \
  --phases recon,enumeration --max-rate 5 --max-concurrency 2
# in the console: /scope show · /scope add <targets> · /scope clear
```

### General security & sysadmin workflows

Log triage, config hardening, packaging, network analysis, OCR of a screenshot or PDF report, quick OSINT — all handled by the same agent under the same safety gate.

---

## Modes & reasoning

Codex subscription sessions preserve compatible encrypted reasoning for normal continuation. If a restored session's `/compact` request rejects it with `invalid_encrypted_content`, clai retries once on the same model without the rejected opaque replay, retaining visible text, tool history, and generation settings. Unrelated errors or failures after streamed output do not trigger this recovery; failed compaction retains the original context.

Three modes, switchable anytime with a slash command, `Shift+Tab`, or `clai --mode`:

| Mode | Use |
|------|-----|
| **ask** | Answers, methodology, and read-only tools — no mutations, no attacks. |
| **agent** | Executes: edits, installs, scans, verifies, works the plan. |
| **plan** | Research and design a durable plan; approve with `/implement` before execution. |

**Reasoning / thinking** is controlled with `/effort` (alias `/reasoning`), accepting `on`, `off`, `none`, `minimal`, `low`, `medium`, `high`, or `xhigh`. `clai` sends reasoning options only to models that support them.

---

## Safety gate

You own authorization; `clai` gates risk on every action:

| Level | Behavior |
|-------|----------|
| **safe** | Auto-runs read-only work: `fs.read/list/search`, `tool.check`, `http.fetch` GET, `web.search`/`web.fetch`, recon commands. |
| **confirm** | Applies the selected permission mode to mutations; filesystem scope can require approval even with `--yes` or a tool allow-list. |
| **block** | Refuses destructive patterns (`rm -rf /`, fork bombs, exfiltration signatures) and SSRF-prone fetches. |

Use `/permissions` in either UI to select a persistent permission mode:

| Permission mode | Writes, creates, edits | File deletion (`fs.delete` and shell `rm`) |
|-----------------|-----------------------|-------------------------------------------|
| **default** | Allowed inside the active folder; outside writes ask | Always asks |
| **auto-allow** *(default)* | Allowed everywhere | Allowed inside the active folder; outside or unresolved targets ask |
| **full-access everywhere** | Allowed everywhere | Allowed everywhere without confirmation |

Set a mode directly with `/permissions default`, `/permissions auto-allow`, or `/permissions full-access`, or from the CLI with `clai config set permissions <mode>`. The legacy `allow-all` value remains an alias for auto-allow; existing explicit choices survive upgrades and restarts. `/allow` and `/disallow` manage per-session tool allowances, but cannot bypass a required filesystem-scope prompt.

The active folder is the pinned project root, or the current working directory when no project is pinned—not every temporary directory. Shell checks cover direct, piped, compound, and wrapped deletion commands and account for explicit cwd, traversal, and symlink escapes. Dynamic targets, unsupported shell syntax, and indirect deletion with unresolved inputs require approval under auto-allow; this policy is not an OS sandbox. Full-access changes confirmation policy, not ask-mode restrictions, OS permissions, engagement scope, or hard safety blocks.

### Reviewing what you approve

Before you authorize anything, press **Ctrl+O** on any approval or password prompt to page the *complete* pending operation—the same way plan mode lets you read the plan before implementing. The review shows the operation name, working directory, active folder, resolved filesystem paths, and the full untruncated arguments, including complete shell commands and surrounding `cwd`.

- Press **Ctrl+O** on a tool, pentest, or sudo/secret prompt to open the review pager. Scroll it, search it, and close it to return to the pending prompt.
- Viewing approves nothing, cancels nothing, and executes nothing. The prompt stays pending until you answer it explicitly.
- Deletion prompts keep **v** for the existing file-content preview; **Ctrl+O** shows the operation descriptor instead. The content preview is capped while the descriptor is not.
- Sensitive values stay masked: password, secret, token, cookie and API-key fields are redacted, as are recognizable provider keys and `Bearer` credentials. Control characters are shown as escapes so nothing is silently hidden.
- Terminal/`-y` (non-interactive) runs page the same review before the y/n question when stdin is a TTY; without a TTY they still fail closed instead of reading a piped answer.
- Returning from the pager never authorizes. A partially typed password survives the round trip, and `esc` still cancels.

---

## Terminal UI

The interactive console provides streaming chat, nested tool cards, file diffs, a live plan pane, pickers, session history, and masked key prompts.

| Action | Key |
|--------|-----|
| Send / newline | `Enter` / `Shift+Enter` |
| Abort turn (keeps results) | `Esc` |
| Interrupt / quit | `Ctrl+C` (twice to quit) |
| Cycle mode (ask→agent→plan) | `Shift+Tab` |
| Plan pane / plan detail | `Ctrl+H` / `Ctrl+P` |
| Background jobs | `Ctrl+J` |
| Expand thinking / tool output | `Ctrl+T` / `Ctrl+O` |
| Copy focused thinking block | `c` |
| Search transcript | `Ctrl+R` |
| Copy selection | `Ctrl+Shift+C` |
| Commands / file mentions | `/` · `@` |
| MCP servers / project config | `/mcp` |
| Command help / shortcut reference | `Ctrl+G` / `/shortcuts` |

- **Thinking blocks:** Clickable `✦ Thought for 3.2s` rows open internal reasoning in a scrollable card (`Ctrl+T`). Pressing `c` copies the reasoning text.
- **Tool cards:** Show running commands with live elapsed timers, status indicators, and expandable output pagers (`Ctrl+O`) with search and copy capabilities. Large tool outputs spill to artifacts automatically, keeping the transcript and context window lean.
- **File diffs:** Edits and writes render clean inline diff previews before changes take effect.

### Background sessions, minimise, and SSH reattach

Interactive sessions run behind a local broker so an agent continues working across terminal disconnects:

- **`/minimise`** (or `/minimize`) detaches immediately and returns you to your shell without interrupting the turn. It displays the session ID and resume command.
- **SSH disconnects:** If an SSH session drops, reconnect and run `clai --resume <id>` (or `clai -c` to continue the latest session in the current directory).
- **`/history`** lists all active, attached, and detached sessions.

---

## Slash commands

| Command | Does |
|---------|------|
| `/ask` · `/agent` · `/plan` | Switch mode (plan = design a plan you approve before anything runs) |
| `/view-plan` | View the current plan without changing mode |
| `/implement` · `/discard` | Approve and execute or drop the current plan |
| `/model [name]` · `/models [filter]` | Select model · browse all models across providers |
| `/provider [name]` | Switch provider or open picker |
| `/set [provider]` · `/unset [provider]` · `/keys` | Manage API keys and view provider configuration |
| `/info [provider]` | Setup, pricing, and endpoint details for a provider |
| `/effort [level]` · `/reasoning [level]` | Configure thinking / reasoning effort |
| `/freeonly [on\|off]` · `/fallback [on\|off]` | Free-only filter · cross-provider fallback |
| `/orchestrator [...]` · `/subagents` | Control subagent delegation · inspect live subagents |
| `/rtk [on\|off\|status\|install\|update]` | Compress shell output through [rtk](https://github.com/rtk-ai/rtk) (off by default) · install or update rtk |
| `/skills [name\|list\|refresh]` | Manage Agent Skills |
| `/search [provider]` · `/search-provider` | Choose web-search backend |
| `/mcp [...]` | Browse, configure, start, or stop MCP servers |
| `/scope [show\|add\|new\|clear]` | Manage engagement scope |
| `/output [last\|id\|list]` | Open full tool output pager (also `Ctrl+O`) |
| `/jobs` | View background jobs (also `Ctrl+J`) |
| `/compact` · `/context` · `/usage` | Compact history · context size · token usage per provider/model |
| `/history` · `/save <name>` · `/new` · `/clear` · `/reset` | Session lifecycle management |
| `/allow <tool>` · `/disallow <tool>` · `/permissions` | Tool permission management |
| `/cwd <path>` | Change working directory |
| `/think` · `/thinking` | Show thinking from the last response |
| `/privacy [...]` | Private mode · clear history, logs, or artifacts |
| `/minimise` · `/minimize` | Detach terminal while the session runs in background |
| `/update` · `/help` · `/shortcuts` · `/exit` | Utilities and exit |

---

## CLI commands

```sh
clai [prompt...]                       # interactive UI, or one-shot with a prompt
  --mode <ask|agent|plan>  --provider <p>  --model <m>
  -y/--yes  --no-history
  --show-thinking  --verbose  --quiet    # one-shot stream controls
  --tui  --classic
  --resume <sessionId>  -c/--continue    # reattach live or reopen saved session

clai auth <provider>                   # OAuth sign-in: cline, chatgpt, copilot, kiro
                                       #   --import · --browser · --headless
clai set <provider> [key]              # --from-env <VAR> | --stdin | --url <url> | --skip-ping
clai unset <provider> [--url]          # remove all keys (or endpoint URLs) for a provider
clai keys                              # list providers with masked keys
clai use <provider>                    # set active provider
clai provider [provider]               # switch provider or open picker
clai model <model>                     # set model for the active provider
clai mode <ask|agent|plan>             # set default mode
clai search-provider <brave|tavily|exa|duckduckgo>
clai config [key] [value]              # view or update configuration
clai doctor                            # check installed tools + provider config
clai history [--show <id>]             # list saved sessions
clai update                            # check for updates and upgrade
clai authorize-pentest AGREE           # enable scan/attack tools (one-time ack)
clai scope <show|new|add|clear>        # engagement scope management
clai privacy <status|on|off|clear-all> # privacy and history clearing
```

---

## Model Context Protocol (MCP)

`clai` can discover and call tools from local or remote MCP servers. MCP tools are **off by default**; they are activated when a prompt mentions `@mcp:<server>` or via `/mcp all`.

### Project configuration

Define MCP servers in `.clai/mcp.json` (or standard `.vscode/mcp.json` / `.cursor/mcp.json` locations):

```json
{
  "servers": {
    "local": {
      "command": "my-mcp-server",
      "args": ["--root", "${workspaceFolder}"],
      "env": {
        "MCP_TOKEN": "${env:MCP_TOKEN}"
      }
    },
    "remote": {
      "url": "https://mcp.example.com/mcp",
      "headers": {
        "Authorization": "Bearer ${env:MCP_TOKEN}"
      }
    }
  }
}
```

Use `/mcp` inside the interactive console to browse servers, inspect available tools, view logs, restart connections, or add new servers interactively.

---

## Built-in tools

| Group | Tools |
|-------|-------|
| **Files** | `fs.read` · `fs.list` · `fs.search` · `fs.write` · `fs.writeMany` · `fs.edit` · `fs.replaceLines` · `fs.append` · `fs.delete` |
| **Shell & jobs** | `shell.exec` (servers: `background:"always"` + `name`) · `shell.jobs` · `shell.tail` · `shell.wait` · `shell.stop` |
| **Terminals** | `terminal.start` · `terminal.send` · `terminal.read` · `terminal.status` · `terminal.close` |
| **Network** | `tool.check` (with the install command for this OS) · `net.pingSweep` · `wordlist.find` (pentest sessions; plus `nmap`, `ffuf`, etc. via shell) |
| **HTTP / web** | `http.fetch` (raw evidence) · `web.search` · `web.fetch` (readable) |
| **Orchestration** | `subagent.start` · `subagent.list` · `subagent.wait` · `subagent.read` · `subagent.stop` — independent read-only tool calls in one response run in parallel |
| **Plan** | `plan.create` · `plan.clear` · `task.add` · `task.update` · `task.move` · `agent.handoff` |
| **MCP** | `mcp.list` · `mcp.tools` · `mcp.call` · `mcp.enable` · `mcp.connect` · `mcp.login` · `mcp.add` |
| **Context** | `image.ocr` · `image.view` · `pdf.read` · `skill.load` — OS, shell, and cwd arrive with every request |

---

## Web search / OSINT

| Provider | Key | Environment Variable |
|----------|-----|----------------------|
| **DuckDuckGo** | None (default) | — |
| **Brave** | Required | `BRAVE_SEARCH_API_KEY` |
| **Tavily** | Required | `TAVILY_API_KEY` |
| **Exa** | Required | `EXA_API_KEY` |

```sh
clai set brave bsx-...
clai set tavily tvly-...
clai search-provider tavily
```

---

## Per-project context

Drop a `.clai/context.md` in any project root, and its content is injected automatically on every turn — repo architecture, stack conventions, testing instructions, or scope rules. Project-level Agent Skills live alongside it under `.clai/skills/`.

---

## Interactive REPLs and terminals

When a task requires multi-step interactive terminal interactions, `clai` maintains a persistent terminal session attached to the conversation:

```text
Start a Python REPL, test the regular expression against our test cases, and show me the output.
```

The agent runs interactive commands in persistent PTY sessions, reads incremental output, sends follow-up commands, and safely terminates processes upon completion.

---

## Configuration & privacy

```sh
clai config                # view current config
clai mode agent            # set default mode
clai model <name>          # set default model
/privacy on                # private mode: don't persist this session
/privacy clear-all         # wipe history, logs, and artifacts
```

Config is stored locally in your OS user directory (e.g. `~/.config/clai/`). Keys are stored locally and never exposed in plain text.

---

## Development

```sh
npm install
npm run dev          # run from source
npm run typecheck
npm run build
npm run test:deterministic
npm run test:host
npm run compile      # compile native binaries with Bun
```

---

## Architecture

```
clai/
├─ src/
│  ├─ index.ts          # CLI entry + subcommands
│  ├─ agent/            # loop, plans, compaction, resume orientation, tool parsing
│  ├─ llm/              # providers, OAuth auth flows, streaming, key rotation + fallback
│  ├─ mcp/              # discovery, validation, transports, lifecycle, and tool dispatch
│  ├─ tools/            # fs, shell, terminal, net, http, web, batch, plan, subagents
│  ├─ skills/           # Agent Skills discovery, catalog, and on-demand loading
│  ├─ safety/           # risk classifier + engagement (scope) policy
│  ├─ store/            # config, history, keys, plans, scope
│  ├─ ui-core/          # renderer-neutral state, actions, layout, rendering, and ports
│  ├─ classic/          # React + Ink classic UI and POSIX terminal bootstrap
│  ├─ tui-v2/           # OpenTUI full-screen renderer
│  ├─ noninteractive/   # stdout/stderr-split one-shot stream renderer
│  ├─ app/              # session controllers, commands, events, and ports
│  └─ prompts/          # agent methodology (embedded for the compiled binary)
├─ install/ · manifests/
└─ package.json
```

---

## License

MIT.

**Use only on systems you are authorized to test.** clai is an operator's tool: authorization, scope, and impact are yours. The agent executes with the gates and confirmations you configure — nothing more.
