import type { CompletionRequest, CompletionResult } from "../types.js";
import {
  defaultModels,
  type LlmProvider,
  type ProviderAuth,
} from "./provider.js";
import { singleLeadingSystemMessages } from "./system-messages.js";
import {
  ingestOpenAiModelCatalog,
  openAiCompatibleComplete,
  openAiCompatiblePing,
  openAiCompatibleStream,
  readJson,
  toCompletionResult,
} from "./http.js";

/**
 * OrcaRouter — an OpenAI-compatible multi-provider gateway
 * (https://api.orcarouter.ai/v1) that routes OpenAI, Anthropic, Google
 * Gemini, DeepSeek, xAI Grok, Qwen, Kimi, MiniMax, Z.ai GLM and more behind
 * one bearer key at provider cost price. Model ids are provider-prefixed
 * (`openai/gpt-4o-mini`, `anthropic/claude-sonnet-4.6`, …).
 *
 * Chat Completions with SSE streaming, native tool calling, structured
 * outputs (`response_format`), vision via `image_url` and a unified
 * top-level `reasoning_effort` knob that the gateway translates to each
 * upstream's native reasoning shape. Reasoning output arrives as
 * `reasoning_content`, which the shared OpenAI helper folds into the
 * thinking block.
 */
const baseUrl = "https://api.orcarouter.ai/v1";

/**
 * Offline fallback catalog (documented chat models) used when `/models` is
 * unreachable. The live catalog is authoritative when it can be fetched.
 */
export const orcarouterFallbackModels = [
  "orcarouter/auto",
  "openai/gpt-4o-mini",
  "openai/gpt-4o",
  "openai/gpt-5",
  "openai/gpt-5-mini",
  "openai/o3-mini",
  "openai/o4-mini",
  "anthropic/claude-sonnet-4.6",
  "anthropic/claude-opus-4.7",
  "google/gemini-2.5-flash",
  "google/gemini-2.5-pro",
  "google/gemini-3-pro-preview",
  "deepseek/deepseek-chat",
  "deepseek/deepseek-reasoner",
  "grok/grok-4-fast-reasoning",
  "qwen/qwen3-max",
  "qwen/qwen3.6-plus",
  "kimi/kimi-k2.6",
  "minimax/minimax-m2.7",
  "z-ai/glm-5.1",
];

/** Non-chat modalities that still advertise an `openai` endpoint type. */
const NON_CHAT_MODEL =
  /image|imagen|dall-e|tts|whisper|embed|video|imagine|dreamina|seedance|kling|moderation/i;

interface OrcaModelEntry {
  id?: unknown;
  supported_endpoint_types?: unknown;
}

/**
 * Keep only models reachable over Chat Completions. OrcaRouter's catalog
 * flags each entry with `supported_endpoint_types`; anything that does not
 * list `openai` (plus image/video/tts/embedding ids that do) would 404 on
 * `/chat/completions` and pollutes the `/model` picker.
 */
function chatModelsFromCatalog(payload: unknown): unknown[] {
  const container = payload as { data?: unknown } | undefined;
  const entries = Array.isArray(payload)
    ? payload
    : Array.isArray(container?.data)
      ? container.data
      : [];
  return entries.filter((entry) => {
    if (typeof entry === "string") return !NON_CHAT_MODEL.test(entry);
    const item = entry as OrcaModelEntry;
    const id = typeof item.id === "string" ? item.id : "";
    if (!id || NON_CHAT_MODEL.test(id)) return false;
    const endpoints = item.supported_endpoint_types;
    if (Array.isArray(endpoints) && endpoints.length > 0) {
      return endpoints.includes("openai");
    }
    return true;
  });
}

let cachedModels: string[] | null = null;
let lastFetchTime = 0;
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour cache TTL

export const orcarouterProvider: LlmProvider = {
  id: "orcarouter",
  reasoningStyle: "openai",
  displayName: "OrcaRouter",
  defaultModel: defaultModels.orcarouter,
  envVar: "ORCAROUTER_API_KEY",
  validateKey: (key: string) => /^sk-[A-Za-z0-9_-]{8,}$/.test(key),
  async listModels(auth: ProviderAuth): Promise<string[]> {
    const now = Date.now();
    if (cachedModels && now - lastFetchTime < CACHE_TTL_MS) {
      return cachedModels;
    }
    try {
      const reqHeaders: Record<string, string> = {};
      if (auth.apiKey) reqHeaders["authorization"] = `Bearer ${auth.apiKey}`;
      const response = await fetch(`${baseUrl}/models`, {
        headers: reqHeaders,
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await readJson<{ data?: Array<OrcaModelEntry> }>(response);
      const models = ingestOpenAiModelCatalog(
        "orcarouter",
        chatModelsFromCatalog(data),
      );
      if (models.length > 0) {
        cachedModels = models;
        lastFetchTime = now;
        return models;
      }
      return cachedModels ?? orcarouterFallbackModels;
    } catch {
      return cachedModels ?? orcarouterFallbackModels;
    }
  },
  async ping(auth: ProviderAuth): Promise<void> {
    if (!auth.apiKey) throw new Error("OrcaRouter API key is required");
    await openAiCompatiblePing(baseUrl, auth.apiKey);
  },
  async complete(
    request: CompletionRequest,
    auth: ProviderAuth,
  ): Promise<CompletionResult> {
    if (!auth.apiKey) throw new Error("OrcaRouter API key is required");
    const model = request.model ?? defaultModels.orcarouter;
    const payload = await openAiCompatibleComplete({
      provider: "OrcaRouter",
      providerId: "orcarouter",
      baseUrl,
      apiKey: auth.apiKey,
      model,
      messages: singleLeadingSystemMessages(request.messages),
      maxTokens: request.maxTokens,
      temperature: request.temperature,
      signal: request.signal,
      reasoning: request.thinking,
      reasoningStyle: "openai",
      tools: request.tools,
      toolChoice: request.toolChoice,
      parallelToolCalls: request.parallelToolCalls,
      reasoningArtifactReplayObserver: request.onReasoningArtifactReplayDecision,
      ...(request.forceReasoningReplay ? { forceReasoningReplay: true } : {}),
    });
    return toCompletionResult("orcarouter", model, payload);
  },
  async stream(
    request: CompletionRequest,
    auth: ProviderAuth,
    onToken: (token: string) => void,
  ): Promise<CompletionResult> {
    if (!auth.apiKey) throw new Error("OrcaRouter API key is required");
    const model = request.model ?? defaultModels.orcarouter;
    const payload = await openAiCompatibleStream({
      provider: "OrcaRouter",
      providerId: "orcarouter",
      baseUrl,
      apiKey: auth.apiKey,
      model,
      messages: singleLeadingSystemMessages(request.messages),
      maxTokens: request.maxTokens,
      temperature: request.temperature,
      signal: request.signal,
      onToken,
      onToolCallDelta: request.onToolCallDelta,
      onStreamEvent: request.onStreamEvent,
      reasoning: request.thinking,
      reasoningStyle: "openai",
      tools: request.tools,
      toolChoice: request.toolChoice,
      parallelToolCalls: request.parallelToolCalls,
      reasoningArtifactReplayObserver: request.onReasoningArtifactReplayDecision,
      ...(request.forceReasoningReplay ? { forceReasoningReplay: true } : {}),
    });
    return toCompletionResult("orcarouter", model, payload);
  },
};
