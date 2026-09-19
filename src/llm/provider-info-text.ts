export const providerInfo: Record<string, string> = {
  free: `Free (opencode zen + kilo gateway) — keyless OpenAI-compatible models

WHAT IT IS
  The default provider for a fresh clai install. It bundles two keyless
  gateways behind one provider id, namespaced by source:
    free-1/<model>   opencode zen   https://opencode.ai/zen/v1
    free-2/<model>   kilo gateway   https://api.kilo.ai/api/gateway
  Both serve free models with NO API key — requests are forwarded without an
  Authorization header. Chat Completions with SSE streaming, native tool
  calling and reasoning_content thinking all work. A bare model id with no
  free-N/ prefix routes to free-1.

  Auth       none for free models (Bearer only if you add a key)
  Endpoints  /models · /chat/completions on both gateways

MODELS
  /model lists the live catalogs from both gateways (each cached for an
  hour), namespaced by source:
    free-2/kilo-auto/free                      (clai default)
    free-1/mimo-v2.5-free
    free-1/hy3-free
    free-1/x-preview-f-free
    free-2/stepfun/step-3.7-flash:free
    free-2/nvidia/nemotron-3-ultra-550b-a55b:free
  zen free ids end in -free; kilo free ids end in :free or /free (the kilo
  catalog also flags them with isFree). Premium models stay hidden unless
  you add a key. The free sets rotate upstream and models can be delisted
  without notice — treat availability as transient and just pick another id
  from /model.

COST
  Free. No signup, no key, no card. The trade-off is reliability: free tiers
  are capacity-constrained, rate limited and occasionally down. If a request
  fails, retry once — and for dependable daily use set a key for any other
  provider (clai set <provider> <key>, then clai use <provider>).

SETUP
  None. A fresh install already uses this provider.
  Optional: clai set free <key>   unlock premium zen models on your account
  Optional env var: FREE_API_KEY  (used when nothing is stored)

GOOD TO KNOW
  - Premium models without a key fail fast with a 402-style message instead
    of proxying an upstream 401.
  - Reasoning models stream thinking as reasoning_content; clai folds it
    into the usual thinking block, so /think and /effort behave normally.
  - Classed as free-cloud, so /freeonly on keeps it in the fallback chain.`,
  tokenrouter: `TokenRouter — one key for frontier open models

WHAT IT IS
  An OpenAI-compatible gateway that fronts Kimi, DeepSeek, Qwen, GLM, GPT-OSS
  and MiniMax behind a single bearer key and base URL. Chat Completions plus
  the Responses API upstream; clai uses Chat Completions with SSE streaming,
  native tool calling and JSON mode.

  Base URL   https://api.tokenrouter.com/v1   (override if your account uses
             a different host — see ENDPOINTS below)
  Auth       Authorization: Bearer <key>
  Endpoints  /models · /chat/completions

MODELS
  Ids are namespaced by vendor and case-sensitive (moonshotai/kimi-k3, not
  "Kimi K3"). /model reads the live list from /models, filtered to the
  channels your key can actually reach.

COST
  Prepaid balance billed per token; the dashboard header shows what is left.
  There is no published free tier, so treat it as paid: clai classes it
  paid-cloud and /freeonly on keeps it out of the fallback chain. Prices vary
  a lot between the flash/fast variants and the pro ones.

SETUP
  1. Create an API key in your TokenRouter account under API Keys.
  2. clai set tokenrouter sk-yourKey
  3. clai use tokenrouter
  4. /model moonshotai/kimi-k3      (or any id from /model)

MANAGING KEYS AND ENDPOINTS IN clai
  clai set tokenrouter <key>            add a key (up to 10, rotated on failure)
  clai keys                             masked keys + the active endpoint
  clai unset tokenrouter                remove every stored key
  /set tokenrouter                      TUI: endpoint editor, then key editor
  /info tokenrouter                     this page

  Base URL (optional — defaults to api.tokenrouter.com):
  clai set tokenrouter --url https://tokenrouter.me/v1
  clai set tokenrouter --url <a> --url <b>   store several, sticky active one
  clai unset tokenrouter --url               back to the default
  TOKENROUTER_BASE_URL overrides the whole list.

GOOD TO KNOW
  - Reasoning models return their thinking in reasoning_content; clai folds it
    into the usual thinking block, so /think and /effort behave normally.
  - max_tokens above a model's ceiling is clamped by the gateway rather than
    rejected, but prompt + max_tokens must still fit the context window.
  - The model field in responses may echo a fully-qualified upstream path
    instead of the id you sent. That is expected.
  - Env var: TOKENROUTER_API_KEY (used when nothing is stored).

Docs: https://docs.tokenrouter.me`,
  lightning: `Lightning AI Model APIs — one key for OpenAI, Anthropic, Google
and Lightning-hosted open models

WHAT IT IS
  An OpenAI-compatible gateway at https://lightning.ai/api/v1 that fronts
  frontier models from several vendors plus open models Lightning serves
  itself. One account, one key, no per-vendor subscriptions, billed by the
  token. Model ids are vendor-namespaced:
    openai/gpt-5, openai/o3, openai/gpt-5.6-sol
    anthropic/claude-opus-4-8, anthropic/claude-sonnet-4-6
    google/gemini-3.5-flash, google/gemini-2.5-pro
    lightning-ai/gpt-oss-120b, lightning-ai/deepseek-v4-pro,
    lightning-ai/nemotron-3-ultra-550b-a55b, lightning-ai/gemma-4-31B-it

FREE TIER — WHAT YOU GET
  New accounts get up to 40 million free tokens to start, and the docs
  advertise no subscription or credit card to begin. After that it is
  pay-per-token at each model's rate — the /models endpoint returns the
  per-token input and output price for every id, so nothing is hidden.

  Rate limits by plan (requests/min · tokens/min):
    Free         15 ·  120,000
    Pro          20 ·  120,000
    Teams        30 ·  150,000
    Enterprise  300 ·  unlimited

  Signing up needs a non-virtual phone number, and the free grant is once
  per person — a second account does not get a second grant.

SETUP — STEP BY STEP
  1. Create an account at https://lightning.ai
  2. Open the Model APIs page and reveal your key:
       https://lightning.ai/lightning-ai/model-apis/models?showApiKey=true
  3. Give it to clai:
       clai set lightning <your-api-key>
       clai use lightning
  4. Pick a model — /model lists the live catalog from the gateway:
       /model openai/gpt-5
       /model lightning-ai/gpt-oss-120b     (cheapest open-weight option)

  Or export it instead of storing it:
       LIGHTNING_API_KEY=<your-api-key>

MANAGING KEYS AND ENDPOINTS IN clai
  clai set lightning <key>            add a key (up to 10, rotated on failure)
  clai set lightning <key2>           add another; the last that worked is sticky
  clai keys                           masked keys + the active endpoint
  clai unset lightning                remove every stored key
  /set lightning                      TUI: endpoint editor, then multi-key editor
  /info lightning                     this page

  Base URL (optional — defaults to the shared gateway above):
  clai set lightning --url <url>       add an endpoint, make it active
  clai set lightning --url <a> --url <b>   add several
  clai unset lightning --url           back to the default gateway
  /set lightning https://...           add + activate one endpoint

  Point it at a private Lightning Inference deployment or a proxy that speaks
  the same OpenAI routes; up to 10 URLs are stored with a sticky active one.
  LIGHTNING_BASE_URL overrides the whole list.

GOOD TO KNOW
  - The catalog lists one entry per published agent/preset, so the same model
    id appears more than once upstream; clai dedupes it for /model.
  - Cost varies enormously across the list — claude-opus and gpt-5.x cost
    dollars per million tokens while lightning-ai/gpt-oss-* are cents. Check
    the price on https://lightning.ai/models before long agent runs.
  - Streaming, native tool calling and reasoning_effort all work; clai sends
    the standard OpenAI knobs and retries without them if a model objects.
  - Classed as paid-cloud, so /freeonly on keeps it out of the fallback
    chain even while the free tokens last.
  - Model APIs are separate from Lightning Studios/GPU credits; the token
    grant is not the same balance as Studio compute credits.

Docs:   https://lightning.ai/docs/platform/inference/model-apis
Models: https://lightning.ai/models
API:    https://lightning.ai/api/v1 (OpenAI-compatible; /models, /chat/completions)`,
  modal: `Modal Endpoints — your own serverless OpenAI-compatible endpoint

WHAT IT IS
  Modal Endpoints deploy an open-weight model (Kimi, Qwen, DeepSeek, GLM,
  Gemma, GPT-OSS, Nemotron, or your own fine-tune) behind a low-latency
  request proxy. The endpoint serves the standard Chat Completions API under
  /v1, autoscales under load, and scales to zero when idle. The endpoint
  belongs to your workspace, so the base URL is unique to you:
    https://<workspace>--ep-<endpoint>.<region>.modal.direct/v1

FREE TIER — WHAT YOU GET AND WHAT IT COSTS
  Signing up is free. The Starter plan is $0/month + compute and includes
  $30 of free compute credit every month; you unlock it by adding a payment
  method, and nothing is charged until a month's usage passes the credit.
  Starter also includes 3 workspace seats, 100 containers + 10 GPU
  concurrency, region selection, and real-time metrics and logs.
  Team is $250/month + compute with $100/month of credit, 1000 containers
  and 50 GPU concurrency. Credit grants exist for early-stage startups and
  for academics (up to $10k).

  Billing is per-second compute (GPU + CPU) at standard Modal rates — not
  per token. Because endpoints scale to zero you pay only while a container
  is starting or serving; an idle endpoint costs nothing. Pinning compute to
  a region applies a price multiplier. The credit is granted per month, so
  keep an eye on the Credits figure in the dashboard header.

SETUP — STEP BY STEP
  1. Create a free account at https://modal.com
  2. Add a payment method (dashboard → settings → billing) to activate the
     $30/month credit.
  3. Install the CLI and log in:
       pip install modal
       modal setup      (browser login; writes tokens to ~/.modal.toml)
  4. Deploy an endpoint from the Endpoints tab in the dashboard, or:
       modal endpoint create --model moonshotai/Kimi-K3 --name kimi-k3
       modal endpoint create --model Qwen/Qwen3.5-4B --routing-region us-east
     Provisioning takes a few minutes. Region default is us-west.
  5. Copy the endpoint URL from the endpoint Overview page, or run
       modal endpoint list
  6. Create a proxy token pair (endpoints are authenticated by default):
       modal workspace proxy-tokens create
     This prints a token ID (wk-...) and a token secret (ws-...). THE SECRET
     IS SHOWN ONLY ONCE — copy it now; it cannot be retrieved later. You can
     also create one in the dashboard under workspace settings, and the
     endpoint Quickstart panel lists the token IDs you already have.
     On RBAC workspaces, also scope it to the endpoint's environment:
       modal workspace proxy-tokens allow <token-id> <environment>
  7. Point clai at it (URL from step 5, pair from step 6):
       clai set modal --url <endpoint-url>
       clai set modal wk-yourTokenId:ws-yourTokenSecret
       clai use modal
  8. Verify: "clai keys" shows the masked pair and the endpoint it points at,
     and /model lists the models the endpoint actually serves.

KEYS — WHAT IS NEEDED AND WHERE IT GOES
  Endpoint URL        stored in config as modalBaseUrl (not a secret)
  Proxy token ID      wk-...  sent as the Modal-Key header
  Proxy token secret  ws-...  sent as the Modal-Secret header

  There is no bearer API key. clai stores the pair as ONE secret shaped
  "<token-id>:<token-secret>" in the OS keychain (or ~/.clai/keys.json with
  restricted permissions when no keychain is available), so masking,
  rotation and /unset behave exactly like every other provider.

  Proxy tokens (wk-/ws-) are NOT Modal API tokens (ak-/as-). API tokens
  authenticate the CLI and SDK; they will not work as endpoint headers.

MANAGING ENDPOINTS AND KEYS IN clai
  Both are multi-entry lists with a sticky active choice, up to 10 each.

  clai set modal --url <endpoint>          add an endpoint, make it active
  clai set modal --url <a> --url <b>       add several in one call
  clai set modal --url <known endpoint>    re-activate one already stored
  clai set modal wk-id:ws-secret           add a token pair
  clai set modal                           prompt for the pair (input hidden)
  clai keys                                every endpoint + masked pairs, ★ active
  clai unset modal --url                   clear the endpoint list only
  clai unset modal                         clear the token pairs only
  /set modal                               TUI: endpoint editor, then keys
  /set modal https://...                   add + activate one endpoint
  /info modal                              this page

  One endpoint serves one model, so keep an endpoint per model you deploy and
  switch with clai set modal --url <that endpoint> — or star a row in the
  /set endpoint editor. Endpoints are not auto-rotated on failure, because a
  different endpoint serves a different model; token pairs DO rotate like any
  other provider (401 / 403 / 429 / 5xx / empty response moves to the next).

ENVIRONMENT VARIABLES (used only when nothing is stored)
  MODAL_BASE_URL              endpoint URL; overrides the stored list entirely
                              ("/v1" is appended if missing)
  MODAL_PROXY_TOKEN_ID        wk-...  both halves needed, or it is ignored
  MODAL_PROXY_TOKEN_SECRET    ws-...
  MODAL_SESSION_ID            optional sticky-session seed. Each conversation,
                              subagent and auxiliary stream keeps its own ID.
                              Standalone requests use this ID directly.

GOOD TO KNOW
  - Cold start: the first request after idle pays container start-up, which
    can take tens of seconds on a large model. clai allows up to 3 minutes
    for the first token before treating a stream as stalled.
  - The model name on the wire is the source repo id (e.g.
    moonshotai/Kimi-K3), not a Modal alias. /model reads the live list.
  - Endpoint URLs are stored as a list, so several deployments can live side
    by side; only the active one is used. "clai keys" shows them all.
  - Streaming, native tool calling, structured outputs and thinking all work.
    /effort on|off maps to Modal's reasoning toggle.
  - Finished experimenting? "modal endpoint stop <name>" tears the endpoint
    down so no stray request can wake it and spend credit.
  - Modal counts as paid-cloud, so /freeonly on keeps it out of the
    cross-provider fallback chain.

TROUBLESHOOTING
  401 / 403         wrong, revoked or unscoped pair — or an API token (ak-)
                    was pasted instead of a proxy token (wk-)
  404               endpoint URL is wrong, or the endpoint was stopped
  "endpoint URL is not configured"
                    run clai set modal --url <endpoint>
  model not found   send the repo id reported by /model or modal endpoint list
  slow first token  cold start; the endpoint had scaled to zero

Docs:    https://modal.com/docs/guide/endpoints
Auth:    https://modal.com/docs/guide/webhook-proxy-auth
Pricing: https://modal.com/pricing`,
  bynara: `Current Plan

Free
Daily token cap
0 / 7,000,000 used
7,000,000 remaining

Rate limit

10 req/min
Reset time

07.00 WIB
Plan expires

No expiry`,
  meta: `Meta Model API — Muse Spark (Meta Superintelligence Labs)

WHAT IT IS
  Meta's OpenAI-compatible API for agentic and coding workflows. It serves the
  Muse Spark lineup behind a single bearer key at https://api.meta.ai/v1.

  Base URL   https://api.meta.ai/v1
  Auth       Authorization: Bearer <key>
  Endpoints  /models · /chat/completions
  Context    1,048,576 tokens (1M)

MODELS
  muse-spark-1.2             current general model (clai default)
  muse-spark-1.1             previous generation
  muse-spark-1.2-contributor contributor tier (see /model for the live list)

  Muse Spark is a reasoning-first model: it always thinks internally before
  answering. /effort maps clai's effort onto the API's reasoning_effort
  (minimal/low/medium/high/xhigh; "off" degrades to minimal because Muse does
  not support disabling reasoning — "none" returns HTTP 400).

COST
  Pay-as-you-go per token. Cached input tokens bill at a lower rate than
  uncached input. clai classes it paid-cloud, so /freeonly on keeps it out of
  the fallback chain.

SETUP
  1. Create an API key in your Meta Model API dashboard (MODEL_API_KEY).
  2. clai set meta <your-key>
  3. clai use meta
  4. /model muse-spark-1.2      (or any id from /model)

MANAGING KEYS IN clai
  clai set meta <key>            add a key (up to 10, rotated on failure)
  clai set meta <key2>           add another; the last that worked is sticky
  clai keys                      masked keys + the active endpoint
  clai unset meta                remove every stored key
  /set meta                      TUI: multi-key editor
  /info meta                     this page

GOOD TO KNOW
  - Reasoning, native tool calling, image understanding and prompt caching all
    work. Cached tokens arrive as usage.prompt_tokens_details.cached_tokens and
    show up in the usual usage footer.
  - Env var: MODEL_API_KEY (used when nothing is stored).

Docs: https://dev.meta.ai/docs`,
  fireworks: `Fireworks AI — OpenAI-compatible inference for open models

WHAT IT IS
  Fireworks serves open models behind an OpenAI-compatible API at
  https://api.fireworks.ai/inference/v1. One key, many models, billed per
  token. Chat Completions with SSE streaming, native tool calling, vision
  via image_url, structured outputs and reasoning all work.

  Base URL   https://api.fireworks.ai/inference/v1
  Auth       Authorization: Bearer <key>
  Endpoints  /models · /chat/completions

MODELS (ids are fully-qualified — accounts/fireworks/models/<name>)
  accounts/fireworks/models/kimi-k2p6              (clai default) 256K ctx
  accounts/fireworks/models/kimi-k2-instruct-0905  256K ctx
  accounts/fireworks/models/deepseek-v3p1          128K ctx
  accounts/fireworks/models/glm-5p2                200K ctx
  accounts/fireworks/models/qwen3-235b-a22b        128K ctx
  accounts/fireworks/models/gpt-oss-120b           128K ctx
  /model reads the live list from /models (cached 1h).

COST
  Pay-as-you-go per token. No free tier — clai classes it paid-cloud so
  /freeonly on keeps it out of the fallback chain.

SETUP
  1. Create an API key at https://app.fireworks.ai/settings/users/api-keys
  2. clai set fireworks <your-key>
  3. clai use fireworks
  4. /model accounts/fireworks/models/kimi-k2p6

MANAGING KEYS IN clai
  clai set fireworks <key>           add a key (up to 10, rotated on failure)
  clai set fireworks <key2>          add another; last success is sticky
  clai keys                          masked keys
  clai unset fireworks               remove every stored key
  /set fireworks                     TUI: multi-key editor
  /info fireworks                    this page

GOOD TO KNOW
  - Reasoning models return thinking in reasoning_content; clai folds it
    into the usual thinking block so /think and /effort work.
  - Vision models accept image_url; clai sends images as OpenAI image_url
    blocks when the model supports vision.
  - Env var: FIREWORKS_API_KEY (used when nothing is stored).

Docs: https://docs.fireworks.ai
API:  https://docs.fireworks.ai/api-reference/introduction`,
  hetzner: `Hetzner Inference — OpenAI-compatible inference on EU infrastructure

WHAT IT IS
  Hetzner's experimental inference API at https://inference.hetzner.com/api/v1.
  OpenAI-compatible Chat Completions with SSE streaming, native tool calling
  and vision via image_url. Servers in Germany and Finland, outside the US
  CLOUD Act. Currently experimental — free during test phase, no SLA/DPA yet.

  Base URL   https://inference.hetzner.com/api/v1
  Auth       Authorization: Bearer <key>
  Endpoints  /models · /chat/completions

MODELS
  Qwen/Qwen3.6-35B-A3B-FP8             current model (clai default) 262K ctx
  Qwen/Qwen3.6-35B-A3B                 alias without FP8 suffix
  /model reads the live list from /models (cached 1h). Additional models
  will be added based on demand.

COST
  Free during experimental phase — no billing yet. clai classes it free-cloud
  so /freeonly on keeps it in the fallback chain. Expect Hetzner pricing
  well below US hyperscalers once billing arrives.

SETUP
  1. Create an API token at https://experiments.hetzner.com/
  2. clai set hetzner <your-token>
  3. clai use hetzner
  4. /model Qwen/Qwen3.6-35B-A3B-FP8

MANAGING KEYS IN clai
  clai set hetzner <key>               add a key (up to 10, rotated on failure)
  clai set hetzner <key2>              add another; last success is sticky
  clai keys                            masked keys
  clai unset hetzner                   remove every stored key
  /set hetzner                         TUI: multi-key editor
  /info hetzner                        this page

GOOD TO KNOW
  - Qwen3 is a reasoning model: it thinks before answering. /effort on|off
    maps to chat_template_kwargs.enable_thinking so thinking can be disabled
    and the completion budget is not spent on hidden reasoning.
  - Vision: Qwen3.6 accepts images; clai sends them as OpenAI image_url blocks
    when the model supports vision.
  - Tool calling works via OpenAI tools; streaming and prompt caching work.
  - Env var: HETZNER_API_KEY (also HETZNER_INFERENCE_API_KEY, used when
    nothing is stored).

Docs: https://experiments.hetzner.com/docs/inference
API:  https://inference.hetzner.com/api/v1`,
  orcarouter: `OrcaRouter — one key for OpenAI, Anthropic, Google, DeepSeek,
Grok, Qwen, Kimi, MiniMax and GLM at provider cost price

WHAT IT IS
  An OpenAI-compatible gateway at https://api.orcarouter.ai/v1 that routes
  eleven upstream providers behind one bearer key, with zero token markup
  (you pay each provider's published price). Model ids are vendor-prefixed:
    openai/gpt-4o-mini, openai/gpt-5, openai/o3-mini
    anthropic/claude-sonnet-4.6, anthropic/claude-opus-4.7
    google/gemini-2.5-flash, google/gemini-3-pro-preview
    deepseek/deepseek-reasoner, grok/grok-4-fast-reasoning
    qwen/qwen3-max, kimi/kimi-k2.6, minimax/minimax-m2.7, z-ai/glm-5.1
  Chat Completions with SSE streaming, native tool calling, structured
  outputs (response_format json_schema), vision via image_url and a unified
  reasoning_effort knob all work.

  Base URL   https://api.orcarouter.ai/v1
  Auth       Authorization: Bearer <key>
  Endpoints  /models · /chat/completions

MODELS
  Ids are namespaced by upstream vendor and case-sensitive. /model reads the
  live list from /models (cached 1h), filtered to models reachable over Chat
  Completions — image/video/tts/embedding ids are hidden. orcarouter/auto
  picks the cheapest model that fits the request.

REASONING
  One unified syntax: top-level reasoning_effort (low/medium/high, plus
  minimal/max on some models). The gateway translates it per upstream —
  OpenAI native, Claude thinking budgets, Gemini thinkingConfig, Grok
  native. /think and /effort map onto it; thinking arrives as
  reasoning_content and folds into the usual thinking block.

COST
  Zero markup: provider list price per token. Revenue comes from optional
  subscription plans, not inflated token cost. clai classes it paid-cloud,
  so /freeonly on keeps it out of the fallback chain.

SETUP
  1. Create an API key at https://www.orcarouter.ai/console (starts sk-…).
  2. clai set orcarouter sk-yourKey
  3. clai use orcarouter
  4. /model openai/gpt-4o-mini      (or any id from /model)

MANAGING KEYS IN clai
  clai set orcarouter <key>          add a key (up to 10, rotated on failure)
  clai set orcarouter <key2>         add another; the last that worked is sticky
  clai keys                          masked keys + the active endpoint
  clai unset orcarouter              remove every stored key
  /set orcarouter                    TUI: multi-key editor
  /info orcarouter                   this page

GOOD TO KNOW
  - Multi-key rotation, prompt caching, tool calling and compaction behave
    exactly like every other OpenAI-compatible provider.
  - Per-key options at creation: name, credit limit, expiration. Rate limits
    are workspace-level, not per-key.
  - Env var: ORCAROUTER_API_KEY (used when nothing is stored).

Docs: https://docs.orcarouter.ai
API:  https://api.orcarouter.ai/v1 (OpenAI-compatible; /models, /chat/completions)`,
  "merge-gateway": `Merge Gateway — one key for OpenAI, Anthropic, Google and
more through a unified gateway

WHAT IT IS
  A gateway at https://api-gateway.merge.dev/v1 that fronts several upstream
  vendors behind one key. It exposes two surfaces: its own Responses-style
  API at /v1 and a drop-in OpenAI-compatible surface at /v1/openai. clai
  uses the OpenAI-compatible surface, so streaming, native tool calling,
  prompt caching, reasoning effort and key rotation all behave exactly like
  every other OpenAI-compatible provider. Model ids are vendor-prefixed:
    openai/gpt-5.2, openai/gpt-4o-mini, openai/o4-mini
    anthropic/claude-sonnet-4-6, anthropic/claude-opus-4-6
    google/gemini-3.5-flash, google/gemini-2.5-pro
    deepseek/deepseek-reasoner, meta/llama-3.3-70b-instruct

  Base URL   https://api-gateway.merge.dev/v1/openai
  Auth       Authorization: Bearer <key>   (X-API-Key also sent)
  Endpoints  /models · /chat/completions

MODELS
  Ids are namespaced by upstream vendor and case-sensitive. /model reads the
  live list from /models (cached 1h) and hides ids that are not reachable
  over Chat Completions, so embedding/image/tts entries stay out of the
  picker. If the catalog cannot be fetched, a documented offline subset is
  shown instead.

REASONING
  Top-level reasoning_effort (low/medium/high) is translated by the gateway
  to each upstream's native reasoning shape. /think and /effort map onto it,
  and thinking arrives as reasoning_content, folded into the usual thinking
  block. clai only sends reasoning options to models that accept them, and
  retries once without them if a model rejects them.

COST
  Billed per token by plan. The free tier has a budget: once exhausted the
  gateway answers 402, which clai treats as a quota error and rotates to the
  next key or provider. clai classes it paid-cloud, so /freeonly on keeps it
  out of the fallback chain.

SETUP
  1. Create an API key at https://gateway.merge.dev (starts mg_…).
  2. clai set merge-gateway mg_yourKey
  3. clai use merge-gateway
  4. /model openai/gpt-5.2           (or any id from /model)

MANAGING KEYS IN clai
  clai set merge-gateway <key>       add a key (up to 10, rotated on failure)
  clai set merge-gateway <key2>      add another; the last that worked is sticky
  clai keys                          masked keys + the active endpoint
  clai unset merge-gateway           remove every stored key
  /set merge-gateway                 TUI: multi-key editor
  /info merge-gateway                this page

GOOD TO KNOW
  - Aliases: merge-gateway, mergegateway, merge, mg.
  - Errors follow the documented gateway table — 400 bad request, 401 auth,
    402 budget exhausted, 404 unknown model, 429 rate limit. Auth and quota
    errors switch keys immediately; 429 backs off first.
  - Env var: MERGE_GATEWAY_API_KEY (used when nothing is stored).

Docs: https://gateway.merge.dev
API:  https://api-gateway.merge.dev/v1/openai (OpenAI-compatible)`,

  explabs: `Experiential Labs — one key for Claude, GPT, Gemini, Kimi, GLM and
more through an OpenAI-compatible gateway

WHAT IT IS
  A gateway at https://api.experientiallabs.ai that fronts hosted providers,
  your own provider keys (BYOK) and platform-funded credits behind one key.
  Each model is a slug (claude-fable-5.1, gpt-5.6-sol, gemini-3.7-flash) that
  resolves through a provider waterfall with automatic failover — you get one
  OpenAI-shaped response. clai drives the OpenAI-compatible surface
  (Chat Completions + Responses), so streaming, native tool calling, prompt
  caching, reasoning effort and multi-key rotation behave exactly like every
  other OpenAI-compatible provider.

  Base URL   https://api.experientiallabs.ai/v1
  Auth       Authorization: Bearer <key>
  Endpoints  /models · /chat/completions · /responses

MODELS
  /model lists the slugs your key can call, read live from /v1/models and
  enriched from the public catalog at /api/models (context window, vision,
  per-model reasoning efforts). Both are cached for an hour; if the gateway
  is unreachable, a documented offline subset is shown. Image/embedding/batch
  slugs stay out of the picker.

REASONING
  reasoning_effort (low/medium/high/xhigh/max; minimal/none on some models)
  passes through when the route supports it and snaps to the nearest
  supported level otherwise — never a hard error. /think and /effort map
  onto it. The gateway discloses every substitution in
  x-experiential-ignored-parameters.

COST
  Two lanes, zero markup: pass-through (your BYOK provider key bills you
  directly) or platform-funded credits. Promotional free tiers exist (today
  gpt-6-astra and claude-fable-5.1); past the free allowance the gateway
  answers 429 insufficient_quota, which clai treats as a quota error and
  rotates keys or falls back. clai classes it paid-cloud, so /freeonly keeps
  it out of the fallback chain.

SETUP
  1. Mint a key at https://platform.experientiallabs.ai/settings/api-keys
     (starts xpl_…, shown once).
  2. clai set explabs xpl_yourKey
  3. clai use explabs
  4. /model claude-fable-5.1           (or any slug from /model)

MANAGING KEYS IN clai
  clai set explabs <key>       add a key (up to 10, rotated on failure)
  clai set explabs <key2>      add another; the last that worked is sticky
  clai keys                    masked keys + the active endpoint
  clai unset explabs           remove every stored key
  /set explabs                 TUI: multi-key editor
  /info explabs                this page

GOOD TO KNOW
  - Aliases: explabs, experiential, experientiallabs, experiential-labs, exp.
  - Errors follow the documented table — 400 invalid_request /
    invalid_parameter / unsupported_capability (fix the request), 401
    invalid_key, 403 model_not_granted (pick a slug from /v1/models), 429
    insufficient_quota / gateway_overloaded (backs off, then rotates),
    502/503/504 retried with backoff.
  - Env var: EXPLABS_API_KEY (used when nothing is stored).

Docs: https://platform.experientiallabs.ai/docs
  API:  https://api.experientiallabs.ai/v1 (OpenAI-compatible)`,
  vercel: `Vercel AI Gateway — a unified Responses API for OpenAI, Anthropic,
Google and other model providers

WHAT IT IS
  AI Gateway exposes an OpenAI Responses-compatible endpoint that routes
  provider/model ids such as openai/gpt-5.4-mini and
  anthropic/claude-sonnet-5 across supported upstream providers.

  Base URL   https://ai-gateway.vercel.sh/v1
  Auth       Authorization: Bearer <AI Gateway API key>
  Endpoints  /models · /responses

MODELS
  /model reads the public live catalog and caches it for one hour. It keeps
  text-capable language models, registers model context, modalities and
  reasoning_options, and excludes image-generation, embeddings, audio and
  video-only entries. Reasoning effort options are model-specific and are
  discovered from the catalog instead of inferred from a model family.

CAPABILITIES
  Responses streaming, native function tools, tool-result replay, images,
  PDFs, structured reasoning and automatic prompt caching are supported.
  clai sends caching: auto, a stable prompt_cache_key and store: false.
  The shared key-rotation layer supports up to ten AI_GATEWAY_API_KEY values.

SETUP
  1. Create an AI Gateway key at https://vercel.com/ai-gateway
  2. clai set vercel <key>
  3. clai use vercel
  4. /model openai/gpt-5.4-mini

MANAGING KEYS IN clai
  clai set vercel <key>       add a key (up to 10, rotated on failure)
  clai set vercel <key2>      add another; the last that worked is sticky
  clai keys                   masked keys
  clai unset vercel           remove every stored key
  /set vercel                 TUI: multi-key editor
  /info vercel                this page

GOOD TO KNOW
  - Aliases: vercel, ai-gateway, vercel-ai-gateway, gateway.
  - The API accepts none, minimal, low, medium, high, xhigh and max effort,
    but each catalog model advertises its own supported subset.
  - Env var: AI_GATEWAY_API_KEY (used when nothing is stored).

Docs: https://vercel.com/docs/ai-gateway
API: https://ai-gateway.vercel.sh/v1/responses`,
  deepseek: `DeepSeek — frontier reasoning and chat models with automatic KV cache

WHAT IT IS
  Direct API access to DeepSeek models (DeepSeek-V3, DeepSeek-R1 / reasoner,
  DeepSeek-V4 Pro/Flash). Full support for OpenAI-compatible chat completions,
  OpenAI Responses API format, streaming, function tool calling, and thinking mode.

  Base URL   https://api.deepseek.com
  Auth       Authorization: Bearer <key>
  Endpoints  /models · /chat/completions · /responses

MODELS
  deepseek-chat               DeepSeek-V3 flagship general model (default)
  deepseek-reasoner           DeepSeek-R1 deep reasoning model
  deepseek-v4-pro             DeepSeek-V4 next-generation reasoning
  deepseek-flash              Fast, low-latency conversational model

CAPABILITIES
  - Thinking Mode: deepseek-reasoner streams chain-of-thought in reasoning_content;
    effort levels low, high, and max are supported.
  - Automatic KV Caching: prompt caching operates on 64-token boundaries.
    Cache hits are reported in usage.prompt_cache_hit_tokens.
  - Tool Calling: full function calling support with arguments streaming.
  - Responses API: full support for the /responses endpoint.

SETUP
  1. Get an API key at https://platform.deepseek.com
  2. clai set deepseek <key>
  3. clai use deepseek

Docs: https://api-docs.deepseek.com`,
  kimi: `Kimi (Moonshot AI) — long-context frontier models with context caching

WHAT IT IS
  Direct API access to Moonshot AI's Kimi series models (Kimi K3, K2.5, K2.6,
  K2.7-Code, and Moonshot-v1). Features long context windows, deep reasoning,
  automatic context caching, and native tool calling.

  Base URL   https://api.moonshot.ai/v1
  Auth       Authorization: Bearer <key>
  Endpoints  /models · /chat/completions · /responses

MODELS
  kimi-k3                     Kimi K3 reasoning model (default)
  kimi-k2.7-code              Optimized for programming and agentic workflows
  kimi-k2.6                   Frontier reasoning model
  moonshot-v1-128k            128k context general model
  moonshot-v1-32k             32k context model
  moonshot-v1-8k              8k context fast model

CAPABILITIES
  - Thinking: Chain-of-thought via template kwargs and reasoning_content.
  - Context Caching: Automatic prefix caching with cached token reporting.
  - Tool Calling: Standard OpenAI-compatible tool calling.
  - Responses API: Full support for /v1/responses endpoint.

SETUP
  1. Create an API key at https://platform.kimi.ai
  2. clai set kimi <key>
  3. clai use kimi

Docs: https://platform.kimi.ai/docs`,
  glm: `GLM (Zhipu AI / Z.AI) — bilingual frontier models with thinking mode

WHAT IT IS
  Direct API access to Zhipu AI's General Language Model family (GLM-4-Plus,
  GLM-4-Flash, GLM-5.1, and vision models). Supports reasoning thinking mode,
  native tool calling, and multimodal inputs.

  Base URL   https://api.z.ai/api/paas/v4 (or https://open.bigmodel.cn/api/paas/v4)
  Auth       Authorization: Bearer <key>
  Endpoints  /models · /chat/completions

MODELS
  glm-4-plus                  Flagship general model (default)
  glm-4-flash                 High-speed, cost-effective model
  glm-4v-plus                 Multimodal vision model
  glm-5.1                     Next-generation reasoning model

CAPABILITIES
  - Thinking Mode: glm-enable-thinking with streaming reasoning_content.
  - Tool Calling: Function calling in OpenAI format.
  - Vision: Image understanding on GLM-4V models.
  - Cache: Prefix caching with prompt token details.

SETUP
  1. Create an API key at https://open.bigmodel.cn or https://z.ai
  2. clai set glm <key>
  3. clai use glm

Docs: https://docs.z.ai`,
  minimax: `MiniMax — ultra long-context frontier models

WHAT IT IS
  Direct API access to MiniMax models (MiniMax-Text-01, MiniMax-M3,
  MiniMax-M2.7) supporting ultra-long contexts up to 4 million tokens.

  Base URL   https://api.minimaxi.chat/v1 (global) or https://api.minimax.chat/v1
  Auth       Authorization: Bearer <key>
  Endpoints  /models · /chat/completions

MODELS
  MiniMax-Text-01             Flagship model with 4M context window (default)
  MiniMax-M3                  Deep reasoning model with 1M context
  minimax-m2.7                High-efficiency conversational model

CAPABILITIES
  - Context Window: Up to 4,000,000 tokens for massive codebase analysis.
  - Tool Calling: Standard function calling support.
  - Thinking: Chain-of-thought reasoning extraction.
  - Multi-key rotation: Full support in clai.

SETUP
  1. Create an API key at https://intl.minimaxi.com or https://api.minimax.chat
  2. clai set minimax <key>
  3. clai use minimax

Docs: https://intl.minimaxi.com`,
  cline: `Cline — OpenAI-compatible gateway with free and paid frontier models

WHAT IT IS
  Cline's hosted gateway (api.cline.bot). One OAuth sign-in unlocks a catalog
  of models across many vendors (Anthropic, OpenAI, Moonshot, xAI, Z.ai,
  DeepSeek, and more), including a rotating set of free "cline-free/*" models.
  Authenticated route — clai mimics the official Cline desktop client so free
  models work. Chat Completions with SSE streaming and native tool calling.

  Base URL   https://api.cline.bot/api/v1
  Auth       OAuth (WorkOS device flow) — or import an existing Cline sign-in
  Endpoints  /chat/completions · /ai/cline/recommended-models · /users/me

MODELS
  /model lists the live catalog (cached for an hour), grouped by tier:
    cline-free/deepseek-v4.1-flash   free default
    anthropic/claude-opus-5          frontier
    moonshotai/kimi-k3               long-context agentic
    cline-pass/*                     requires a paid Cline subscription

SETUP (pick one)
  1. Sign in with your browser (works on headless servers too):
       clai auth cline
     then open the printed link on any device and approve the code.
  2. Import an existing Cline CLI/Desktop sign-in automatically:
       clai auth cline --import
  3. Paste a token manually:
       clai set cline <access-token>

  Multi-account: run "clai auth cline" again to add more keys (up to 10),
  with automatic rotation on auth/quota errors.

Docs: https://docs.cline.bot`,
  codex: `ChatGPT (Codex) — sign in with your ChatGPT subscription

WHAT IT IS
  The backend the official Codex CLI uses (chatgpt.com/backend-api/codex).
  Sign in with a ChatGPT account — any tier, including the free plan — and
  clai mimics the Codex CLI's requests (originator codex_cli_rs, the
  Responses API with reasoning, SSE streaming) so subscription usage works
  from the terminal.

  Base URL   https://chatgpt.com/backend-api/codex
  Auth       OAuth device flow (Sign in with ChatGPT) — or import an existing
             Codex CLI sign-in
  Endpoints  /responses · /models

MODELS
  /model lists the account-visible catalog (cached for an hour), e.g.
    gpt-5.1-codex        agentic coding default
    gpt-5.1              general reasoning
  Free-tier quota errors are shown exactly as the backend returns them.

SETUP (pick one)
  1. Sign in with your browser (works on headless servers too):
       clai auth codex
     then open the printed link on any device and approve the code.
  2. Import an existing Codex CLI sign-in:
       clai auth codex --import
  3. Paste a stored credential manually:
       clai set codex <key>

  Multi-account: run "clai auth codex" again to add more keys (up to 10),
  with automatic rotation on auth/quota errors.

Docs: https://developers.openai.com/codex/`,
  copilot: `GitHub Copilot — use your Copilot subscription from the terminal

WHAT IT IS
  The GitHub Copilot chat API (api.githubcopilot.com). Sign in with a GitHub
  account that has Copilot — including Copilot Free — via the GitHub device
  flow, and clai mimics the VS Code Copilot Chat client's requests
  (Copilot-Integration-Id, Editor/Plugin versions, X-Initiator) so
  subscription usage works from the terminal.

  Base URL   https://api.githubcopilot.com
  Auth       GitHub device flow — or import an existing Copilot sign-in
  Endpoints  /chat/completions · /models

MODELS
  /model lists the account-visible catalog (cached for an hour), e.g.
    gpt-4o               general default
    claude-sonnet-4.5    frontier reasoning
    gpt-5.1              agentic coding
  Copilot Free quota errors are shown exactly as the backend returns them.

SETUP (pick one)
  1. Sign in with your browser (works on headless servers too):
       clai auth copilot
     then open the printed link on any device and enter the code.
  2. Import an existing Copilot sign-in (Copilot CLI / VS Code):
       clai auth copilot --import
  3. Paste a GitHub token manually:
       clai set copilot <ghu_...>

  Multi-account: run "clai auth copilot" again to add more keys (up to 10),
  with automatic rotation on auth/quota errors.

Docs: https://docs.github.com/copilot`,
};
