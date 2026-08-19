# clai

> A fast, terminal-native AI agent that runs real tools — built to run on **free API tiers**, stay alive across rate limits with **multi-key + multi-provider switching**, and do serious work: **building, debugging, and scope-based pentesting / bug bounty**.

`clai` is an agentic CLI. It doesn't just describe what to do — it edits files, runs shell commands, scans hosts, fetches HTTP evidence, keeps a durable task plan, and verifies its own work before claiming success. It runs in your terminal with three full surfaces — an OpenTUI full-screen console (default on macOS/Linux), a classic Ink UI (default on Windows), and a noninteractive stream renderer for prompts and pipes. The original line-by-line REPL is gone: every interactive surface is a full-screen app sharing the same features, commands, and session state.

Two things make it practical for everyday use:

- **It's cheap-to-free to run.** A fresh install runs **keyless out of the box** on the built-in Free provider — no signup, no API key. Point it at Google Gemini, NVIDIA NIM, OpenRouter, Bynara, Hetzner, or a local Ollama — all have free access — and clai stacks them. Add several keys per provider; when one hits a rate limit, it rotates to the next automatically. Want frontier models instead? Serve **Kimi K3 on your own Modal endpoint** on Modal's **$30/month of free credit**, or start on **Lightning AI's 40M free tokens**.
- **It's honest.** Findings need real tool output. Builds get typechecked/run before "done." Compaction and history keep long sessions coherent instead of hallucinating progress.

---

## Highlights

- **Free-tier first.** 18 providers wired in, 6 cloud free tiers + local Ollama. The default provider is the **keyless Free** gateway (`free-1/deepseek-v4-flash-free`) so a fresh install runs at no cost with zero setup — no API key required.
- **Multi-key smart switching.** Up to 10 keys per provider with a *sticky* active key and circular rotation on rate-limit / auth / quota / transient / 5xx / empty-response errors. Disable any key or endpoint row to skip it without deleting it. Optional cross-provider fallback and a free-only filter.
- **Bring your own endpoint.** Deploy Kimi K3 (or Qwen / DeepSeek / GLM / GPT-OSS / your own fine-tune) to a [Modal](#modal--run-kimi-k3-on-your-own-endpoint-on-30month-of-free-credit) endpoint and drive it from clai on **$30/month of free compute credit**. Modal, Lightning AI and TokenRouter each keep a list of up to 10 base URLs with a sticky active one, so several deployments live side by side and you switch with one command — same editor, same ★ active row as keys.
- **Scope-based pentesting.** Opt-in engagement scope with authorized/excluded targets, allowed phases, rate and concurrency ceilings, redirect and DNS-rebinding escape detection, and out-of-scope flagging — designed for authorized pentests and bug-bounty programs.
- **Real building & debugging.** Scaffolds apps, edits code surgically, installs packages, runs builds/tests, starts dev servers as background jobs, and probes them before reporting success.
- **Durable plans.** `plan.create` / `task.update` drive a live checklist that survives context compaction and reloads with `/history` — the agent works task-by-task and won't fake completion.
- **Persistent interactive terminals.** Conversation-owned PTY or pipe sessions keep REPLs such as Python, Metasploit, Meterpreter, database consoles, and debuggers open across model turns. The agent can send follow-up input, read incremental output, resize, interrupt, and close them without losing state.
- **Native + text tool calling.** Uses provider-native function calling where available, with a text-fence fallback (`toolCalling: auto|native|text`).
- **Safety gate you control.** Every action is classified safe / confirm / block; deletes always confirm with a preview; destructive patterns are blocked.

---

## Install

### macOS
```sh
brew tap pentoshi007/clai && brew install clai
# or
curl -fsSL https://raw.githubusercontent.com/pentoshi007/clai/main/install/install.sh | sh
```

### Linux
```sh
curl -fsSL https://raw.githubusercontent.com/pentoshi007/clai/main/install/install.sh | sh
```

### Windows
```powershell
irm https://raw.githubusercontent.com/pentoshi007/clai/main/install/install.ps1 | iex
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

### Platform notes

| Environment | Default surface | Explicit alternative |
|---|---|---|
| Interactive macOS/Linux terminal at least 60×14 | OpenTUI full-screen console | `clai --classic` for the Ink UI |
| Interactive Windows terminal | Classic Ink UI | `--ui classic` / `--classic` |
| stdin or stdout is not a TTY | Noninteractive stream renderer | use a prompt or pipe stdin |

**Windows:** the platform-selection code chooses the classic Ink UI before any Bun/OpenTUI
startup probe. This repository's macOS validation does not claim Windows Terminal,
PowerShell, cmd.exe/conhost, VS Code terminal, ConPTY, or Windows-binary runtime evidence;
those target-host checks remain release gates. Use `clai --classic` explicitly when you want
the same selection on any platform.

**Linux — terminal recommendations for full mouse & hover support:**

The full-screen TUI uses mouse tracking and hover events via OpenTUI's Zig FFI renderer. Not all Linux terminal emulators report these correctly. If you see missing hover highlights, broken scroll, or no mouse response:

| Terminal | Mouse/Hover | Notes |
|----------|-------------|-------|
| **Kitty** | ✅ Full | Recommended — fastest GPU-rendered terminal, full mouse protocol support |
| **Alacritty** | ✅ Full | GPU-accelerated, excellent mouse support |
| **WezTerm** | ✅ Full | Cross-platform, great defaults |
| **iTerm2** (macOS) | ✅ Full | Native macOS, full mouse + hover |
| **macOS Terminal** | ✅ Full | Works out of the box |
| **GNOME Terminal** | ⚠️ Partial | Mouse clicks work; hover/SGR mouse mode may be limited |
| **Konsole** | ⚠️ Partial | Some hover events may not report |
| **xterm** | ⚠️ Partial | Needs `xterm -xrm 'XTerm*allowMouseOps: true'` |
| **Linux TTY** (bare `/dev/tty`) | ❌ None | No mouse support; use `clai --classic` |
| **tmux / screen** | ⚠️ Varies | Add `set -g mouse on` to `~/.tmux.conf`; passthrough depends on the outer terminal |

> **Tip:** For the best experience on Linux, use **Kitty**, **Alacritty**, or **WezTerm**. These support SGR extended mouse reporting, which is what OpenTUI requires for hover, click, and scroll events. If your terminal doesn't support hover, clai still works — you just won't see hover highlights on buttons and links.
>
> For tmux users: `set -g mouse on` enables mouse passthrough, but hover quality depends on the outer terminal emulator.

---


## Quick start

Out of the box, clai runs **keyless** on the built-in Free provider — no signup, no API key:

```sh
clai          # launch the full-screen agent console (already on the free provider)
```

Prefer a different provider? Get a free key, add it, and go:

```sh
# Add a free key (NVIDIA shown; Gemini/OpenRouter/Bynara/Hetzner work the same)
clai set nvidia nvapi-your_key_here
clai use nvidia

# Launch the full-screen agent console
clai

# Or one-shot from the shell
clai "explain what this repo does and find the entrypoint"
clai --mode agent "add a /health endpoint to the Express app and run the tests"
```

Prefer fully local and offline? Point at Ollama:

```sh
clai set ollama --url http://localhost:11434
clai use ollama
```

Want a frontier open model on your own hardware budget? Deploy **Kimi K3** to a Modal endpoint and run it on Modal's **$30/month of free compute credit** — see [Modal](#modal--run-kimi-k3-on-your-own-endpoint-on-30month-of-free-credit).

---

## Run it on free tiers (and keep it running)

This is the core of clai's design: assemble capacity from free tiers, then survive rate limits automatically.

### Supported providers

| Provider | Default model | Tier | Env var |
|----------|---------------|------|---------|
| Free (keyless) | `free-1/deepseek-v4-flash-free` | Free · keyless | — (no key needed) |
| NVIDIA NIM | `openai/gpt-oss-20b` | Free | `NVIDIA_API_KEY` |
| Google Gemini | `gemini-3.5-flash` | Free | `GEMINI_API_KEY` |
| OpenRouter | `meta-llama/llama-3.3-70b-instruct:free` | Free | `OPENROUTER_API_KEY` |
| Bynara | `mimo-v2.5-free` | Free | `BYNARA_API_KEY` |
| Ollama | `llama3.1:8b` | Local / free | `OLLAMA_HOST` |
| OpenAI | `gpt-5.4-mini` | Paid | `OPENAI_API_KEY` |
| Anthropic | `claude-3-5-haiku-latest` | Paid | `ANTHROPIC_API_KEY` |
| AgentRouter | `claude-opus-4-6` | Paid | `AGENTROUTER_API_KEY` |
| AWS Mantle | `anthropic.claude-haiku-4-5` | Paid | `ANTHROPIC_API_KEY` |
| Qwen Cloud | `qwen3.7-plus` | Paid (DashScope) | `DASHSCOPE_API_KEY` |
| Modal | `moonshotai/Kimi-K3` | Usage-based ($30/mo credit) | `MODAL_PROXY_TOKEN_ID` + `MODAL_PROXY_TOKEN_SECRET` |
| Lightning AI | `openai/gpt-5` | Per token (40M free to start) | `LIGHTNING_API_KEY` |
| TokenRouter | `moonshotai/kimi-k3` | Per token (prepaid) | `TOKENROUTER_API_KEY` |
| Meta (Muse Spark) | `muse-spark-1.2` | Paid (per token) | `MODEL_API_KEY` |
| Fireworks | `accounts/fireworks/models/kimi-k2p6` | Paid (per token) | `FIREWORKS_API_KEY` |
| Hetzner | `Qwen/Qwen3.6-35B-A3B-FP8` | Free (experiment — no billing yet) | `HETZNER_API_KEY` |
| OrcaRouter | `openai/gpt-4o-mini` | Paid (per token, zero markup) | `ORCAROUTER_API_KEY` |

Several "paid" providers also expose limited free allowances — the tier label reflects what the default keys usually buy you. Flip `freeOnly` off to include paid providers in fallback.

#### Free — keyless, zero setup

clai's default provider needs **no account, no API key, and no config**. It bundles **two keyless gateways** under one provider, namespaced by source so overlapping model names never collide: `free-1/…` ids come from the primary gateway and `free-2/…` ids from the [Kilo gateway](https://api.kilo.ai/api/gateway). Both serve rotating catalogs of free OpenAI-compatible models — `free-1/deepseek-v4-flash-free` (default), `free-1/mimo-v2.5-free`, `free-1/hy3-free`, `free-2/kilo-auto/free`, `free-2/stepfun/step-3.7-flash:free`, `free-2/nvidia/nemotron-3-ultra-550b-a55b:free` — with SSE streaming, native tool calling, and `reasoning_content` thinking folded into the normal `/think` block.

```sh
clai                          # already on free — nothing to set up
/model                        # live catalogs from both gateways, free-1/… + free-2/… (cached 1h)
```

- **Keyless by design.** Requests go out with no `Authorization` header; `/model` lists only the keyless models from each gateway, so premium ids stay hidden until you add a key.
- **Two sources, one provider.** Pick `free-1/…` or `free-2/…` in `/model`; a bare id with no prefix routes to `free-1`. If one gateway is rate limited, switching to the other is one `/model` pick away.
- **Optional key upgrades you.** `clai set free <key>` (or `FREE_API_KEY`) unlocks premium models on your account. Premium ids without a key fail fast with a clear 402-style message instead of a confusing upstream error.
- **Best-effort tier.** The free sets rotate upstream and are capacity-constrained / rate limited — if a request fails, retry once. For dependable daily use, add a key for any other provider (`clai set <provider> <key>`, then `clai use <provider>`).

#### Modal — run Kimi K3 on your own endpoint, on $30/month of free credit

[Modal Endpoints](https://modal.com/docs/guide/endpoints) deploy an open-weight model on your own serverless URL that speaks the OpenAI Chat Completions API. That's the cheapest route to a **frontier open model like Kimi K3** from clai: the Starter plan is $0/month and includes **$30 of compute credit every month** once a payment method is on file, endpoints scale to zero so idle time costs nothing, and billing is per-second compute rather than per token.

Kimi K3, start to finish:

```sh
pip install modal && modal setup                                 # once
modal endpoint create --model moonshotai/Kimi-K3 --name kimi-k3  # prints an id + dashboard link
modal endpoint list                                              # copy the endpoint URL from here
modal workspace proxy-tokens create                              # wk-… id + ws-… secret (shown once)

clai set modal --url <endpoint-url>     # e.g. https://ws--ep-kimi-k3-server.us-west.modal.direct
clai set modal wk-yourTokenId:ws-yourTokenSecret
clai use modal                          # model defaults to moonshotai/Kimi-K3
```

The catalog also covers Qwen, DeepSeek, GLM, Gemma, GPT-OSS, Nemotron and your own fine-tunes — swap `--model` and deploy another endpoint. Two things differ from every other provider: the base URL belongs to your workspace, and auth is a [proxy token](https://modal.com/docs/guide/webhook-proxy-auth) *pair* sent as `Modal-Key` / `Modal-Secret` instead of a bearer key. Endpoints are authenticated by default, and proxy tokens (`wk-`/`ws-`) are not interchangeable with Modal API tokens (`ak-`/`as-`).

Endpoints and token pairs are both multi-entry lists with a sticky active choice, up to 10 each:

```sh
clai set modal --url <a> --url <b>     # store two deployments; the last becomes active
clai set modal --url <a>               # re-passing a known URL just activates it
clai unset modal --url                 # clear the URLs, keep the token pairs
clai keys                              # every URL listed, ★ marks the active one
```

Token pairs rotate on failure like any other provider's keys (the pair is stored as one `id:secret` string). Endpoints fail over alongside them: on a rate limit, workspace/auth mismatch, quota error, or 5xx, clai tries the next stored endpoint with the next key, and the ★ active endpoint sticks to the one that worked, so the next run starts on the healthy URL. `MODAL_BASE_URL` overrides the stored list entirely.

From inside the console, `/provider modal` walks the same setup in two prompts — endpoint URL first (shown in full, since it isn't a secret), then the token pair — and leaves the active provider untouched if you cancel.

Sticky sessions are on by default — clai sends a `Modal-Session-ID` per run so a whole conversation stays on one warm container, which keeps the prompt cache hot and avoids paying a cold start mid-task (override with `MODAL_SESSION_ID`). The first request after idle still pays container start-up, so clai allows up to 3 minutes for the first token.

`/info modal` prints the whole thing as a walkthrough: numbered setup steps, which credentials go where, the plan limits (Starter also caps you at 3 seats, 100 containers and 10 GPUs of concurrency), and a troubleshooting table.

#### Lightning AI (one key, many vendors)

[Lightning AI Model APIs](https://lightning.ai/docs/platform/inference/model-apis) are an OpenAI-compatible gateway in front of OpenAI, Anthropic, Google and Lightning-hosted open models — one key, billed per token, with **up to 40 million free tokens to start**. Model ids are vendor-namespaced.

```sh
clai set lightning <your-api-key>      # key: lightning.ai → Model APIs → show API key
clai use lightning
/model openai/gpt-5                    # or anthropic/claude-opus-4-8, google/gemini-3.5-flash,
                                       #    lightning-ai/gpt-oss-120b (cheapest open weights)
```

`/model` reads the gateway's live catalog (41 ids at last check) and dedupes it. Keys are multi-key with rotation like everywhere else. The base URL defaults to the shared gateway but is overridable the same way as Modal's — point it at a private Lightning Inference deployment with `clai set lightning --url <url>`, or `LIGHTNING_BASE_URL`. Costs vary by orders of magnitude across the catalog, so check `/info lightning` before long agent runs.

#### TokenRouter (frontier open models, one key)

[TokenRouter](https://docs.tokenrouter.me) is an OpenAI-compatible gateway to Kimi, DeepSeek, Qwen, GLM, GPT-OSS and MiniMax — long-context open models aimed at agentic coding, billed per token from a prepaid balance.

```sh
clai set tokenrouter sk-your-key        # key: your account → API Keys
clai use tokenrouter                    # model defaults to moonshotai/kimi-k3
/model deepseek/deepseek-v4-pro         # 1M context · or moonshotai/kimi-k2.7-code, z-ai/glm-5.1, MiniMax-M3
```

Model ids are vendor-namespaced (`moonshotai/kimi-k2.6`, `deepseek/deepseek-v4-pro`, `qwen/qwen3.7-plus`); the old short ids (`kimi-k2p6`, `glm-5p1`, …) are still accepted and silently redirected to the current namespaced id. `/model` reads the live `/models` list, which is filtered to the channels your key can reach. clai carries the real per-model context windows — 1M for DeepSeek V4, 512K for MiniMax M3, 256K for Kimi/Qwen, 200K for GLM — so the context meter and auto-compaction are accurate instead of guessing 128K. Reasoning arrives as `reasoning_content` and is folded into the normal thinking block, so `/think` and `/effort` work. Base URL defaults to `https://api.tokenrouter.com/v1` and is overridable with `clai set tokenrouter --url <url>` or `TOKENROUTER_BASE_URL` if your account uses a different host.

#### Fireworks and Hetzner (open-model inference)

[Fireworks](https://fireworks.ai) is a per-token inference gateway for open models — Kimi, DeepSeek, GLM, Qwen, GPT-OSS, Llama — with SSE streaming and native tool calling.

```sh
clai set fireworks fw_your_key          # key: fireworks.ai → API keys
clai use fireworks                      # model defaults to accounts/fireworks/models/kimi-k2p6
```

[Hetzner Inference](https://docs.hetzner.com/general/company-and-policy/experiments/inference/) is Hetzner's OpenAI-compatible experiment API serving open-weight models (Qwen3.6-35B with vision, 262K context) from EU servers. It is free while experimental — there is no billing yet — with fair-use per-key rate limits and no SLA or production guarantee.

```sh
clai set hetzner your-token             # token: experiments.hetzner.com → Create API Token
clai use hetzner                        # model defaults to Qwen/Qwen3.6-35B-A3B-FP8
```

Both fetch the live model catalog for `/model` (cached 1h) and rotate keys like every other provider.

#### OrcaRouter (one key, eleven upstreams, zero markup)

[OrcaRouter](https://docs.orcarouter.ai) is an OpenAI-compatible gateway that routes OpenAI, Anthropic, Google Gemini, DeepSeek, xAI Grok, Qwen, Kimi, MiniMax, Z.ai GLM and more behind one key — billed at each provider's published price with no token markup. Model ids are vendor-prefixed (`openai/gpt-4o-mini`, `anthropic/claude-sonnet-4.6`, `google/gemini-2.5-flash`, `deepseek/deepseek-reasoner`, …), and `orcarouter/auto` picks the cheapest model that fits the request.

```sh
clai set orcarouter sk-your-key        # key: orcarouter.ai/console (starts with sk-)
clai use orcarouter                    # model defaults to openai/gpt-4o-mini
/model anthropic/claude-sonnet-4.6     # or any id from the live /models catalog
```

Streaming, native tool calling, structured outputs (`response_format`), vision via `image_url` and prompt caching all work. Reasoning uses one unified `reasoning_effort` knob (low/medium/high, plus minimal/max on some models) that the gateway translates to each upstream's native shape — `/think` and `/effort` map onto it, and thinking arrives as `reasoning_content` in the usual thinking block. `/model` reads the live catalog (cached 1h), filtered to Chat-Completions-reachable models so image/video/tts ids stay out of the picker. Keys are multi-key with rotation like everywhere else; env var is `ORCAROUTER_API_KEY`.

### Manage keys

```sh
clai set nvidia nvapi-first_key        # store a key (appends if one exists)
clai set nvidia nvapi-second_key       # add another key for the same provider
clai set gemini --from-env GEMINI_API_KEY
echo "nvapi-..." | clai set nvidia --stdin
clai set ollama --url http://localhost:11434
clai set modal --url https://ws--ep-kimi-k3-server.us-west.modal.direct   # endpoint (repeatable)
clai set modal wk-tokenId:ws-tokenSecret   # …then the proxy token pair
clai set lightning <key>               # Lightning AI Model APIs
clai set tokenrouter sk-your-key       # TokenRouter
clai set fireworks fw_your_key         # Fireworks
clai set hetzner your-token            # Hetzner Inference (experiments.hetzner.com)
clai set orcarouter sk-your-key        # OrcaRouter (orcarouter.ai/console)
clai set free <key>                    # optional: unlock premium models (free is keyless by default)
clai unset modal --url                 # drop stored endpoint URLs, keep the keys
clai keys                              # providers + masked keys (★ active) + endpoint URLs
clai use nvidia                        # set active provider
clai provider                          # interactive provider/model picker
clai unset nvidia                      # remove ALL keys for a provider
```

In the console, **`/set`** opens a multi-row editor: add rows with `+`, remove rows, star a row to make it the active one, or disable a row to skip it in rotation without deleting it (`d` in the classic UI, `Ctrl+D` or the ○ marker in OpenTUI) — then **Save**, or **Reset all**. Providers with their own base URL (Modal, Lightning AI, TokenRouter) get a second **endpoints** row in the `/set` picker that edits their URL list the same way — URLs are shown in full rather than masked, since they aren't secrets. `/set <provider> https://…` adds and activates one URL directly. **`/keys`** lists keys masked plus the active endpoint, marking disabled rows `(disabled)`; **`/unset`** clears a provider. Disabled entries are never tried until re-enabled, and disabling every key for a provider fails fast with a clear error instead of burning requests.

### Smart switching (how it stays up)

- **Multi-key rotation** — up to **10 keys per provider**. The last key that worked is *sticky*; on failure clai rotates circularly to the next key. Endpoint providers (Modal, Lightning AI, TokenRouter) fail over their stored endpoints alongside the keys, and the ★ active endpoint follows the one that worked.
- **Disable without deleting** — toggle any key or endpoint row disabled in the `/set` editor and rotation skips it until you re-enable it.
- **What triggers a switch** — HTTP 429 (rate limit), 401/403 (auth), 402 / quota / billing text, transient network errors, 500–504, and empty completions. Auth and quota errors switch **immediately** (no backoff wait); rate limits back off briefly first.
- **Cross-provider fallback** *(opt-in)* — `/fallback on` lets clai try other configured providers after the active one is exhausted (only when running a provider's default model).
- **Free-only mode** *(opt-in)* — `/freeonly on` excludes paid-cloud providers from the fallback chain, so you never accidentally spend.
- **Quiet status** — a single non-stacking status line shows what happened, e.g. `switching nvidia key [2/4] …ab12 (rate limited)`. Keys are always masked to the last 4 chars.

```sh
/freeonly on      # stay on free tiers only
/fallback on      # allow other providers when the current one is exhausted
```

---

## What clai is good at

### Building & debugging

The same agent that runs recon also ships code. It explores before it writes, matches your existing stack from lockfiles, edits surgically, and proves the result:

- Scaffolds and extends apps; replaces starter boilerplate with real features (a scaffold alone is treated as incomplete).
- Surgical file tools: `fs.edit`, `fs.replaceLines`, `fs.append`, plus multi-file writes.
- Runs the checks that apply — typecheck, build, unit/integration tests — and fixes failures before claiming success.
- Starts dev servers as background jobs, tails until ready, probes `localhost`, and reports the URL / port / job id with the server left running.
- Debugging loop: reproduce → read the actual error → fix root cause → re-verify (never "diagnosed but not fixed").

```sh
clai --mode agent "convert this Vite React app to Next.js App Router, keep all features, run the build"
clai --mode agent "this test is flaky — find the race and fix it"
```

### Scope-based pentesting & bug bounty

clai is built to run real, authorized security work — not to narrate it. It follows a recon-first methodology and keeps you inside the boundaries you set.

```
recon / discovery  →  fingerprint stack  →  plan.create (kind=pentest)
        ↑                      │
        │              /implement (approve)
        │                      ↓
        └──── enumerate → exploit → post-ex → report
              (revise the plan as surface grows; keep completed tasks)
```

1. **Authorize once**, then optionally **define scope** — authorized targets, exclusions, allowed phases, rate/concurrency ceilings, and an expiry.
2. **Recon first** (read-only discovery needs no plan): whois, DNS, `net.scan`, `net.context`, `http.fetch`, `pentest.recon`, and shell tools like `nmap`, `ffuf`, `nuclei`, `sqlmap`.
3. **Analyze real evidence**, then `plan.create` with `kind=pentest` from actual ports/services/endpoints — then stop for your approval.
4. `/implement` and execute task-by-task; expand the plan as new attack surface appears without wiping completed work.
5. **Report** with structure — title, severity, evidence, reproduction, impact, remediation — and honest residual/untested notes.

**Scope enforcement is real, not cosmetic.** When scope is active, clai checks each target against your authorized/excluded lists, enforces token-bucket rate limits and a concurrency ceiling, detects **redirects that leave scope** and **DNS-rebinding escapes**, and flags out-of-scope hosts instead of touching them. Loopback GET/HEAD stays allowed for local dev verification. Scope is opt-in: with no scope defined, scoping is simply off.

```sh
clai authorize-pentest AGREE
clai scope new --targets lab.example.com,10.10.0.0/24 --exclude prod.example.com \
  --phases recon,enumeration --max-rate 5 --max-concurrency 2
# in the console: /scope show · /scope add <targets> · /scope clear
```

Dedicated recon tools: `pentest.recon` (bundled whois/dns/nmap), `pentest.webDiscover` (scoped path discovery), `pentest.apiEnumerate` (OpenAPI/Swagger), `pentest.authCompare` (auth-context diffing), `pentest.scanStatus` (durable scan checkpoints).

### General security & sysadmin workflows

Log triage, config hardening, packaging, network questions, OCR of a screenshot or PDF report, quick OSINT — all handled by the same agent under the same safety gate.

---

## Modes & reasoning

Three modes, switchable anytime with a slash command, `Shift+Tab`, or `clai --mode`:

| Mode | Use |
|------|-----|
| **ask** | Answers, methodology, and read-only tools — no mutations, no attacks. |
| **agent** | Executes: edits, installs, scans, verifies, works the plan. |
| **plan** | Research and design a durable plan; approve with `/implement` before execution. |

**Reasoning / thinking** is controlled with `/effort` (alias `/reasoning`), accepting `on`, `off`, `none`, `minimal`, `low`, `medium`, `high`, or `xhigh`. clai only sends reasoning options to models that support them — and if a model rejects them at runtime, it marks that model, retries once without them, and tells you (`… rejected reasoning options — retrying without them`) so a session never hangs on an unsupported knob.

---

## Safety gate

You own authorization; clai still gates risk on every action:

| Level | Behavior |
|-------|----------|
| **safe** | Auto-runs read-only work: `fs.read/list/search`, `sysinfo`, `dns.lookup`, `whois.lookup`, `http.fetch` GET, `web.search`/`web.fetch`, recon scanners. |
| **confirm** | Asks first for mutations: file writes/edits, installs, moves, aggressive/mutating shell. |
| **block** | Refuses destructive patterns (`rm -rf /`, fork bombs, classic exfil signatures) and SSRF-prone fetches. |

`fs.delete` always confirms (with an optional `v` preview) even under allow-all. `tool.batch` inherits the highest risk level of its children. Use `/permissions` to choose the default confirmation level and `/allow` / `/disallow` for a per-session tool allow-list.

---

## Terminal UI

The old line REPL has been removed — there are only full surfaces now. An OpenTUI full-screen console is selected for a sufficiently large interactive POSIX terminal. The classic Ink UI is selected on Windows, on smaller terminals, or with `--classic`; non-TTY prompts use the noninteractive stream renderer. In the classic UI, mouse reporting is on by default so wheel swipes scroll the live tail and panels instead of being misread as prompt-history keys; native text selection stays one modifier away (Shift/Option/Fn), and `CLAI_CLASSIC_MOUSE=0` turns mouse reporting off. The interactive surfaces provide streaming chat, nested tool cards (including `tool.batch` sub-calls), file diffs, a live plan pane, pickers, history, and secure masked key prompts.

| Action | Key |
|--------|-----|
| Send / newline | `Enter` / `Shift+Enter` |
| Abort turn (keeps results) | `Esc` |
| Interrupt / quit | `Ctrl+C` (twice to quit) |
| Cycle mode (ask→agent→plan) | `Shift+Tab` |
| Plan pane / plan detail | `Ctrl+H` / `Ctrl+P` |
| Background jobs | `Ctrl+J` |
| Expand thinking / tool output | `Ctrl+T` / `Ctrl+O` |
| Search transcript | `Ctrl+R` |
| Copy selection | `Ctrl+Shift+C` |
| Commands / file mentions | `/` · `@` |
| Help / shortcuts | `Ctrl+G` |

Tool cards show the command/input clearly, with a live elapsed timer next to the command name while they run (the final duration stays visible afterwards), and keep long scan tails in an expandable OUTPUT pager (search, copy, export). File writes show a diff preview. When the agent finishes each prompt — naturally or aborted — a `✻ Worked for 1m16s` row is appended under the response, and it is restored when the session is resumed from `/history`. The status line names what the agent is actually doing right now — `responding` while streaming, `compacting` during auto or manual context compaction — instead of holding the last tool name. Prompts typed while the agent is busy are queued and run automatically in order once the turn settles; the queue pauses only when the previous turn was cancelled, errored, or stopped by the loop guard. Compaction cards preserve session memory without dropping the plan, and `/history` restores full sessions — prompts, tool results, and the matching plan — even after an abort or autosave.

---

## Slash commands

| Command | Does |
|---------|------|
| `/ask` · `/agent` · `/plan` | Switch mode (plan = design-then-approve) |
| `/implement` · `/discard` | Approve+execute or drop the current plan |
| `/model [name\|#]` · `/provider [name]` · `/use <provider>` | Pick model / switch provider |
| `/set [provider]` · `/unset [provider]` · `/keys` · `/info [provider]` | Manage API keys, endpoint URLs, and view provider setup / pricing info |
| `/effort [level]` · `/reasoning [level]` | Thinking / reasoning effort |
| `/freeonly [on\|off]` · `/fallback [on\|off]` | Free-only filter · cross-provider fallback |
| `/search [provider]` · `/search-provider` | Choose web-search backend |
| `/scope [show\|add\|new\|clear]` | Engagement scope |
| `/output [last\|id\|list]` | Open full tool output (also `Ctrl+O`) |
| `/jobs` | Background jobs (also `Ctrl+J`) |
| `/compact` · `/context` | Compact history now · show context size |
| `/history` · `/save <name>` · `/new` · `/clear` · `/reset` | Session lifecycle (`/clear` deletes the current session outright) |
| `/allow <tool>` · `/disallow <tool>` · `/permissions` | Tool permissions |
| `/cwd <path>` | Change working directory |
| `/think` · `/thinking` | Show thinking from the last response |
| `/privacy [...]` | Private mode · clear history/logs/artifacts |
| `/update` · `/help` · `/shortcuts` · `/exit` | Housekeeping |

---

## CLI commands

```sh
clai [prompt...]                       # interactive UI, or one-shot with a prompt
  --mode <ask|agent|plan>  --provider <p>  --model <m>
  -y/--yes  --no-history
  --show-thinking  --verbose  --quiet    # one-shot stream controls
  --tui  --classic
  --ui <tui|v2|opentui|classic|legacy|ink> # aliases; ignored with a prompt

clai set <provider> [key]              # --from-env <VAR> | --stdin | --url <url> (repeatable) | --skip-ping
clai unset <provider>                  # remove all keys for a provider (--url = endpoint URLs instead)
clai keys                              # list providers with masked keys + endpoint URLs
clai use <provider>                    # set active provider
clai provider [provider]               # switch provider or open picker
clai model <model>                     # set model for the active provider
clai mode <ask|agent|plan>             # set default mode
clai search-provider <brave|tavily|duckduckgo>
clai config [key] [value]              # print / get / set config
clai doctor                            # check installed tools + provider config
clai history [--show <id>]             # list sessions / print one
clai update                            # check for updates
clai authorize-pentest AGREE           # enable scan/attack tools (one-time ack)
clai scope <show|new|add|clear>        # engagement scope (new: --targets --exclude --phases
                                       #   --name --note --expires --max-rate --max-concurrency)
clai privacy <status|on|off|retention|clear-history|clear-logs|clear-artifacts|clear-all>
```

### One-shot output and exit status

`clai "prompt"` and piped prompts use the noninteractive stream renderer. The final
assistant answer is written to **stdout**; progress, tool cards, diffs, thinking (when
`--show-thinking` is enabled), confirmations, and errors are written to **stderr**. `--quiet`
suppresses progress while retaining the final answer on stdout, and `--verbose` expands tool
output and diff hunks. `--no-history` disables persistence for that run.

A completed, partially completed, blocked, or failed turn returns exit code `0`; an aborted
turn returns `130`; an unhandled or loader error returns `1`. `--show-thinking` can also be
enabled with `CLAI_SHOW_THINKING=1`.

---

## Built-in tools

| Group | Tools |
|-------|-------|
| **Files** | `fs.read` · `fs.list` · `fs.search` · `fs.write` · `fs.writeMany` · `fs.edit` · `fs.replaceLines` · `fs.append` · `fs.delete` |
| **Shell & jobs** | `shell.exec` · `shell.start` · `shell.jobs` · `shell.tail` · `shell.stop` · `pkg.install` |
| **Network** | `net.scan` (nmap) · `net.context` · `net.pingSweep` · `dns.lookup` · `whois.lookup` |
| **HTTP / web** | `http.fetch` (raw evidence) · `web.search` · `web.fetch` (readable) |
| **Pentest** | `pentest.recon` · `pentest.webDiscover` · `pentest.apiEnumerate` · `pentest.authCompare` · `pentest.scanStatus` |
| **Orchestration** | `tool.batch` (up to 20 calls, `on_fail` policies) · `tool.check` · `wordlist.find` |
| **Plan** | `plan.create` · `task.update` · `agent.handoff` |
| **Context** | `sysinfo` · `image.ocr` · `pdf.read` |

### tool.batch fail policy

Default is **continue** — one failed lookup never kills the rest (ideal for recon). Opt into fail-fast or selective cancellation when later work depends on earlier success:

```json
{"name":"tool.batch","args":{
  "on_fail":"cancel_pending",
  "calls":[
    {"name":"net.scan","args":{"target":"lab.example"}},
    {"name":"http.fetch","args":{"url":"https://lab.example/"}}
  ]
}}
```

Top-level messages with several separate tool blocks never cancel siblings — use `tool.batch` when you need a fail policy.

---

## Web search / OSINT

| Provider | Key | Env var |
|----------|-----|---------|
| DuckDuckGo | none (default) | — |
| Brave | required | `BRAVE_SEARCH_API_KEY` |
| Tavily | required | `TAVILY_API_KEY` |

```sh
clai set brave bsx-...
clai set tavily tvly-...
clai search-provider tavily
```

Search-provider keys are multi-key and rotate just like model providers.

---

## Per-project context

Drop a `.clai/context.md` in a repo and its contents are injected every turn — lab topology, in-scope hosts, stack assumptions, coding conventions, or anything the agent should always know for that project.

---

## Interactive REPLs and terminals

Ask clai to use an interactive terminal whenever a program needs more than one input step. It keeps the process attached to the current conversation instead of treating it like a one-line shell command:

```text
Start a Python REPL, inspect the failing parser, make a small change, and show me the result.
```

The agent uses `terminal.start`, `terminal.send`, `terminal.read`, `terminal.status`, `terminal.list`, `terminal.resize`, and `terminal.close` internally. Sessions are isolated per conversation, capture output as cursor-addressed pages, redact prompted secret input before it reaches transcripts or artifacts, and reliably terminate their process trees on close. In plan mode, starting or sending terminal input waits for plan approval; read, status, list, and close operations remain available.

For authorized security work, interactive effects are re-evaluated against the active engagement scope at the time they are delivered. That includes the target, port, phase, and expiry accumulated from prior REPL commands, so a split sequence cannot bypass scope controls.

---

## Configuration & privacy

```sh
clai config                # view config
clai mode agent            # default mode
clai model <name>          # default model for the active provider
/privacy on                # private mode: don't persist this session
/privacy clear-all         # wipe history, logs, and artifacts
```

Config lives under your OS user config dir (e.g. `~/.config/clai/`). Keys are stored locally and shown only masked.

---

## Development

```sh
npm install
npm run dev          # run from source
npm run typecheck
npm run build
npm test             # full Vitest suite
npm run test:classic:pty  # provider-independent POSIX PTY smoke
npm run compile      # native binaries (Bun)
npm run release:verify
npm pack --dry-run
```

---

## Releasing

Tag-driven CI (`.github/workflows/release.yml`): validate (typecheck + tests + release checks) → multi-platform binaries → GitHub Release → npm `@pentoshi/clai` → Homebrew tap.

```sh
# package.json "version" is the single source of truth.
npm version 3.8.0 --no-git-tag-version
npm run sync-version    # refreshes version.generated.ts + install manifests + lockfile
git commit -am "v3.8.0" && git push origin main
git tag -a v3.8.0 -m "clai v3.8.0" && git push origin v3.8.0
```

Secrets: `NPM_TOKEN`, `TAP_GITHUB_TOKEN`. Optional: `NPM_PROVENANCE=true`.

---

## Architecture

```
clai/
├─ src/
│  ├─ index.ts          # CLI entry + subcommands
│  ├─ agent/            # loop, plans, compaction, resume orientation, tool parsing
│  ├─ llm/              # 18 providers, streaming, native tools, key rotation + fallback
│  ├─ tools/            # fs, shell, net, http, web, pentest, batch, plan
│  ├─ safety/           # risk classifier + engagement (scope) policy
│  ├─ store/            # config, history, keys, plans, scope
│  ├─ ui-core/         # renderer-neutral state, actions, layout, rendering, and ports
│  ├─ classic/         # React + Ink classic UI and POSIX terminal bootstrap
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
