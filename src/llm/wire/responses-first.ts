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
  PROBE_UNRELIABLE_STATUS,
  providerStatusCode,
  type ExtrasLevel,
} from "./responses-failure.js";
import { cacheAffinityKey } from "../cache-affinity.js";
import { responsesComplete } from "../responses-complete.js";
import { responsesStream } from "../responses-stream.js";
import {
  mapResponsesEffort,
  responsesReasoningSummary,
  type ResponsesAccept,
  type ResponsesBodyExtrasContext,
  type ResponsesDialectConfig,
} from "../responses-config.js";
import { PRIVATE_REASONING_NOTE_PREFIX } from "../responses-http.js";
import { isChatShapedResponsesPayload } from "../responses-shape.js";
import { assertResponsesShapedData } from "../responses-shape.js";
import { isPartialStreamError } from "../stream-terminal.js";
import {
  recordGenerationAttemptOutcome,
  withUnrecordedTransport,
} from "../operation-usage.js";
import { emitTransportEvent, type TransportEvent } from "../transport-events.js";
import type { ProviderAuth } from "../provider.js";
import type { OpenAiCompatibleResult } from "./reasoning-artifacts.js";
import type { ProviderStreamEventSink } from "../stream-events.js";

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

type ThinkingWire = "unknown" | "responses" | "chat";

interface ResponsesWireState {
  endpoint: "unknown" | "available" | "unsupported";
  extras: ExtrasLevel;
  thinkingWire: ThinkingWire;
}

const wireStates = new Map<string, ResponsesWireState>();

function wireState(providerId: ProviderId, model: string): ResponsesWireState {
  const key = `${providerId}:${model.trim().toLowerCase()}`;
  let state = wireStates.get(key);
  if (!state) {
    state = { endpoint: "unknown", extras: "full", thinkingWire: "unknown" };
    wireStates.set(key, state);
  }
  return state;
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
      if (extras === "bare") return {};
      return {
        store: false,
        include: ["reasoning.encrypted_content"],
        prompt_cache_key: `${context.purpose === "auxiliary" ? "aux-" : ""}${cacheAffinityKey(providerId, context.model, context.messages)}`,
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

function bridgeCompletionRequest(
  options: ResponsesFirstOptions,
  _extras: ExtrasLevel,
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

function hasVisibleReasoning(
  result: OpenAiCompatibleResult,
  reasoningDeltas: number,
): boolean {
  if (reasoningDeltas > 0) return true;
  if (result.reasoningArtifacts?.length) return true;
  const text = result.reasoningBlock?.text ?? "";
  return text.length > 0 && !text.startsWith(PRIVATE_REASONING_NOTE_PREFIX);
}

class ReasoningAbsentOnResponsesSignal extends Error {
  constructor() {
    super("Responses stream produced no visible reasoning before output");
    this.name = "ReasoningAbsentOnResponsesSignal";
  }
}

async function runResponsesFirst(
  options: ResponsesFirstOptions,
  run: ResponsesRunner,
  stream?: StreamBridgeOptions,
): Promise<OpenAiCompatibleResult | undefined> {
  if (!responsesFirstCandidate(options.providerId)) return undefined;
  const state = wireState(options.providerId, options.model);
  if (state.endpoint === "unsupported") return undefined;
  const thinkingRequested = options.reasoning?.enabled === true;
  if (thinkingRequested && state.thinkingWire === "chat") return undefined;
  const probing = state.endpoint === "unknown";

  const reasoningDeltas = { count: 0 };
  const emittedVisible = { count: 0 };
  const shouldEarlyCheck =
    thinkingRequested && stream !== undefined && state.thinkingWire === "unknown";
  const countingStream: StreamBridgeOptions | undefined = stream
    ? {
        onToken: (token) => {
          if (
            shouldEarlyCheck &&
            reasoningDeltas.count === 0 &&
            emittedVisible.count === 0
          ) {
            throw new ReasoningAbsentOnResponsesSignal();
          }
          emittedVisible.count += 1;
          stream.onToken(token);
        },
        ...(stream.onToolCallDelta
          ? {
              onToolCallDelta: (delta) => {
                if (
                  shouldEarlyCheck &&
                  reasoningDeltas.count === 0 &&
                  emittedVisible.count === 0
                ) {
                  throw new ReasoningAbsentOnResponsesSignal();
                }
                stream.onToolCallDelta!(delta);
              },
            }
          : {}),
        onStreamEvent: (event) => {
          if (
            event.type === "reasoning_delta" &&
            !event.text.startsWith(PRIVATE_REASONING_NOTE_PREFIX)
          ) {
            reasoningDeltas.count += 1;
          }
          stream.onStreamEvent?.(event);
        },
      }
    : undefined;

  const attempt = async (extras: ExtrasLevel): Promise<OpenAiCompatibleResult> => {
    const config = genericResponsesConfig(
      options.providerId,
      options.provider,
      options.baseUrl,
      options.headers,
      extras,
    );
    const request = bridgeCompletionRequest(options, extras, countingStream);
    const auth: ProviderAuth = { apiKey: options.apiKey };
    const wrappedOnToken = countingStream?.onToken ?? (() => {});
    return compatibleFromCompletion(await run(config, request, auth, wrappedOnToken));
  };

  const fallback = (event: TransportEvent): undefined => {
    state.endpoint = "unsupported";
    emitTransportEvent(event);
    return undefined;
  };

  const rememberChatThinkingWire = (): void => {
    state.thinkingWire = "chat";
    state.endpoint = "available";
    emitTransportEvent({
      kind: "responses-fallback-reasoning",
      provider: options.provider,
      model: options.model,
    });
  };

  let result: OpenAiCompatibleResult;
  try {
    result = await withUnrecordedTransport(() => attempt(state.extras));
  } catch (error) {
    if (error instanceof ReasoningAbsentOnResponsesSignal) {
      rememberChatThinkingWire();
      return undefined;
    }
    if (isChatShapedResponsesPayload(error)) {
      return fallback({
        kind: "responses-fallback-shape",
        provider: options.provider,
        model: options.model,
      });
    }
    if (
      probing &&
      isPartialStreamError(error) &&
      error.answerBytes === 0 &&
      error.reasoningBytes === 0 &&
      error.toolArgumentBytes === 0
    ) {
      return fallback({
        kind: "responses-fallback-shape",
        provider: options.provider,
        model: options.model,
      });
    }
    const status = providerStatusCode(error);
    if (status !== undefined && PROBE_UNRELIABLE_STATUS.has(status)) {
      return fallback({
        kind: "responses-fallback-error",
        provider: options.provider,
        model: options.model,
        detail: `HTTP ${status}`,
      });
    }
    const verdict = classifyResponsesFailure(error, state.extras);
    if (verdict === "unsupported-extras") {
      const text = failureText(error);
      const isReasoningRejection = /reasoning/i.test(text);
      if (thinkingRequested && isReasoningRejection) {
        rememberChatThinkingWire();
        return undefined;
      }
      state.extras = "bare";
      emitTransportEvent({
        kind: "responses-downgrade-extras",
        provider: options.provider,
        model: options.model,
      });
      try {
        result = await withUnrecordedTransport(() => attempt("bare"));
      } catch (retryError) {
        if (retryError instanceof ReasoningAbsentOnResponsesSignal) {
          rememberChatThinkingWire();
          return undefined;
        }
        const retryText = failureText(retryError);
        if (thinkingRequested && /reasoning/i.test(retryText) && classifyResponsesFailure(retryError, "bare") !== "other") {
          rememberChatThinkingWire();
          return undefined;
        }
        if (
          classifyResponsesFailure(retryError, "bare") ===
          "unsupported-endpoint"
        ) {
          return fallback({
            kind: "responses-fallback-endpoint",
            provider: options.provider,
            model: options.model,
          });
        }
        if (
          probing &&
          isGenericModelRejection(providerStatusCode(retryError), retryText)
        ) {
          return fallback({
            kind: "responses-fallback-error",
            provider: options.provider,
            model: options.model,
            detail: "HTTP 400",
          });
        }
        recordRethrownFailure(retryError, options.signal);
        throw retryError;
      }
    } else if (verdict === "unsupported-endpoint") {
      return fallback({
        kind: "responses-fallback-endpoint",
        provider: options.provider,
        model: options.model,
      });
    } else if (
      probing &&
      isGenericModelRejection(providerStatusCode(error), failureText(error))
    ) {
      return fallback({
        kind: "responses-fallback-error",
        provider: options.provider,
        model: options.model,
        detail: "HTTP 400",
      });
    } else {
      recordRethrownFailure(error, options.signal);
      throw error;
    }
  }

  state.endpoint = "available";
  recordGenerationAttemptOutcome("success", result.usage);

  if (thinkingRequested && !hasVisibleReasoning(result, reasoningDeltas.count)) {
    if (stream !== undefined && emittedVisible.count > 0) {
      state.thinkingWire = "chat";
      return result;
    }
    state.thinkingWire = "chat";
    emitTransportEvent({
      kind: "responses-fallback-reasoning",
      provider: options.provider,
      model: options.model,
    });
    return undefined;
  }
  if (thinkingRequested) state.thinkingWire = "responses";
  return result;
}

function recordRethrownFailure(
  error: unknown,
  signal: AbortSignal | undefined,
): void {
  recordGenerationAttemptOutcome(
    signal?.aborted ? "cancelled" : "failure",
    undefined,
    providerStatusCode(error),
  );
}

export async function openAiCompatibleCompleteViaResponses(
  options: ResponsesFirstOptions,
): Promise<OpenAiCompatibleResult | undefined> {
  return runResponsesFirst(
    options,
    (config, request, auth, _onToken) =>
      responsesComplete(config, request, auth, options.model, assertResponsesShapedData),
  );
}

export async function openAiCompatibleStreamViaResponses(
  options: ResponsesFirstOptions,
  stream: StreamBridgeOptions,
): Promise<OpenAiCompatibleResult | undefined> {
  return runResponsesFirst(
    options,
    (config, request, auth, onToken) =>
      responsesStream(config, request, auth, onToken, options.model),
    stream,
  );
}

export function resetResponsesWireStatesForTesting(): void {
  wireStates.clear();
}
