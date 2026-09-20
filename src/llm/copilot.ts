import type { ChatMessage, CompletionRequest, CompletionResult } from "../types.js";
import {
  GITHUB_COPILOT_DISPLAY_NAME,
  defaultModels,
  type LlmProvider,
  type ProviderAuth,
} from "./provider.js";
import {
  openAiCompatibleComplete,
  openAiCompatibleStream,
  toCompletionResult,
  readJson,
  ingestModelCatalogEntries,
  ProviderError,
} from "./http.js";
import {
  COPILOT_REQUEST_HEADERS,
  copilotRequestHeaders,
  copilotInitiator,
  invalidateCopilotApiToken,
  isCopilotOAuthToken,
  resolveCopilotApiToken,
} from "./copilot-auth.js";
import { currentRequestPurpose } from "./request-purpose.js";
import { executeAnthropicComplete, executeAnthropicStream } from "./anthropic.js";
export const copilotFallbackModels: readonly string[] = [
  "gpt-4o",
  "gpt-4o-mini",
  "claude-sonnet-4.5",
  "claude-3.5-sonnet",
  "o1",
  "o3-mini",
];

let cachedModels: string[] | null = null;
let lastFetchTime = 0;
const CACHE_TTL_MS = 30 * 60 * 1000;

export function resetCopilotModelCache(): void {
  cachedModels = null;
  lastFetchTime = 0;
}

function requireKey(auth: ProviderAuth): string {
  if (!auth.apiKey) {
    throw new Error(
      `${GITHUB_COPILOT_DISPLAY_NAME} authentication required. Run \`clai auth copilot\` (device sign-in) or add a key with \`clai set copilot <github-token>\`.`,
    );
  }
  return auth.apiKey;
}

async function withCopilotApiToken<T>(
  auth: ProviderAuth,
  run: (token: string, baseUrl: string) => Promise<T>,
): Promise<T> {
  const githubToken = requireKey(auth);
  const api = await resolveCopilotApiToken(githubToken);
  try {
    return await run(api.token, api.baseUrl);
  } catch (error) {
    const status = error instanceof ProviderError ? error.status : undefined;
    const renewable =
      status === 401 && currentRequestPurpose() === undefined;
    if (!renewable) throw error;
    invalidateCopilotApiToken(githubToken);
    const renewed = await resolveCopilotApiToken(githubToken);
    if (!renewed.token || renewed.token === api.token) throw error;
    return run(renewed.token, renewed.baseUrl);
  }
}

function copilotHeaders(messages: readonly ChatMessage[]): Record<string, string> {
  return copilotRequestHeaders({
    "X-Initiator": copilotInitiator(messages),
  });
}

function isAnthropicModel(model: string): boolean {
  return /(?:^|[./-])(?:anthropic|claude)(?:[./-]|$)/i.test(model);
}

function filterCopilotEntries(entries: readonly unknown[]): unknown[] {
  const usable = entries.filter((raw) => {
    if (!raw || typeof raw !== "object") return false;
    const item = raw as Record<string, unknown>;
    const policy = item.policy as Record<string, unknown> | undefined;
    return policy?.state !== "disabled";
  });
  const pickerEnabled = usable.filter((raw) => {
    const item = raw as Record<string, unknown>;
    return item.model_picker_enabled === true;
  });
  return pickerEnabled.length > 0 ? pickerEnabled : usable;
}

export const copilotProvider: LlmProvider = {
  id: "copilot",
  displayName: GITHUB_COPILOT_DISPLAY_NAME,
  reasoningStyle: "openai",
  defaultModel: defaultModels.copilot,
  envVar: "COPILOT_API_KEY",
  validateKey: (key: string) => isCopilotOAuthToken(key.trim()),
  async listModels(auth: ProviderAuth): Promise<string[]> {
    const now = Date.now();
    if (cachedModels && now - lastFetchTime < CACHE_TTL_MS) {
      return cachedModels;
    }
    const githubToken = requireKey(auth);
    const api = await resolveCopilotApiToken(githubToken);
    const response = await fetch(`${api.baseUrl}/models`, {
      headers: {
        authorization: `Bearer ${api.token}`,
        accept: "application/json",
        ...COPILOT_REQUEST_HEADERS,
      },
    });
    const payload = await readJson<{ data?: unknown[] }>(response);
    const entries = Array.isArray(payload.data) ? payload.data : [];
    const filtered = filterCopilotEntries(entries);
    const models = ingestModelCatalogEntries("copilot", filtered);
    const result = models.length > 0 ? models : [...copilotFallbackModels];
    if (result.length > 0) {
      cachedModels = result;
      lastFetchTime = now;
    }
    return result;
  },
  async ping(auth: ProviderAuth): Promise<void> {
    const githubToken = requireKey(auth);
    const api = await resolveCopilotApiToken(githubToken);
    const response = await fetch(`${api.baseUrl}/models`, {
      headers: {
        authorization: `Bearer ${api.token}`,
        accept: "application/json",
        ...COPILOT_REQUEST_HEADERS,
      },
    });
    if (!response.ok) {
      throw new ProviderError(
        `${GITHUB_COPILOT_DISPLAY_NAME} authentication failed (HTTP ${response.status}). Run \`clai auth copilot\` to sign in.`,
        response.status,
      );
    }
  },
  async complete(
    request: CompletionRequest,
    auth: ProviderAuth,
  ): Promise<CompletionResult> {
    const model = await resolveCopilotModel(auth, request.model);
    if (isAnthropicModel(model)) {
      return withCopilotApiToken(auth, async (token, baseUrl) => {
        const headers = {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
          "anthropic-version": "2023-06-01",
          ...copilotHeaders(request.messages),
        };
        return executeAnthropicComplete(
          { ...request, provider: "copilot", model },
          { apiKey: token, baseUrl: `${baseUrl}/v1` },
          headers,
        );
      });
    }
    return withCopilotApiToken(auth, async (token, baseUrl) => {
      const isGpt = /(?:^|[./-])(?:gpt|o\d)(?:[./-]|$)/i.test(model);
      const payload = await openAiCompatibleComplete({
        provider: GITHUB_COPILOT_DISPLAY_NAME,
        providerId: "copilot",
        baseUrl,
        apiKey: token,
        model,
        messages: request.messages,
        maxTokens: isGpt ? undefined : request.maxTokens,
        temperature: request.temperature,
        headers: copilotHeaders(request.messages),
        signal: request.signal,
        reasoning: request.thinking,
        reasoningStyle: "openai",
        tools: request.tools,
        toolChoice: request.toolChoice,
        parallelToolCalls: request.parallelToolCalls,
        reasoningArtifactReplayObserver: request.onReasoningArtifactReplayDecision,
        ...(request.forceReasoningReplay ? { forceReasoningReplay: true } : {}),
      });
      return toCompletionResult("copilot", model, payload);
    });
  },
  async stream(
    request: CompletionRequest,
    auth: ProviderAuth,
    onToken: (token: string) => void,
  ): Promise<CompletionResult> {
    const model = await resolveCopilotModel(auth, request.model);
    if (isAnthropicModel(model)) {
      return withCopilotApiToken(auth, async (token, baseUrl) => {
        const headers = {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
          "anthropic-version": "2023-06-01",
          ...copilotHeaders(request.messages),
        };
        return executeAnthropicStream(
          { ...request, provider: "copilot", model },
          { apiKey: token, baseUrl: `${baseUrl}/v1` },
          onToken,
          headers,
        );
      });
    }
    return withCopilotApiToken(auth, async (token, baseUrl) => {
      const isGpt = /(?:^|[./-])(?:gpt|o\d)(?:[./-]|$)/i.test(model);
      const payload = await openAiCompatibleStream({
        provider: GITHUB_COPILOT_DISPLAY_NAME,
        providerId: "copilot",
        baseUrl,
        apiKey: token,
        model,
        messages: request.messages,
        maxTokens: isGpt ? undefined : request.maxTokens,
        temperature: request.temperature,
        headers: copilotHeaders(request.messages),
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
      return toCompletionResult("copilot", model, payload);
    });
  },
};

async function resolveCopilotModel(
  auth: ProviderAuth,
  requestedModel?: string,
): Promise<string> {
  let available: string[] = [];
  try {
    available = await copilotProvider.listModels!(auth);
  } catch {
    available = cachedModels ?? [...copilotFallbackModels];
  }
  if (!available.length) {
    return requestedModel ?? defaultModels.copilot;
  }
  if (requestedModel && available.includes(requestedModel)) {
    return requestedModel;
  }
  if (requestedModel) {
    const normalized = requestedModel.trim().toLowerCase();
    const match = available.find((m) => m.trim().toLowerCase() === normalized);
    if (match) return match;
  }
  const preferred = [
    "gpt-4o-mini",
    "gpt-4.1-mini",
    "gpt-4o",
    "gpt-4.1",
    "claude-3.5-sonnet",
    "claude-sonnet-4.5",
  ];
  for (const candidate of preferred) {
    if (available.includes(candidate)) {
      return candidate;
    }
  }
  return available[0] ?? defaultModels.copilot;
}
