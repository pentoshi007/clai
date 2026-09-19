import type { ChatMessage, CompletionRequest, CompletionResult } from "../types.js";
import { defaultModels, type LlmProvider, type ProviderAuth } from "./provider.js";
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

let cachedModels: string[] | null = null;
let lastFetchTime = 0;
const CACHE_TTL_MS = 60 * 60 * 1000;

function requireKey(auth: ProviderAuth): string {
  if (!auth.apiKey) {
    throw new Error(
      "GitHub Copilot authentication required. Run `clai auth copilot` (device sign-in) or add a key with `clai set copilot <github-token>`.",
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

export const copilotProvider: LlmProvider = {
  id: "copilot",
  displayName: "GitHub Copilot",
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
    const models = ingestModelCatalogEntries("copilot", entries);
    if (models.length > 0) {
      cachedModels = models;
      lastFetchTime = now;
    }
    return models;
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
        `GitHub Copilot authentication failed (HTTP ${response.status}). Run \`clai auth copilot\` to sign in.`,
        response.status,
      );
    }
  },
  async complete(
    request: CompletionRequest,
    auth: ProviderAuth,
  ): Promise<CompletionResult> {
    const model = request.model ?? defaultModels.copilot;
    return withCopilotApiToken(auth, async (token, baseUrl) => {
      const payload = await openAiCompatibleComplete({
        provider: "GitHub Copilot",
        providerId: "copilot",
        baseUrl,
        apiKey: token,
        model,
        messages: request.messages,
        maxTokens: request.maxTokens,
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
    const model = request.model ?? defaultModels.copilot;
    return withCopilotApiToken(auth, async (token, baseUrl) => {
      const payload = await openAiCompatibleStream({
        provider: "GitHub Copilot",
        providerId: "copilot",
        baseUrl,
        apiKey: token,
        model,
        messages: request.messages,
        maxTokens: request.maxTokens,
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
