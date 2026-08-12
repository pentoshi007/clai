import type {
  CompletionRequest,
  CompletionResult,
  ProviderId,
  ToolCallStreamDelta,
} from "../types.js";
import {
  getActiveProviderEndpoint,
  getCustomProviders,
  getProviderEndpoints,
  getConfig,
  providerCategory,
  providerUsesEndpoints,
  resolveProviderCategory,
  setActiveProviderEndpoint,
} from "../store/config.js";
import {
  getProviderKeys,
  getProviderSecret,
  markProviderKeySuccess,
} from "../store/keys.js";
import { anthropicProvider } from "./anthropic.js";
import { geminiProvider } from "./gemini.js";
import { groqProvider } from "./groq.js";
import {
  ProviderError,
  isImageInputUnsupportedError,
  isReasoningUnsupportedError,
  stripImagesFromMessages,
  STREAM_STALL_MARKER,
} from "./http.js";
import {
  learnModelVisionCapability,
  markModelUnavailable,
  markReasoningUnsupported,
  modelAcceptsImages,
  modelSupportsVision,
  visionSubstitutionOrigin,
} from "./capabilities.js";
import { applyImageViewAvailability } from "../prompts/index.js";
import {
  markStreamEmittedBytes,
  streamAlreadyEmitted,
  streamEmittedBytes,
} from "./stream-progress.js";
import {
  attemptsPerKey,
  buildKeyAttemptPlan,
  formatKeyEventStatus,
  isImmediateKeySwitchError,
  isKeyCircleStopError,
  isKeyRotatableError,
  isQuotaKeyError,
  type ProviderKeyEvent,
} from "./key-rotation.js";
import { freeProvider } from "./free.js";
import { nvidiaProvider } from "./nvidia.js";
import { agentrouterProvider } from "./agentrouter.js";
import { kimchiProvider } from "./kimchi.js";
import { bynaraProvider } from "./bynara.js";
import { mantleProvider } from "./aws-mantle.js";
import { ollamaProvider } from "./ollama.js";
import { openaiProvider } from "./openai.js";
import { openrouterProvider } from "./openrouter.js";
import { qwenCloudProvider } from "./qwen-cloud.js";
import { modalProvider } from "./modal.js";
import { lightningProvider } from "./lightning.js";
import { tokenrouterProvider } from "./tokenrouter.js";
import { metaProvider } from "./meta.js";
import type { LlmProvider, ProviderAuth } from "./provider.js";
import { maskSecretTail } from "./provider.js";
import { getCustomProviderSync } from "./custom-providers.js";
import {
  isToolsUnsupportedError,
  markTextOnlyModel,
} from "./tool-protocol.js";

const MAX_RETRIES = 6;
// Wait at most this long overall per attempt (up to 2 minutes total wait budget).
const MAX_RETRY_WAIT_MS = 120_000;

/** Toast replace-key so key rotation never stacks notifications. */
export const API_KEY_TOAST_KEY = "api-key-rotation";

export type ProviderKeyEventHandler = (event: ProviderKeyEvent) => void;

export interface StreamWithProviderOptions {
  readonly onStatus?: ((message: string) => void) | undefined;
  readonly onKeyEvent?: ProviderKeyEventHandler | undefined;
  /** Cap retries for this request (default MAX_RETRIES). Use 0-1 for compaction. */
  readonly maxRetries?: number | undefined;
}

async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw signal.reason ?? new Error("Aborted");
  return new Promise((resolve, reject) => {
    let timer: NodeJS.Timeout;
    let cleanup = (): void => {};
    const abort = (): void => {
      clearTimeout(timer);
      cleanup();
      reject(signal?.reason ?? new Error("Aborted"));
    };
    cleanup = (): void => {
      signal?.removeEventListener("abort", abort);
    };
    timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    signal?.addEventListener("abort", abort, { once: true });
  });
}

function isRateLimited(error: unknown): boolean {
  return error instanceof ProviderError && error.status === 429;
}

function isTransientNetworkError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const msg = message.toLowerCase();
  return (
    msg.includes("socket connection was closed unexpectedly") ||
    msg.includes("econnreset") ||
    msg.includes("etimedout") ||
    msg.includes("econnrefused") ||
    msg.includes("enotfound") ||
    msg.includes("fetch failed") ||
    msg.includes("network error") ||
    msg.includes("timeout") ||
    msg.includes("unexpected end of file") ||
    msg.includes("premature close")
  );
}

function isRetriableError(error: unknown): boolean {
  if (streamAlreadyEmitted(error)) return false;
  const message = error instanceof Error ? error.message : String(error);
  if (new RegExp(STREAM_STALL_MARKER, "i").test(message)) {
    if (/for \d+s after it had already started/i.test(message)) return false;
  }
  if (/stream stalled|request timed out before any response|stream transport timeout/i.test(message)) {
    return true;
  }
  if (isRateLimited(error)) return true;
  if (error instanceof ProviderError) {
    const status = error.status ?? 0;
    if (status >= 500 && status <= 504) {
      return true;
    }
  }
  return isTransientNetworkError(error);
}

function retryWaitMs(error: unknown, attempt: number): number {
  if (error instanceof ProviderError && error.retryAfterSeconds !== undefined) {
    return Math.ceil(error.retryAfterSeconds * 1000);
  }
  // Exponential backoff: 2s, 6s, 18s, 54s, etc.
  return Math.pow(3, attempt) * 2_000;
}

function networkRetryWaitMs(attempt: number): number {
  return Math.pow(2, attempt) * 1_000;
}

function failureReason(error: unknown): string {
  if (isRateLimited(error)) return "rate limited";
  if (isQuotaKeyError(error)) {
    const status =
      error instanceof ProviderError && error.status ? ` (${error.status})` : "";
    return `insufficient credits${status}`;
  }
  if (error instanceof ProviderError && error.status) {
    if (error.status === 401 || error.status === 403) {
      return `auth failed (${error.status})`;
    }
    return `server error (${error.status})`;
  }
  return "connection glitch";
}

/**
 * User-facing classification of provider failures (auth, capacity, disconnect,
 * empty admission, context limit). Used by the fallback table and tests.
 */
export function formatProviderFailureForUser(error: unknown): string {
  if (error instanceof ProviderError) {
    // Keep the provider's own message in the transcript. The classification
    // below is useful guidance, but hiding an upstream 429/body detail makes
    // it needlessly hard to tell OpenAI and Gemini failures apart.
    const exactError = error.message.replace(/\s+/g, " ").trim();
    const withExactError = (guidance: string): string =>
      exactError ? `${guidance}\nExact provider error: ${exactError}` : guidance;
    const status = error.status ?? 0;
    if (status === 429) {
      return withExactError(
        "Model is rate limited (429). Try another provider/model or switch to a paid plan.",
      );
    }
    if (status === 401 || status === 403) {
      return withExactError(
        `Authentication/authorization failed (${status}). Check the API key with \`clai providers\` or set the provider env var.`,
      );
    }
    if (status === 402) {
      return withExactError(
        "Insufficient credits / payment required (402). Try another API key for this provider, top up the account, or switch provider.",
      );
    }
    if (status === 404) {
      return withExactError(
        "Model or endpoint not found (404). Run `/model list` or pick another model.",
      );
    }
    if (status === 413) {
      return withExactError(
        "Request exceeded the provider input limit (413). Wait for auto-compact, run `/compact`, or continue with a smaller turn.",
      );
    }
    if (status === 422) {
      return withExactError(
        "Provider rejected the request body (422). Model name or parameters may be incompatible — try another model.",
      );
    }
    if (status === 503 || status === 502 || status === 504) {
      return withExactError(
        `Upstream provider unavailable (${status}). Retry shortly or switch provider/model; free-tier models are often capacity-constrained.`,
      );
    }
    if (status >= 500 && status < 600) {
      return withExactError(
        `Upstream provider error (${status}). Retry or switch with \`/provider\` / \`/model\`.`,
      );
    }
  }
  const message = (error instanceof Error ? error.message : String(error))
    .replace(/\s+/g, " ")
    .trim();
  if (!message) {
    return "Provider returned an empty failure (no tokens billed). Model may be unavailable, overloaded, or rejected before admission — try another model.";
  }
  if (
    /socket connection was closed|econnreset|premature close|unexpected end of file/i.test(
      message,
    )
  ) {
    return `${message} — connection dropped mid-request (common on free/unstable routes). Retry or switch model; long contexts increase disconnect risk.`;
  }
  if (new RegExp(STREAM_STALL_MARKER, "i").test(message)) {
    return `${message}`;
  }
  if (/stream stalled|request timed out before any response/i.test(message)) {
    return `${message} — no tokens arrived in time. Free models and large contexts fail more often; retry or use a more reliable model.`;
  }
  if (/no completion text|response was empty|empty response|returned no text/i.test(message)) {
    return `${message} — provider accepted the request but returned no content. Retry once; if it persists, switch model.`;
  }
  if (/fetch failed|network error|etimedout|enotfound|econnrefused/i.test(message)) {
    return `${message} — network/DNS failure reaching the provider. Check connectivity and provider base URL.`;
  }
  return message;
}

function summarizeProviderError(error: unknown): string {
  return formatProviderFailureForUser(error);
}

const FREE_PROVIDER_HINT =
  "the free tier (opencode zen / kilo gateway) is keyless and best-effort, so it is often rate limited or unavailable — set an API key for another provider (clai set <provider> <key>, then clai use <provider>) for reliable access";

function failureMessageFor(providerId: ProviderId, error: unknown): string {
  const base = summarizeProviderError(error);
  return providerId === "free" ? `${base} — ${FREE_PROVIDER_HINT}` : base;
}

interface ProviderFailure {
  provider: ProviderId;
  message: string;
  /** Original error so structured status/retry-after survive aggregation. */
  error?: unknown;
}

/**
 * Aggregate failure that keeps the most actionable `status` /
 * `retryAfterSeconds` instead of forcing every consumer to regex the message
 * (Phase 2.2). `classifyStreamFailure` already prefers `errorStatus(error)`.
 */
export class AggregateProviderError extends ProviderError {
  constructor(
    message: string,
    readonly failures: ReadonlyArray<{ provider: ProviderId; message: string }>,
    status?: number | undefined,
    retryAfterSeconds?: number | undefined,
  ) {
    super(message, status, undefined, retryAfterSeconds);
    this.name = "AggregateProviderError";
  }
}

/** 413 (context) > 429 (rate limit) > 5xx > any other status. */
function mostActionableFailure(
  failures: ProviderFailure[],
): ProviderError | undefined {
  const candidates = failures
    .map((failure) => failure.error)
    .filter(
      (error): error is ProviderError =>
        error instanceof ProviderError && typeof error.status === "number",
    );
  if (candidates.length === 0) return undefined;
  const rank = (status: number): number =>
    status === 413 ? 0 : status === 429 ? 1 : status >= 500 ? 2 : 3;
  return candidates.reduce((best, current) =>
    rank(current.status!) < rank(best.status!) ? current : best,
  );
}

function aggregateProviderError(
  message: string,
  failures: ProviderFailure[],
  emittedBytes = 0,
): AggregateProviderError {
  const actionable = mostActionableFailure(failures);
  const aggregate = new AggregateProviderError(
    message,
    failures.map(({ provider, message: text }) => ({ provider, message: text })),
    actionable?.status,
    actionable?.retryAfterSeconds,
  );
  return markStreamEmittedBytes(aggregate, emittedBytes);
}

function escapeTableCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();
}

function formatFailures(failures: ProviderFailure[]): string {
  if (failures.length === 0) return "";
  // Keep the first visible error self-contained. Some terminal renderers
  // truncate multiline notices, which previously left users with only
  // “No provider could stream the request.” and hid the useful provider body.
  return ` — ${failures
    .map((failure) => `${failure.provider}: ${escapeTableCell(failure.message)}`)
    .join("; ")}`;
}

/**
 * After all keys for a provider are exhausted, decide whether to try the next
 * *provider* in the fallback chain. Auth/rate-limit stop cross-provider when
 * only one key existed historically; with multi-key we already rotated keys.
 */
function shouldStopProviderFallback(error: unknown): boolean {
  if (error instanceof ProviderError) {
    return [401, 403, 404, 422, 429].includes(error.status ?? 0);
  }
  const message = error instanceof Error ? error.message : String(error);
  return /no completion text|response was empty|empty response|returned no text/i.test(message);
}

/**
 * True when a stream/complete failure was a fully empty model completion — no
 * visible text and no tool calls. Safe to retry with a nudge (common right
 * after auto-compaction when the tail ends on re-injected system context).
 */
export function isEmptyCompletionError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /completed without a visible answer|no visible answer|returned no content|no completion text|response was empty|empty response|returned no text/i.test(
    message,
  );
}

export const providers: Record<ProviderId, LlmProvider> = {
  free: freeProvider,
  groq: groqProvider,
  gemini: geminiProvider,
  openrouter: openrouterProvider,
  openai: openaiProvider,
  anthropic: anthropicProvider,
  nvidia: nvidiaProvider,
  agentrouter: agentrouterProvider,
  kimchi: kimchiProvider,
  "aws-mantle": mantleProvider,
  ollama: ollamaProvider,
  bynara: bynaraProvider,
  "qwen-cloud": qwenCloudProvider,
  modal: modalProvider,
  lightning: lightningProvider,
  tokenrouter: tokenrouterProvider,
  meta: metaProvider,
};

const fallbackOrder: ProviderId[] = [
  "free",
  "nvidia",
  "groq",
  "gemini",
  "openrouter",
  "agentrouter",
  "kimchi",
  "bynara",
  "openai",
  "anthropic",
  "aws-mantle",
  "ollama",
  "qwen-cloud",
  "modal",
  "lightning",
  "tokenrouter",
  "meta",
];


/**
 * Built-in provider ids in fallback preference order. Custom (user-defined)
 * provider ids are appended after the built-ins so they participate in the
 * cross-provider fallback chain when enabled, in config declaration order.
 */
function allFallbackIds(): ProviderId[] {
  const custom = getCustomProviders().map((d) => d.id as ProviderId);
  return [...fallbackOrder, ...custom];
}

async function requestedRealKeyCount(provider: ProviderId): Promise<number> {
  // Ollama's "key" is a local host URL, and `free` has no credential at all —
  // both are keyless/local slots, not a single real API key. Counting them
  // here would disable fallback for the two providers that most need it when
  // the local server or free tier is unavailable.
  if (provider === "ollama" || provider === "free") return 0;
  const multi = await getProviderKeys(provider);
  return multi.keys.filter((key) => key.value && !key.disabled).length;
}

export function buildFallbackChain(
  requested: ProviderId,
  freeOnly: boolean,
  enabled = false,
  preferAlternates = false,
): ProviderId[] {
  if (!enabled) return [requested];
  const order = allFallbackIds();
  const filtered = freeOnly
    ? order.filter(
        (provider) =>
          provider === requested || resolveProviderCategory(provider) !== "paid-cloud",
      )
    : order;
  const alternates = filtered.filter((provider) => provider !== requested);
  // A live-connection stall has already spent one full generation on the
  // selected route. Retrying it first creates the duplicate partial bubbles in
  // the reported failure. Try configured alternates first for that recovery
  // attempt, but retain the user's selected provider as the final fallback.
  return preferAlternates
    ? [...alternates, requested]
    : [requested, ...alternates];
}

export function getProvider(provider: ProviderId): LlmProvider {
  const builtin = providers[provider];
  if (builtin) return builtin;
  // Custom (user-defined) providers are not in the static map; resolve them
  // from the runtime registry. Returns undefined for an unknown id.
  const custom = getCustomProviderSync(provider as string);
  if (custom) return custom;
  // Unknown id: return the first built-in so callers that don't pre-validate
  // get a usable object rather than `undefined`. Callers that need to assert
  // existence use `assertProvider` (which now accepts custom ids too).
  return providers.nvidia;
}

export async function providerAuth(
  provider: ProviderId,
): Promise<ProviderAuth> {
  const secret = await getProviderSecret(provider);
  if (provider === "ollama") {
    return { baseUrl: secret.value };
  }
  // Endpoint providers carry both: the stored secret plus the active endpoint
  // URL from config (Modal requires one; Lightning treats it as an override).
  if (providerUsesEndpoints(provider)) {
    const baseUrl = getActiveProviderEndpoint(provider);
    return { apiKey: secret.value, ...(baseUrl ? { baseUrl } : {}) };
  }
  return { apiKey: secret.value };
}

function authForSlot(
  providerId: ProviderId,
  value: string | undefined,
): ProviderAuth {
  if (providerId === "ollama") {
    return { baseUrl: value };
  }
  if (providerUsesEndpoints(providerId)) {
    const baseUrl = getActiveProviderEndpoint(providerId);
    return { apiKey: value, ...(baseUrl ? { baseUrl } : {}) };
  }
  return { apiKey: value };
}

type EmitKey = (event: ProviderKeyEvent) => void;

function withoutReasoning(request: CompletionRequest): CompletionRequest {
  return { ...request, thinking: undefined };
}

function makeKeyEmitter(
  onStatus?: (message: string) => void,
  onKeyEvent?: ProviderKeyEventHandler,
): EmitKey {
  return (event) => {
    onKeyEvent?.(event);
    // Quiet sticky start: never status-spam "using …" on every model step.
    // Surface only retries (composer countdown), switches (toast + status), exhausted.
    if (event.type === "using") return;
    const line = formatKeyEventStatus(event);
    if (event.type === "retry" || event.type === "switch" || event.type === "exhausted") {
      onStatus?.(line);
    }
  };
}

async function tryCompleteOnce(
  provider: LlmProvider,
  providerId: ProviderId,
  request: CompletionRequest,
  model: string,
  auth: ProviderAuth,
): Promise<CompletionResult> {
  const activeRequest = { ...request, provider: providerId, model };
  try {
    const result = await provider.complete(activeRequest, auth);
    if (hasImageInput(activeRequest)) {
      learnModelVisionCapability(providerId, model, true);
    }
    return result;
  } catch (error) {
    if (activeRequest.tools?.length && isToolsUnsupportedError(error)) {
      markTextOnlyModel(providerId, model);
      const textRequest = {
        ...activeRequest,
        tools: undefined,
        toolChoice: undefined,
        parallelToolCalls: undefined,
      };
      return await provider.complete(textRequest, auth);
    }
    // Model rejected a reasoning/thinking knob — mark it and retry once
    // without reasoning so an unsupported option never fails the request.
    if (isReasoningUnsupportedError(error)) {
      markReasoningUnsupported(providerId, model);
      return await provider.complete(withoutReasoning(activeRequest), auth);
    }
    if (hasImageInput(activeRequest) && isImageInputUnsupportedError(error)) {
      learnModelVisionCapability(providerId, model, false);
      return await provider.complete(withoutImages(activeRequest), auth);
    }
    const restored = revertVisionSubstitution(providerId, model, activeRequest, error);
    if (restored) {
      return await provider.complete(restored.request, auth);
    }
    throw error;
  }
}

function requestForRoute(
  request: CompletionRequest,
  provider: ProviderId,
  model: string,
): CompletionRequest {
  if (modelSupportsVision(provider, model)) return request;

  const tools = request.tools?.filter((tool) => tool.name !== "image.view");
  const forcedImageView =
    typeof request.toolChoice === "object" &&
    request.toolChoice.name === "image.view";
  const messages = request.messages.map((message) =>
    message.role === "system" && message.content.includes("image.view")
      ? {
          ...message,
          content: applyImageViewAvailability(message.content, false),
        }
      : message,
  );
  return {
    ...request,
    messages,
    ...(request.tools ? { tools } : {}),
    ...(forcedImageView
      ? { toolChoice: tools?.length ? ("auto" as const) : undefined }
      : {}),
    ...(!tools?.length && request.tools
      ? { parallelToolCalls: undefined }
      : {}),
  };
}

function hasImageInput(request: CompletionRequest): boolean {
  return request.messages.some((message) => message.images?.length);
}

function withoutImages(request: CompletionRequest): CompletionRequest {
  return { ...request, messages: stripImagesFromMessages(request.messages) };
}

function isModelNotFoundError(error: unknown): boolean {
  const status =
    error && typeof error === "object" && "status" in error
      ? Number((error as { status?: number }).status)
      : undefined;
  if (status !== 404 && status !== 400) return false;
  const body =
    error && typeof error === "object" && "body" in error
      ? String((error as { body?: string }).body ?? "")
      : "";
  const message = error instanceof Error ? error.message : String(error);
  const hay = `${message}\n${body}`.toLowerCase();
  if (status === 404) return true;
  return /model[_ ]?not[_ ]?found|no such model|unknown model|model does not exist|invalid model|unavailable[- ]model/.test(
    hay,
  );
}

function revertVisionSubstitution(
  providerId: ProviderId,
  model: string,
  request: CompletionRequest,
  error: unknown,
):
  | { request: CompletionRequest; original: string }
  | undefined {
  if (!isModelNotFoundError(error)) return undefined;
  const original = visionSubstitutionOrigin(providerId, model);
  if (!original) return undefined;
  markModelUnavailable(providerId, model);
  const keepImages = modelAcceptsImages(providerId, original);
  const restoredRequest: CompletionRequest = {
    ...request,
    model: original,
    messages: keepImages
      ? request.messages
      : stripImagesFromMessages(request.messages),
  };
  return {
    original,
    request: requestForRoute(restoredRequest, providerId, original),
  };
}

async function tryStreamOnce(
  provider: LlmProvider,
  providerId: ProviderId,
  request: CompletionRequest,
  model: string,
  auth: ProviderAuth,
  onToken: (token: string) => void,
  onStatus?: (message: string) => void,
): Promise<CompletionResult> {
  let emittedBytes = 0;
  let emittedToolArgumentBytes = 0;
  const onToolCallDelta = request.onToolCallDelta;
  const activeRequest = {
    ...request,
    provider: providerId,
    model,
    ...(onToolCallDelta
      ? {
          onToolCallDelta: (delta: ToolCallStreamDelta): void => {
            const argumentBytes = delta.argumentsBytes ?? 0;
            emittedBytes += Math.max(
              delta.name?.length ?? 0,
              argumentBytes - emittedToolArgumentBytes,
              1,
            );
            emittedToolArgumentBytes = Math.max(
              emittedToolArgumentBytes,
              argumentBytes,
            );
            onToolCallDelta(delta);
          },
        }
      : {}),
  };
  const emit = (token: string): void => {
    emittedBytes += token.length;
    onToken(token);
  };
  const learnVisionOnSuccess = (): void => {
    if (hasImageInput(activeRequest)) {
      learnModelVisionCapability(providerId, model, true);
    }
  };
  try {
    if (provider.stream) {
      const streamed = await provider.stream(activeRequest, auth, emit);
      learnVisionOnSuccess();
      return streamed;
    }
    const result = await provider.complete(activeRequest, auth);
    emit(result.text);
    learnVisionOnSuccess();
    return result;
  } catch (error) {
    if (
      emittedBytes === 0 &&
      activeRequest.tools?.length &&
      isToolsUnsupportedError(error)
    ) {
      markTextOnlyModel(providerId, model);
      onStatus?.(
        `ℹ ${providerId}/${model} does not support native tools — falling back to text protocol`,
      );
      const textRequest = {
        ...activeRequest,
        tools: undefined,
        toolChoice: undefined,
        parallelToolCalls: undefined,
      };
      try {
        if (provider.stream) {
          return await provider.stream(textRequest, auth, emit);
        }
        const result = await provider.complete(textRequest, auth);
        emit(result.text);
        return result;
      } catch (retryError) {
        throw markStreamEmittedBytes(retryError, emittedBytes);
      }
    }
    // Model rejected a reasoning/thinking knob (e.g. chat_template_kwargs on a
    // NIM chat template that does not accept it). Mark it so buildChatBody stops
    // sending reasoning, then retry once without it. A parameter rejection is a
    // request-time 4xx, so no tokens have streamed yet — the retry is clean.
    if (emittedBytes === 0 && isReasoningUnsupportedError(error)) {
      markReasoningUnsupported(providerId, model);
      onStatus?.(
        `ℹ ${providerId}/${model} rejected reasoning options — retrying without them`,
      );
      const retryRequest = withoutReasoning(activeRequest);
      try {
        if (provider.stream) {
          return await provider.stream(retryRequest, auth, emit);
        }
        const result = await provider.complete(retryRequest, auth);
        emit(result.text);
        return result;
      } catch (retryError) {
        throw markStreamEmittedBytes(retryError, emittedBytes);
      }
    }
    if (
      emittedBytes === 0 &&
      hasImageInput(activeRequest) &&
      isImageInputUnsupportedError(error)
    ) {
      learnModelVisionCapability(providerId, model, false);
      onStatus?.(
        `ℹ ${providerId}/${model} rejected image input — retrying without the attached image(s)`,
      );
      const textOnlyRequest = withoutImages(activeRequest);
      try {
        if (provider.stream) {
          return await provider.stream(textOnlyRequest, auth, emit);
        }
        const result = await provider.complete(textOnlyRequest, auth);
        emit(result.text);
        return result;
      } catch (retryError) {
        throw markStreamEmittedBytes(retryError, emittedBytes);
      }
    }
    if (emittedBytes === 0) {
      const restored = revertVisionSubstitution(
        providerId,
        model,
        activeRequest,
        error,
      );
      if (restored) {
        onStatus?.(
          `ℹ ${providerId}/${model} is not available on this account — falling back to ${restored.original}`,
        );
        try {
          if (provider.stream) {
            return await provider.stream(restored.request, auth, emit);
          }
          const result = await provider.complete(restored.request, auth);
          emit(result.text);
          return result;
        } catch (retryError) {
          throw markStreamEmittedBytes(retryError, emittedBytes);
        }
      }
    }
    throw markStreamEmittedBytes(error, emittedBytes);
  }
}

/**
 * Run complete/stream against all keys for one provider with circular rotation.
 * Returns result on success; throws ProviderError-like aggregate on hard stop;
 * returns `{ exhausted: true, lastError }` when the key circle is done.
 */
async function runWithKeyRotation<T>(opts: {
  providerId: ProviderId;
  provider: LlmProvider;
  request: CompletionRequest;
  model: string;
  emitKey: EmitKey;
  mode: "complete" | "stream";
  onToken?: ((token: string) => void) | undefined;
  onStatus?: ((message: string) => void) | undefined;
  maxRetries?: number | undefined;
}): Promise<T> {
  const { providerId, provider, request, model, emitKey } = opts;
  const multi = await getProviderKeys(providerId);
  const slots = multi.keys;
  if (slots.length === 0) {
    throw new Error("no API key configured");
  }

  const plan = buildKeyAttemptPlan(slots.length, multi.activeIndex).filter(
    (index) => !slots[index]!.disabled,
  );
  if (plan.length === 0) {
    throw new Error(
      `all ${slots.length} API key${slots.length === 1 ? "" : "s"} for ${providerId} are disabled — re-enable one to use this provider`,
    );
  }
  const enabledCount = plan.length;
  const multiKey = enabledCount > 1;
  // Single key: time-increasing retries (MAX_RETRIES+1 attempts).
  // Multi key: 2 attempts per key (initial + one retry), then next key.
  const maxPerKey = attemptsPerKey(enabledCount, (opts.maxRetries ?? MAX_RETRIES) + 1);
  let lastError: unknown;

  // Endpoint failover: a provider can carry several base URLs (e.g. Modal
  // workspaces). On an auth/quota error the active endpoint may simply be the
  // wrong workspace for the key, so rotate the endpoint too before giving up.
  const storedEndpoints = providerUsesEndpoints(providerId)
    ? getProviderEndpoints(providerId)
    : undefined;
  const endpointUrls = (storedEndpoints?.urls ?? []).filter(
    (url) => !(storedEndpoints?.disabledUrls ?? []).includes(url),
  );
  const activeEndpointUrl = storedEndpoints?.urls[storedEndpoints.activeIndex];
  const activeEndpointPos = activeEndpointUrl
    ? endpointUrls.indexOf(activeEndpointUrl)
    : -1;
  const endpointStart = activeEndpointPos >= 0 ? activeEndpointPos : 0;
  let endpointOffset = 0;
  const endpointCount = endpointUrls.length;
  const authForAttempt = (value: string | undefined): ProviderAuth => {
    if (endpointCount === 0) return authForSlot(providerId, value);
    const url = endpointUrls[(endpointStart + endpointOffset) % endpointCount]!;
    return { apiKey: value, baseUrl: url };
  };

  for (let planIdx = 0; planIdx < plan.length; planIdx++) {
    const keyIndex = plan[planIdx]!;
    const slot = slots[keyIndex]!;
    const auth = authForAttempt(slot.value);
    const tail = maskSecretTail(slot.value);

    // Announce only when rotating after a failure — never re-toast the sticky
    // key on every agent step ("using [2/4]" spam).
    if (planIdx > 0) {
      emitKey({
        type: "switch",
        provider: providerId,
        maskedTail: tail,
        keyIndex,
        keyCount: slots.length,
        ...(lastError ? { reason: failureReason(lastError) } : {}),
      });
    }

    for (let attempt = 0; attempt < maxPerKey; attempt++) {
      request.signal?.throwIfAborted();
      try {
        let result: CompletionResult;
        if (opts.mode === "stream") {
          result = await tryStreamOnce(
            provider,
            providerId,
            request,
            model,
            auth,
            opts.onToken ?? (() => {}),
            opts.onStatus,
          );
        } else {
          result = await tryCompleteOnce(provider, providerId, request, model, auth);
        }
        // Sticky success only for stored multi-key (not env-only synthetic).
        if (multi.source !== "env" && multi.source !== "local") {
          void markProviderKeySuccess(providerId, keyIndex).catch(() => {});
        }
        if (storedEndpoints && endpointCount > 0) {
          const winningUrl =
            endpointUrls[(endpointStart + endpointOffset) % endpointCount]!;
          const storedIndex = storedEndpoints.urls.indexOf(winningUrl);
          const authoritative = getActiveProviderEndpoint(providerId);
          if (
            storedIndex >= 0 &&
            storedIndex !== storedEndpoints.activeIndex &&
            (authoritative === "" || storedEndpoints.urls.includes(authoritative))
          ) {
            try {
              setActiveProviderEndpoint(providerId, storedIndex);
            } catch {}
          }
        }
        return result as T;
      } catch (error) {
        lastError = error;

        // 404/422: other keys for the same model will not help.
        if (isKeyCircleStopError(error)) {
          throw error;
        }

        // Auth / quota (402 credits): never sleep on the same key — switch now.
        if (isImmediateKeySwitchError(error)) {
          // A workspace-mismatched endpoint (e.g. Modal "different workspace")
          // will fail for every key, so rotate the endpoint before the key.
          if (endpointCount > 1 && endpointOffset + 1 < endpointCount) {
            endpointOffset += 1;
            emitKey({
              type: "endpoint",
              provider: providerId,
              maskedTail: tail,
              reason: failureReason(error),
            });
            planIdx = -1;
            break;
          }
          if (multiKey) {
            // Always advance (or exit plan after last key) so every key is tried.
            break;
          }
          // Single key — surface immediately (no pointless multi-second backoff).
          throw error;
        }

        const rotatable = isKeyRotatableError(error, isRetriableError);
        if (!rotatable) {
          // e.g. 413 — bubble so outer provider fallback can try another provider.
          throw error;
        }

        const canRetrySame = attempt + 1 < maxPerKey;
        if (canRetrySame) {
          const wait = isRateLimited(error)
            ? retryWaitMs(error, attempt)
            : networkRetryWaitMs(attempt);
          if (wait > MAX_RETRY_WAIT_MS) {
            // Don't burn the whole multi-key circle on one impossible wait —
            // move to the next key when multi; single-key still exhausts.
            if (multiKey) break;
            throw error;
          }
          emitKey({
            type: "retry",
            provider: providerId,
            maskedTail: tail,
            reason: failureReason(error),
            waitMs: wait,
            keyIndex,
            keyCount: slots.length,
          });
          await sleep(wait, request.signal);
          continue;
        }
        // Exhausted attempts for this key → next in circle (if any).
        break;
      }
    }

    // Endpoint providers pair each key with a workspace URL (a Modal token
    // only works on its own workspace's endpoint). Advancing the key without
    // advancing the endpoint guarantees a workspace-mismatch 401, so move to
    // the next endpoint first and let the next key pair with it. Auth/quota
    // errors keep their dedicated endpoint-rotation path above.
    if (
      planIdx >= 0 &&
      endpointCount > 1 &&
      planIdx + 1 < plan.length &&
      lastError &&
      !isImmediateKeySwitchError(lastError)
    ) {
      endpointOffset += 1;
      emitKey({
        type: "endpoint",
        provider: providerId,
        maskedTail: tail,
        reason: failureReason(lastError),
      });
    }
  }

  // Single-key rate-limit exhaustion: preserve historical UX string.
  if (!multiKey && lastError && isRateLimited(lastError)) {
    opts.onStatus?.(
      `⏳ ${providerId} rate limited; staying on selected provider.`,
    );
  } else if (multiKey) {
    emitKey({
      type: "exhausted",
      provider: providerId,
      maskedTail: maskSecretTail(slots[plan[0]!]!.value),
      keyCount: slots.length,
      reason: lastError ? failureReason(lastError) : undefined,
    });
  }

  const err = lastError ?? new Error("all API keys failed");
  throw err;
}

export async function completeWithProvider(
  request: CompletionRequest,
  options?: StreamWithProviderOptions,
): Promise<CompletionResult> {
  const config = getConfig();
  const requested = request.provider ?? config.defaultProvider;
  const providerImpl = getProvider(requested);
  const isDefaultModel = !request.model || request.model === providerImpl.defaultModel;
  const fallbackEnabled =
    (await requestedRealKeyCount(requested)) !== 1 &&
    (config.providerFallback ? (isDefaultModel || request.allowModelFallback === true) : request.allowModelFallback === true);
  const order = buildFallbackChain(
    requested,
    config.freeOnly,
    fallbackEnabled,
    request.preferModelFallback === true,
  );
  const failures: ProviderFailure[] = [];
  const emitKey = makeKeyEmitter(options?.onStatus, options?.onKeyEvent);

  for (const providerId of order) {
    request.signal?.throwIfAborted();
    const provider = getProvider(providerId);
    const multi = await getProviderKeys(providerId);
    const hasAuth = multi.keys.length > 0;
    if (!hasAuth) {
      failures.push({ provider: providerId, message: "no API key configured" });
      continue;
    }

    const model =
      providerId === requested
        ? (request.model ?? provider.defaultModel)
        : provider.defaultModel;
    const routeRequest = requestForRoute(request, providerId, model);

    try {
      return await runWithKeyRotation<CompletionResult>({
        providerId,
        provider,
        request: routeRequest,
        model,
        emitKey,
        mode: "complete",
        ...(options?.onStatus ? { onStatus: options.onStatus } : {}),
        ...(options?.maxRetries !== undefined ? { maxRetries: options.maxRetries } : {}),
      });
    } catch (error) {
      failures.push({
        provider: providerId,
        message: failureMessageFor(providerId, error),
        error,
      });
      if (isKeyCircleStopError(error) || shouldStopProviderFallback(error)) {
        throw aggregateProviderError(
          `No provider could complete the request.${formatFailures(failures)}`,
          failures,
        );
      }
      // Continue to next provider in chain when fallback is enabled (e.g. 413).
    }
  }

  throw aggregateProviderError(
    `No provider could complete the request.${formatFailures(failures)}`,
    failures,
  );
}

export async function streamWithProvider(
  request: CompletionRequest,
  onToken: (token: string) => void,
  onStatusOrOptions?: ((message: string) => void) | StreamWithProviderOptions,
): Promise<CompletionResult> {
  const options: StreamWithProviderOptions =
    typeof onStatusOrOptions === "function"
      ? { onStatus: onStatusOrOptions }
      : onStatusOrOptions ?? {};

  const config = getConfig();
  const requested = request.provider ?? config.defaultProvider;
  const providerImpl = getProvider(requested);
  const isDefaultModel = !request.model || request.model === providerImpl.defaultModel;
  const fallbackEnabled =
    (await requestedRealKeyCount(requested)) !== 1 &&
    (config.providerFallback ? (isDefaultModel || request.allowModelFallback === true) : request.allowModelFallback === true);
  const order = buildFallbackChain(
    requested,
    config.freeOnly,
    fallbackEnabled,
    request.preferModelFallback === true,
  );
  const failures: ProviderFailure[] = [];
  const emitStatus = options.onStatus ?? ((message) => onToken(message));
  const emitKey = makeKeyEmitter(emitStatus, options.onKeyEvent);

  for (const providerId of order) {
    request.signal?.throwIfAborted();
    const provider = getProvider(providerId);
    const multi = await getProviderKeys(providerId);
    if (multi.keys.length === 0) {
      failures.push({ provider: providerId, message: "no API key configured" });
      continue;
    }

    const model =
      providerId === requested
        ? (request.model ?? provider.defaultModel)
        : provider.defaultModel;
    const routeRequest = requestForRoute(request, providerId, model);

    try {
      return await runWithKeyRotation<CompletionResult>({
        providerId,
        provider,
        request: routeRequest,
        model,
        emitKey,
        mode: "stream",
        onToken,
        onStatus: emitStatus,
        ...(options.maxRetries !== undefined ? { maxRetries: options.maxRetries } : {}),
      });
    } catch (error) {
      failures.push({
        provider: providerId,
        message: failureMessageFor(providerId, error),
        error,
      });
      if (
        isKeyCircleStopError(error) ||
        shouldStopProviderFallback(error) ||
        // Partial output already reached the transcript; another
        // provider would duplicate it.
        streamAlreadyEmitted(error)
      ) {
        throw aggregateProviderError(
          `No provider could stream the request.${formatFailures(failures)}`,
          failures,
          streamEmittedBytes(error),
        );
      }
      // Continue to next provider when fallback is enabled (e.g. 413).
    }
  }

  throw aggregateProviderError(
    `No provider could stream the request.${formatFailures(failures)}`,
    failures,
  );
}

export async function pingProvider(
  providerId: ProviderId,
  secretOverride?: string,
): Promise<void> {
  const provider = getProvider(providerId);
  const resolved = await providerAuth(providerId);
  const auth: ProviderAuth =
    providerId === "ollama"
      ? { baseUrl: secretOverride ?? resolved.baseUrl }
      : providerUsesEndpoints(providerId)
        ? {
            apiKey: secretOverride ?? resolved.apiKey,
            ...(resolved.baseUrl ? { baseUrl: resolved.baseUrl } : {}),
          }
        : { apiKey: secretOverride ?? resolved.apiKey };
  await provider.ping(auth);
}
