
import type { CompletionRequest, CompletionResult, ProviderId } from "../types.js";
import { normalizeEndpointUrl, type LlmProvider, type ProviderAuth } from "./provider.js";
import {
  openAiCompatibleComplete,
  openAiCompatiblePing,
  openAiCompatibleStream,
  toCompletionResult,
  readJson,
  ingestOpenAiModelCatalog,
  isStreamOptionsUnsupportedError,
} from "./http.js";
import { responsesComplete } from "./responses-complete.js";
import { responsesStream } from "./responses-stream.js";
import {
  mapResponsesEffort,
  responsesReasoningSummary,
  type ResponsesAccept,
  type ResponsesBodyExtrasContext,
  type ResponsesDialectConfig,
} from "./responses-config.js";
import { CHAT_COMPLETIONS_STREAM_TERMINAL } from "./stream-terminal.js";
import { anthropicProvider } from "./anthropic.js";
import type { CompatibleUsageAliases } from "./token-usage.js";
import {
  customReasoningStyle,
  endpointPrivacyHash,
  resolveCustomHeaders,
  validateCustomProviderProfile,
  type CustomProviderProfileSpec,
} from "./custom-provider-profile.js";
import { recordControlRejection } from "./provider-profile.js";
export type CustomProviderApi =
  | "chat-completions"
  | "responses"
  | "anthropic-messages";

export interface CustomProviderDef {
  readonly id: string;
  readonly displayName: string;
  readonly baseUrl: string;
  readonly envVar?: string | undefined;
  readonly keyEnv?: string | undefined;
  readonly baseUrlEnv?: string | undefined;
  readonly defaultModel: string;
  readonly api?: CustomProviderApi | undefined;
  readonly usageAliases?: CompatibleUsageAliases | undefined;
  readonly profile?: CustomProviderProfileSpec | undefined;
}

export function customProviderProfileErrors(
  def: CustomProviderDef,
): string[] {
  if (!def.profile) return [];
  return validateCustomProviderProfile(def.profile).errors;
}

function resolveBaseUrl(def: CustomProviderDef, auth: ProviderAuth): string {
  const override = normalizeEndpointUrl(auth.baseUrl ?? "");
  return override || def.baseUrl;
}

function authHeaders(
  def: CustomProviderDef,
  apiKey: string | undefined,
): Record<string, string> | undefined {
  const declared = resolveCustomHeaders(def.profile?.headers);
  if (def.profile?.authType === "none-keyless") return declared;
  if (def.profile?.authType === "custom-headers") return declared;
  if (declared && apiKey) {
    return { authorization: `Bearer ${apiKey}`, ...declared };
  }
  return undefined;
}

function responsesConfig(
  def: CustomProviderDef,
  baseUrl: string,
): ResponsesDialectConfig {
  return {
    baseUrl,
    providerId: def.id as ProviderId,
    displayName: def.displayName,
    artifactDialect: "openai-compatible",
    terminalPolicy: {
      proofs: ["response-completed", "response-incomplete"],
      naturalEofAccepted: false,
    },
    buildHeaders(auth: ProviderAuth, accept: ResponsesAccept) {
      const apiKey = auth.apiKey;
      return {
        "content-type": "application/json",
        accept,
        ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
        ...authHeaders(def, apiKey),
      };
    },
    reasoningPayload(reasoning) {
      if (!reasoning?.enabled) return undefined;
      const effort = mapResponsesEffort(reasoning.effort);
      return { effort, summary: responsesReasoningSummary(effort) };
    },
    bodyExtras(_context: ResponsesBodyExtrasContext) {
      return { store: false, include: ["reasoning.encrypted_content"] };
    },
  };
}

export function buildCustomProvider(def: CustomProviderDef): LlmProvider {
  const providerId = def.id as ProviderId;
  const modelCache = new Map<string, { models: string[]; fetchedAt: number }>();
  const CACHE_TTL_MS = 60 * 60 * 1000;
  const keyless =
    def.profile?.authType === "none-keyless" ||
    def.profile?.authType === "custom-headers";
  const declaredStreamOptions = def.profile?.streamOptions;
  let includeStreamUsage = declaredStreamOptions !== "unsupported";
  const reasoningStyle = customReasoningStyle(def.profile);

  const requireKey = (auth: ProviderAuth): string | undefined => {
    if (keyless) return undefined;
    if (!auth.apiKey) throw new Error(`${def.displayName} API key is required`);
    return auth.apiKey;
  };

  return {
    id: providerId,
    displayName: def.displayName,
    defaultModel: def.defaultModel,
    reasoningStyle,
    ...(def.keyEnv ?? def.envVar
      ? { envVar: def.keyEnv ?? def.envVar }
      : {}),
    validateKey: (key: string) => key.trim().length >= 8,
    async listModels(auth: ProviderAuth): Promise<string[]> {
      const baseUrl = resolveBaseUrl(def, auth);
      const cacheKey = `${baseUrl}|${auth.apiKey ?? ""}`;
      const now = Date.now();
      const cached = modelCache.get(cacheKey);
      if (cached && now - cached.fetchedAt < CACHE_TTL_MS) return cached.models;
      try {
        const headers = def.api === "anthropic-messages"
          ? {
              ...(auth.apiKey ? { "x-api-key": auth.apiKey } : {}),
              "anthropic-version": "2023-06-01",
            }
          : authHeaders(def, auth.apiKey) ?? {};
        const response = await fetch(`${baseUrl}/models`, { headers });
        const data = await readJson<{ data?: Array<{ id?: string }> }>(response);
        const models = ingestOpenAiModelCatalog(providerId, data);
        if (models.length > 0) modelCache.set(cacheKey, { models, fetchedAt: now });
        return models;
      } catch {
        return [];
      }
    },
    async ping(auth: ProviderAuth): Promise<void> {
      const apiKey = requireKey(auth);
      if (def.api === "anthropic-messages") {
        const response = await fetch(`${resolveBaseUrl(def, auth)}/models`, {
          headers: {
            ...(apiKey ? { "x-api-key": apiKey } : {}),
            "anthropic-version": "2023-06-01",
          },
        });
        await readJson<unknown>(response);
        return;
      }
      await openAiCompatiblePing(
        resolveBaseUrl(def, auth),
        apiKey ?? "",
        authHeaders(def, apiKey),
      );
    },
    async complete(request: CompletionRequest, auth: ProviderAuth): Promise<CompletionResult> {
      const apiKey = requireKey(auth);
      const model = request.model ?? def.defaultModel;
      const baseUrl = resolveBaseUrl(def, auth);
      if (def.api === "responses") {
        return responsesComplete(
          responsesConfig(def, baseUrl),
          request,
          { ...auth, apiKey },
          model,
        );
      }
      if (def.api === "anthropic-messages") {
        const result = await anthropicProvider.complete(
          { ...request, provider: providerId, model },
          { ...auth, apiKey, baseUrl },
        );
        return { ...result, provider: providerId, model };
      }
      const payload = await openAiCompatibleComplete({
        responsesFirst: def.api === undefined,
        provider: def.displayName, providerId,
        baseUrl, apiKey: apiKey ?? "",
        headers: authHeaders(def, apiKey), model,
        messages: request.messages, maxTokens: request.maxTokens,
        temperature: request.temperature, signal: request.signal,
        reasoning: request.thinking, reasoningStyle,
        tools: request.tools, toolChoice: request.toolChoice,
        parallelToolCalls: request.parallelToolCalls,
        reasoningArtifactReplayObserver: request.onReasoningArtifactReplayDecision,
        ...(request.forceReasoningReplay ? { forceReasoningReplay: true } : {}),
        usageAliases: def.usageAliases,
      });
      return toCompletionResult(providerId, model, payload);
    },
    async stream(
      request: CompletionRequest, auth: ProviderAuth, onToken: (token: string) => void,
    ): Promise<CompletionResult> {
      const apiKey = requireKey(auth);
      const model = request.model ?? def.defaultModel;
      const baseUrl = resolveBaseUrl(def, auth);
      const headers = authHeaders(def, apiKey);
      if (def.api === "responses") {
        return responsesStream(
          responsesConfig(def, baseUrl),
          request,
          { ...auth, apiKey },
          onToken,
          model,
        );
      }
      if (def.api === "anthropic-messages") {
        const result = await anthropicProvider.stream!(
          { ...request, provider: providerId, model },
          { ...auth, apiKey, baseUrl },
          onToken,
        );
        return { ...result, provider: providerId, model };
      }
      const stream = (withUsage: boolean) => openAiCompatibleStream({
        responsesFirst: def.api === undefined,
        provider: def.displayName, providerId, baseUrl,
        apiKey: apiKey ?? "", headers, model,
        messages: request.messages, maxTokens: request.maxTokens,
        temperature: request.temperature, signal: request.signal, onToken,
        onToolCallDelta: request.onToolCallDelta, onStreamEvent: request.onStreamEvent, reasoning: request.thinking,
        reasoningStyle, tools: request.tools, toolChoice: request.toolChoice,
        parallelToolCalls: request.parallelToolCalls,
        reasoningArtifactReplayObserver: request.onReasoningArtifactReplayDecision,
        ...(request.forceReasoningReplay ? { forceReasoningReplay: true } : {}),
        includeStreamUsage: withUsage,
        usageAliases: def.usageAliases,
        streamTerminal:
          def.profile?.terminal?.naturalEofAccepted === true
            ? { ...CHAT_COMPLETIONS_STREAM_TERMINAL, naturalEofAccepted: true }
            : undefined,
      });
      let payload;
      try {
        payload = await stream(includeStreamUsage);
      } catch (error) {
        if (!includeStreamUsage || !isStreamOptionsUnsupportedError(error)) throw error;
        if (declaredStreamOptions === "supported") {
          recordControlRejection({
            provider: def.id,
            model,
            endpointHash: endpointPrivacyHash(baseUrl),
            field: "stream_options",
          });
          throw error;
        }
        includeStreamUsage = false;
        payload = await stream(false);
      }
      return toCompletionResult(providerId, model, payload);
    },
  };
}


async function readCustomDefs(): Promise<CustomProviderDef[]> {
  const { getCustomProviders } = await import("../store/config.js");
  return getCustomProviders();
}

export async function getCustomProviderIds(): Promise<string[]> {
  const defs = await readCustomDefs();
  return defs.map((d) => d.id);
}

export function findCustomProviderDef(
  id: string,
  defs: readonly CustomProviderDef[],
): CustomProviderDef | undefined {
  return defs.find((d) => d.id === id);
}

const providerCache = new Map<string, LlmProvider>();

export async function getCustomProvider(id: string): Promise<LlmProvider | undefined> {
  const cached = providerCache.get(id);
  if (cached) return cached;
  const defs = await readCustomDefs();
  const def = findCustomProviderDef(id, defs);
  if (!def) return undefined;
  const built = buildCustomProvider(def);
  providerCache.set(id, built);
  return built;
}

import { getCustomProviders } from "../store/config.js";

export function getCustomProviderSync(id: string): LlmProvider | undefined {
  const cached = providerCache.get(id);
  if (cached) return cached;
  const def = findCustomProviderDef(id, getCustomProviders());
  if (!def) return undefined;
  const built = buildCustomProvider(def);
  providerCache.set(id, built);
  return built;
}

export function invalidateCustomProviderCache(id?: string): void {
  if (id) providerCache.delete(id);
  else providerCache.clear();
}

export function materializeCustomProvider(def: CustomProviderDef): LlmProvider {
  return buildCustomProvider(def);
}

export function normalizeCustomProviderId(raw: string, existing: readonly string[]): string {
  const id = raw.trim().toLowerCase();
  if (!id) return "";
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) return "";
  if (existing.includes(id)) return "";
  return id;
}

export function normalizeCustomBaseUrl(raw: string): string {
  return normalizeEndpointUrl(raw);
}
