import type {
  CompletionRequest,
  CompletionResult,
  ProviderId,
} from "../types.js";
import { providerIds } from "../types.js";
import type { ReasoningStyle } from "./http.js";

export interface LlmProvider {
  id: ProviderId;
  displayName: string;
  defaultModel: string;
  reasoningStyle?: ReasoningStyle | undefined;
  envVar?: string | undefined;
  validateKey(key: string): boolean;
  ping(options: ProviderAuth): Promise<void>;
  complete(
    request: CompletionRequest,
    auth: ProviderAuth,
  ): Promise<CompletionResult>;
  stream?(
    request: CompletionRequest,
    auth: ProviderAuth,
    onToken: (token: string) => void,
  ): Promise<CompletionResult>;
  listModels?(auth: ProviderAuth): Promise<string[]>;
}

export interface ProviderAuth {
  apiKey?: string | undefined;
  baseUrl?: string | undefined;
}

export const providerAliases: Record<string, ProviderId> = {
  free: "free",
  zen: "free",
  opencode: "free",
  "opencode-zen": "free",
  gemini: "gemini",
  google: "gemini",
  openrouter: "openrouter",
  openai: "openai",
  anthropic: "anthropic",
  claude: "anthropic",
  nvidia: "nvidia",
  nim: "nvidia",
  nvcf: "nvidia",
  agentrouter: "agentrouter",
  "agent-router": "agentrouter",
  router: "agentrouter",
  "aws-mantle": "aws-mantle",
  ollama: "ollama",
  local: "ollama",
  bynara: "bynara",
  "bynara-router": "bynara",
  nararouter: "bynara",
  nara: "bynara",
  qwen: "qwen-cloud",
  "qwen-cloud": "qwen-cloud",
  dashscope: "qwen-cloud",
  qwencloud: "qwen-cloud",
  modal: "modal",
  "modal-labs": "modal",
  modalcom: "modal",
  lightning: "lightning",
  "lightning-ai": "lightning",
  lightningai: "lightning",
  "lightning.ai": "lightning",
  litai: "lightning",
  tokenrouter: "tokenrouter",
  "token-router": "tokenrouter",
  tr: "tokenrouter",
  meta: "meta",
  "meta-ai": "meta",
  "meta-model-api": "meta",
  "meta-model": "meta",
  metamodelapi: "meta",
  metamodel: "meta",
  muse: "meta",
  fireworks: "fireworks",
  fw: "fireworks",
  hetzner: "hetzner",
  "hetzner-inference": "hetzner",
  "hetzner-experiments": "hetzner",
  orcarouter: "orcarouter",
  "orca-router": "orcarouter",
  orca: "orcarouter",
};

export const defaultModels: Record<ProviderId, string> = {
  free: "free-2/kilo-auto/free",
  gemini: "gemini-3.5-flash",
  openrouter: "meta-llama/llama-3.3-70b-instruct:free",
  openai: "gpt-5.4-mini",
  anthropic: "claude-3-5-haiku-latest",
  nvidia: "openai/gpt-oss-20b",
  agentrouter: "claude-opus-4-6",
  "aws-mantle": "anthropic.claude-haiku-4-5",
  ollama: "llama3.1:8b",
  bynara: "mimo-v2.5-free",
  "qwen-cloud": "qwen3.7-plus",
  // Modal Endpoints serve one model per endpoint, named by its source repo id.
  modal: "moonshotai/Kimi-K3",
  // Lightning AI namespaces model ids by vendor.
  lightning: "openai/gpt-5",
  // TokenRouter namespaces model ids by vendor (moonshotai/kimi-k3).
  tokenrouter: "moonshotai/kimi-k3",
  meta: "muse-spark-1.2",
  fireworks: "accounts/fireworks/models/kimi-k2p6",
  hetzner: "Qwen/Qwen3.6-35B-A3B-FP8",
  // OrcaRouter namespaces model ids by upstream vendor (openai/gpt-4o-mini).
  orcarouter: "openai/gpt-4o-mini",
};

const retiredModelReplacements: Partial<Record<ProviderId, Record<string, string>>> = {
  gemini: {
    "gemini-2.0-flash": "gemini-3.5-flash",
    "gemini-2.0-flash-lite": "gemini-3.1-flash-lite",
  },
  nvidia: {
    // Older default; redirect existing configs to the new openai/gpt-oss-20b
    // default so retired Nemotron entries don't surface 404s.
    "nvidia/llama-3.3-nemotron-super-49b-v1": defaultModels.nvidia,
  },
  openai: {
    // gpt-4o models have been superseded by the gpt-5.x lineup.
    "gpt-4o-mini": "gpt-5.4-mini",
    "gpt-4o": "gpt-5.4",
  },
  tokenrouter: {
    // The gateway retired short ids; models are now namespaced by vendor.
    "kimi-k2p6": "moonshotai/kimi-k2.6",
    "kimi-k2p5": "moonshotai/kimi-k2.5",
    "kimi-k2p7-code": "moonshotai/kimi-k2.7-code",
    "kimi-k2p7-fast": "moonshotai/kimi-k2.7-code",
    "deepseek-v4-pro": "deepseek/deepseek-v4-pro",
    "deepseek-v4-flash": "deepseek/deepseek-v4-flash",
    "qwen3p7-plus": "qwen/qwen3.7-plus",
    "qwen3p6-plus": "qwen/qwen3.6-plus",
    "glm-5p1": "z-ai/glm-5.1",
    "glm-5p1-fast": "z-ai/glm-5.1",
    "gpt-oss-120b": "openai/gpt-oss-120b",
    "minimax-m3": "MiniMax-M3",
    "minimax-m2p7": "minimax/minimax-m2.7",
  },
};

export const envVars: Record<ProviderId, string | undefined> = {
  free: "FREE_API_KEY",
  gemini: "GEMINI_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  nvidia: "NVIDIA_API_KEY",
  agentrouter: "AGENTROUTER_API_KEY",
  "aws-mantle": "ANTHROPIC_API_KEY",
  ollama: "OLLAMA_HOST",
  bynara: "BYNARA_API_KEY",
  "qwen-cloud": "DASHSCOPE_API_KEY",
  // Modal needs a *pair* of proxy-token env vars plus an endpoint URL; the
  // second half (MODAL_PROXY_TOKEN_SECRET) and MODAL_BASE_URL are resolved in
  // store/keys.ts and store/config.ts respectively.
  modal: "MODAL_PROXY_TOKEN_ID",
  lightning: "LIGHTNING_API_KEY",
  tokenrouter: "TOKENROUTER_API_KEY",
  meta: "MODEL_API_KEY",
  fireworks: "FIREWORKS_API_KEY",
  hetzner: "HETZNER_API_KEY",
  orcarouter: "ORCAROUTER_API_KEY",
};

/** Resolve the env var for any provider, including user-defined custom ones. */
export function getEnvVar(provider: ProviderId): string | undefined {
  if (envVars[provider]) return envVars[provider];
  return envVarResolver?.(provider);
}

/** Injected resolver for custom-provider env vars (avoids a static import cycle). */
let envVarResolver: ((provider: ProviderId) => string | undefined) | undefined;

export function setEnvVarResolver(
  resolver: ((provider: ProviderId) => string | undefined) | undefined,
): void {
  envVarResolver = resolver;
}

export function normalizeProvider(value: string): ProviderId | undefined {
  const alias = providerAliases[value.trim().toLowerCase()];
  if (alias) return alias;
  // Custom (user-defined) providers: the id is its own alias. The resolver is
  // injected by `store/config.ts` at bootstrap to avoid a static import cycle
  // (config.ts imports defaultModels from this module).
  const lower = value.trim().toLowerCase();
  if (customProviderResolver?.(lower)) return lower as ProviderId;
  return undefined;
}

export function assertProvider(value: string): ProviderId {
  const provider = normalizeProvider(value);
  if (!provider) {
    throw new Error(
      `Unsupported provider "${value}". Supported providers: ${providerIds.join(", ")}${customProviderResolver ? " (plus any custom providers you added)" : ""}`,
    );
  }
  return provider;
}

export function getDefaultModel(provider: ProviderId): string {
  // Built-ins read from the static map; custom providers fall back to the
  // injected resolver (wired from store/config.js) so /keys shows their model.
  if (defaultModels[provider]) return defaultModels[provider];
  return customDefaultModelResolver?.(provider) ?? "";
}

/**
 * Inject the custom-provider id resolver (called once at bootstrap from
 * `store/config.ts`). Returns `true` when `id` matches a user-defined custom
 * provider. Kept here (rather than a static import) to avoid a config ↔
 * provider import cycle.
 */
let customProviderResolver: ((id: string) => boolean) | undefined;

export function setCustomProviderResolver(
  resolver: ((id: string) => boolean) | undefined,
): void {
  customProviderResolver = resolver;
}

export function sanitizeProviderModel(provider: ProviderId, model: string): string {
  const normalized = model.trim();
  const replacement =
    retiredModelReplacements[provider]?.[normalized.toLowerCase()];
  return replacement ?? normalized;
}

/**
 * Normalize a user-supplied OpenAI-compatible base URL so the HTTP helpers can
 * append `/chat/completions` to it. Idempotent, and tolerant of the three
 * things people actually paste: a bare host, a trailing slash, or a full
 * endpoint path.
 *
 *   x--ep-y.modal.direct                  → https://x--ep-y.modal.direct/v1
 *   https://x--ep-y.modal.direct/v1/      → https://x--ep-y.modal.direct/v1
 *   https://host/v1/chat/completions      → https://host/v1
 */
export function normalizeEndpointUrl(url: string): string {
  let value = url.trim();
  if (!value) return "";
  if (!/^https?:\/\//i.test(value)) value = `https://${value}`;
  value = value.replace(/\/+$/, "");
  value = value.replace(/\/chat\/completions$/i, "").replace(/\/models$/i, "");
  if (!/\/v\d+$/i.test(value)) value = `${value}/v1`;
  return value;
}

export function maskSecret(secret: string): string {
  // Show first 4 and last 4 characters with a fixed-width •••• separator.
  // Output is always 12 chars for keys >= 8, keeping tables compact.
  const n = secret.length;
  if (n < 8) return "••••••••";
  return secret.slice(0, 4) + "••••" + secret.slice(-4);
}

/** Short tail for toast/status lines (`…ab12`). Never exposes the full secret. */
export function maskSecretTail(secret: string): string {
  const n = secret.length;
  if (n < 4) return "••••";
  return `…${secret.slice(-4)}`;
}

export function redactSecrets(value: string): string {
  return value
    .replace(/gsk_[A-Za-z0-9_-]+/g, "gsk_••••••")
    .replace(/AIza[0-9A-Za-z_-]+/g, "AIza••••••")
    .replace(/AQ\.[A-Za-z0-9_-]+/g, "AQ.••••••")
    .replace(/sk-[A-Za-z0-9._-]+/g, "sk-••••••")
    .replace(/sk-or-[A-Za-z0-9_-]+/g, "sk-or-••••••")
    .replace(/sk-ant-[A-Za-z0-9_-]+/g, "sk-ant-••••••")
    .replace(/nvapi-[A-Za-z0-9_-]+/g, "nvapi-••••••")
    // Modal proxy tokens: id `wk-…`, secret `ws-…`. Require a long tail so
    // ordinary words (`ws-connection`) are never mangled.
    .replace(/wk-[A-Za-z0-9_-]{16,}/g, "wk-••••••")
    .replace(/ws-[A-Za-z0-9_-]{16,}/g, "ws-••••••");
}

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
  MODAL_SESSION_ID            optional sticky-session id. When unset, clai
                              generates one per run so a whole conversation
                              lands on the same warm container.

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
};

export function getProviderInfoText(provider: string): string {
  const known = providerInfo[provider.toLowerCase()];
  if (known) return known;
  // Custom (user-defined) providers: generate a basic info page from the
  // stored definition so /info <custom-provider> is still useful.
  const custom = customProviderInfoResolver?.(provider);
  if (custom) return custom;
  return "no info available";
}

/** Injected resolver that builds an info page for a custom provider id. */
let customProviderInfoResolver:
  | ((provider: string) => string | undefined)
  | undefined;

export function setCustomProviderInfoResolver(
  resolver: ((provider: string) => string | undefined) | undefined,
): void {
  customProviderInfoResolver = resolver;
}

/** Injected resolver returning the default model for a custom provider id. */
let customDefaultModelResolver:
  | ((provider: ProviderId) => string | undefined)
  | undefined;

export function setCustomDefaultModelResolver(
  resolver: ((provider: ProviderId) => string | undefined) | undefined,
): void {
  customDefaultModelResolver = resolver;
}
