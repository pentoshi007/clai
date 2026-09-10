import type {
  ChatMessage,
  CompletionRequest,
  CompletionResult,
  ProviderId,
  ReasoningArtifactReplayObserver,
  ReasoningPreference,
  ToolChoice,
  ToolDefinition,
} from "../../types.js";
import {
  classifyResponsesFailure,
  failureText,
  isGenericModelRejection,
  providerStatusCode,
  type ExtrasLevel,
} from "./responses-failure.js";
import { cacheAffinityKey, sessionCacheAffinityKey } from "../cache-affinity.js";
import { cachePolicyFields } from "../cache-policy-fields.js";
import { customProfileSpecFor } from "../custom-profile-resolver.js";
import { currentSessionAffinity } from "../session-affinity.js";
import { responsesComplete } from "../responses-complete.js";
import { isResponsesEmptyOutput } from "../responses-empty-output.js";
import { responsesStream } from "../responses-stream.js";
import {
  mapResponsesEffort,
  responsesReasoningSummary,
  type ResponsesAccept,
  type ResponsesBodyExtrasContext,
  type ResponsesDialectConfig,
} from "../responses-config.js";
import { isChatShapedResponsesPayload, assertResponsesShapedData } from "../responses-shape.js";
import { withUnrecordedTransport } from "../operation-usage.js";
import { emitTransportEvent, type TransportEventKind } from "../transport-events.js";
import type { ProviderAuth } from "../provider.js";
import type { OpenAiCompatibleResult } from "./reasoning-artifacts.js";
import type { ProviderStreamEventSink } from "../stream-events.js";
import type { ReasoningStyle } from "./reasoning-payload.js";
import {
  hasVisibleReasoning,
  preflightOptions,
  resetResponsesPreflight,
  selectResponsesWire,
  type ResponsesSelection,
} from "./responses-preflight.js";

const RESPONSES_FIRST_EXCLUDED: ReadonlySet<ProviderId> = new Set([
  "anthropic",
  "gemini",
  "ollama",
  "aws-mantle",
  "meta",
]);

export function responsesFirstCandidate(providerId: ProviderId): boolean {
  return !RESPONSES_FIRST_EXCLUDED.has(providerId);
}

const RESPONSES_STREAM_TERMINAL = {
  proofs: ["response-completed", "response-incomplete"],
  naturalEofAccepted: false,
} as const;

function genericResponsesConfig(
  providerId: ProviderId,
  displayName: string,
  baseUrl: string,
  extraHeaders: Record<string, string> | undefined,
  extras: ExtrasLevel,
): ResponsesDialectConfig {
  return {
    baseUrl,
    providerId,
    displayName,
    artifactDialect: "openai-compatible",
    terminalPolicy: RESPONSES_STREAM_TERMINAL,
    omitSampling: extras === "bare",
    buildHeaders(auth: ProviderAuth, accept: ResponsesAccept) {
      return {
        "content-type": "application/json",
        accept,
        ...(auth.apiKey ? { authorization: `Bearer ${auth.apiKey}` } : {}),
        ...extraHeaders,
      };
    },
    reasoningPayload(reasoning: ReasoningPreference | undefined) {
      if (!reasoning?.enabled) return undefined;
      const effort = mapResponsesEffort(reasoning.effort);
      return { effort, summary: responsesReasoningSummary(effort) };
    },
    bodyExtras(context: ResponsesBodyExtrasContext) {
      const affinity = currentSessionAffinity();
      const key = affinity
        ? sessionCacheAffinityKey(affinity)
        : cacheAffinityKey(providerId, context.model, context.messages);
      const promptCacheKey = `${context.purpose === "auxiliary" ? "aux-" : ""}${key}`;
      const customCache = customProfileSpecFor(providerId)?.cache;
      if (extras === "bare") {
        return providerId === "explabs"
          ? { prompt_cache_key: promptCacheKey }
          : {};
      }
      return {
        store: false,
        include: ["reasoning.encrypted_content"],
        ...(customCache ? cachePolicyFields({
          provider: providerId,
          model: context.model,
          messages: context.messages,
          purpose: context.purpose,
          policy: { ...customCache, kind: customCache.kind ?? "unknown" },
        }) : { prompt_cache_key: promptCacheKey }),
      };
    },
  };
}

export interface ResponsesFirstOptions {
  provider: string;
  providerId: ProviderId;
  baseUrl: string;
  apiKey: string;
  model: string;
  messages: ChatMessage[];
  maxTokens?: number | undefined;
  temperature?: number | undefined;
  headers?: Record<string, string> | undefined;
  signal?: AbortSignal | undefined;
  reasoning?: ReasoningPreference | undefined;
  reasoningStyle?: ReasoningStyle | undefined;
  includeStreamUsage?: boolean | undefined;
  tools?: ToolDefinition[] | undefined;
  toolChoice?: ToolChoice | undefined;
  parallelToolCalls?: boolean | undefined;
  reasoningArtifactReplayObserver?: ReasoningArtifactReplayObserver | undefined;
}

interface StreamBridgeOptions {
  onToken: (token: string) => void;
  onToolCallDelta?: CompletionRequest["onToolCallDelta"];
  onStreamEvent?: ProviderStreamEventSink;
}

type ResponsesRunner = (
  config: ResponsesDialectConfig,
  request: CompletionRequest,
  auth: ProviderAuth,
  onToken: (token: string) => void,
) => Promise<CompletionResult>;

type ChatProbe = (options: ResponsesFirstOptions) => Promise<OpenAiCompatibleResult>;

function bridgeCompletionRequest(
  options: ResponsesFirstOptions,
  stream?: StreamBridgeOptions,
): CompletionRequest {
  return {
    provider: options.providerId,
    model: options.model,
    messages: options.messages,
    maxTokens: options.maxTokens,
    temperature: options.temperature,
    signal: options.signal,
    thinking: options.reasoning,
    tools: options.tools,
    toolChoice: options.toolChoice,
    parallelToolCalls: options.parallelToolCalls,
    onReasoningArtifactReplayDecision: options.reasoningArtifactReplayObserver,
    ...(stream?.onToolCallDelta
      ? { onToolCallDelta: stream.onToolCallDelta }
      : {}),
    ...(stream?.onStreamEvent ? { onStreamEvent: stream.onStreamEvent } : {}),
  };
}

function compatibleFromCompletion(
  result: CompletionResult,
): OpenAiCompatibleResult {
  return {
    text: result.text,
    ...(result.toolCalls?.length ? { toolCalls: result.toolCalls } : {}),
    ...(result.finishReason ? { finishReason: result.finishReason } : {}),
    ...(result.usage ? { usage: result.usage } : {}),
    ...(result.reasoningBlock ? { reasoningBlock: result.reasoningBlock } : {}),
    ...(result.reasoningArtifacts?.length
      ? { reasoningArtifacts: result.reasoningArtifacts }
      : {}),
  };
}

async function runResponsesFirst(
  options: ResponsesFirstOptions,
  run: ResponsesRunner,
  probeChat: ChatProbe,
  stream?: StreamBridgeOptions,
): Promise<OpenAiCompatibleResult | undefined> {
  if (!responsesFirstCandidate(options.providerId)) return undefined;
  const configFor = (extras: ExtrasLevel): ResponsesDialectConfig =>
    genericResponsesConfig(options.providerId, options.provider, options.baseUrl, options.headers, extras);
  const auth: ProviderAuth = { apiKey: options.apiKey };
  const selection = await selectResponsesWire(options, Boolean(stream), async (signal) => {
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(new DOMException("Capability preflight timed out", "TimeoutError")), 30_000);
    const probeSignal = AbortSignal.any([signal, timeout.signal]);
    const probe = preflightOptions(options, probeSignal);
    const fallback = (kind: TransportEventKind, extras: ExtrasLevel): ResponsesSelection => {
      emitTransportEvent({ kind, provider: options.provider, model: options.model });
      return { wire: "chat", extras };
    };
    try {
      return await withUnrecordedTransport(async () => {
        let extras: ExtrasLevel = "full";
        let result: OpenAiCompatibleResult;
        for (;;) {
          probeSignal.throwIfAborted();
          try {
            result = compatibleFromCompletion(await run(configFor(extras), bridgeCompletionRequest(probe), auth, () => {}));
            break;
          } catch (error) {
            probeSignal.throwIfAborted();
            if (isChatShapedResponsesPayload(error) || isResponsesEmptyOutput(error)) {
              return fallback("responses-fallback-shape", extras);
            }
            const verdict = classifyResponsesFailure(error, extras);
            if (verdict === "unsupported-endpoint") return fallback("responses-fallback-endpoint", extras);
            if (verdict === "unsupported-extras") {
              extras = "bare";
              emitTransportEvent({ kind: "responses-downgrade-extras", provider: options.provider, model: options.model });
              continue;
            }
            if (classifyResponsesFailure(error, "full") === "unsupported-extras" ||
              isGenericModelRejection(providerStatusCode(error), failureText(error))) {
              return fallback("responses-fallback-error", extras);
            }
            throw error;
          }
        }
        probeSignal.throwIfAborted();
        if (options.reasoning?.enabled && !hasVisibleReasoning(result)) {
          try {
            const chat = await probeChat(probe);
            probeSignal.throwIfAborted();
            if (hasVisibleReasoning(chat)) return fallback("responses-fallback-reasoning", extras);
          } catch (error) {
            signal.throwIfAborted();
            const status = providerStatusCode(error);
            if (status === 401 || status === 403 || status === 429) throw error;
          }
        }
        return { wire: "responses", extras };
      }, probe.maxTokens);
    } finally {
      clearTimeout(timer);
    }
  });
  options.signal?.throwIfAborted();
  if (selection.wire === "chat") return undefined;
  return compatibleFromCompletion(await run(configFor(selection.extras), bridgeCompletionRequest(options, stream), auth, stream?.onToken ?? (() => {})));
}

export async function openAiCompatibleCompleteViaResponses(
  options: ResponsesFirstOptions,
  probeChat: ChatProbe,
): Promise<OpenAiCompatibleResult | undefined> {
  return runResponsesFirst(
    options,
    (config, request, auth, _onToken) =>
      responsesComplete(config, request, auth, options.model, assertResponsesShapedData),
    probeChat,
  );
}

export async function openAiCompatibleStreamViaResponses(
  options: ResponsesFirstOptions,
  stream: StreamBridgeOptions,
  probeChat: ChatProbe,
): Promise<OpenAiCompatibleResult | undefined> {
  return runResponsesFirst(
    options,
    (config, request, auth, onToken) =>
      responsesStream(config, request, auth, onToken, options.model),
    probeChat,
    stream,
  );
}

export function resetResponsesWireStatesForTesting(): void {
  resetResponsesPreflight();
}
