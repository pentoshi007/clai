import type { CompletionRequest, CompletionResult } from "../../types.js";
import { defaultModels, type LlmProvider, type ProviderAuth } from "../provider.js";
import { ProviderError, ingestModelCatalogEntries } from "../http.js";
import {
  QODER_CLI_VERSION,
  QODER_INFERENCE_ORIGIN,
  QODER_OPENAPI_ORIGIN,
  readQoderMachineId,
  readQoderMachineIdentity,
} from "./qoder-auth.js";
import { QoderSigner } from "./qoder-signer.js";
import { readQoderModelCatalog, type QoderCatalogEntry } from "./qoder-catalog.js";
import { parseQoderCredential as parseCredential, type QoderCredential } from "./qoder-credential.js";
import { withQoderCredential } from "./qoder-refresh.js";
import { qoderTransportHeaders, qoderRequestSignal, readQoderResponseBody, fetchQoderInference } from "./qoder-http.js";
import { withQoderModelQueue, type QoderRequestIdentity } from "./qoder-queue.js";
import { qoderResponseError } from "./qoder-response.js";
import { readQoderStreamChunks } from "./qoder-stream.js";
import { markStreamEmittedBytes } from "../stream-progress.js";
import { emitStreamReasoningArtifacts, emitStreamReasoningDelta } from "../stream-events.js";
import { parseOpenAiUsage, withReasoningObservation } from "../token-usage.js";
import { compatibleReasoningArtifacts, openAiReasoningText } from "../wire/reasoning-artifacts.js";
import { openAiToolBodyFields } from "../adapters/openai-tools.js";
import { toOpenAiMessages } from "../wire/chat-body.js";
import { createReasoningArtifactReplayTarget } from "../reasoning-artifacts.js";
import { buildReasoningPayload } from "../wire/reasoning-payload.js";
import {
  accumulateOpenAiToolCallDelta,
  finalizeOpenAiToolCalls,
  fromWireName,
  type OpenAiToolCallAccumulator,
} from "../tool-protocol.js";
export { encodeQoderCredential, qoderCredentialFromImport, type QoderCredential } from "./qoder-credential.js";

export const QODER_FREE_SUFFIX = ":free";

export function isQoderFreeEntry(entry: {
  is_free?: boolean | undefined;
  price_factor?: number | undefined;
}): boolean {
  if (entry.is_free === true) return true;
  return typeof entry.price_factor === "number" && entry.price_factor === 0;
}

/**
 * Model ids carry a price tag so `/model` shows the multiplier qodercli shows:
 * `key:free` for a 0.00 multiplier, `key:0.5x` for a paid multiplier. The tag is
 * display-only and stripped before the wire call (see {@link qoderWireModelKey}).
 */
export function qoderListedModel(
  key: string,
  entry: { is_free?: boolean | undefined; price_factor?: number | undefined },
): string {
  if (isQoderFreeEntry(entry)) return `${key}${QODER_FREE_SUFFIX}`;
  const factor = entry.price_factor;
  return typeof factor === "number" && Number.isFinite(factor)
    ? `${key}:${factor}x`
    : key;
}

const QODER_PRICE_TAG_RE = /:(?:free|\d+(?:\.\d+)?x)$/;

export function qoderWireModelKey(model: string): string {
  return model.replace(QODER_PRICE_TAG_RE, "");
}

function catalogFactsFromQoder(
  entry: QoderCatalogEntry,
  listedId: string,
): Record<string, unknown> {
  const efforts = entry.thinking_config?.enabled?.efforts;
  const supportedEfforts = efforts ? Object.keys(efforts) : undefined;
  return {
    id: listedId,
    name: entry.display_name ?? entry.key,
    reasoning: {
      supported: entry.is_reasoning === true,
      ...(supportedEfforts && supportedEfforts.length > 0
        ? { supported_efforts: supportedEfforts }
        : {}),
    },
    vision: entry.is_vl === true,
    ...(typeof entry.max_input_tokens === "number"
      ? { contextTokens: entry.max_input_tokens }
      : {}),
  };
}

function messageText(message: { content: string }): string {
  return message.content;
}

function qoderChatView(text: string, modelKey: string, reasoning: boolean) {
  return {
    text,
    features: [],
    extra: {
      context: [],
      modelConfig: { key: modelKey, is_reasoning: reasoning },
      originalContent: text,
    },
    chatPrompt: "",
    imageUrls: null,
  };
}

let cachedModels: string[] | null = null;
let lastFetchTime = 0;
const CACHE_TTL_MS = 30 * 60 * 1000;

async function fetchQoderModels(credential: QoderCredential): Promise<string[]> {
  const signer = await QoderSigner.create({
    machineId: credential.machineId,
    cosyVersion: QODER_CLI_VERSION,
    userInfo: credential,
  });
  try {
    const signed = signer.prepare({
      endpoint: QODER_OPENAPI_ORIGIN,
      path: "/api/v2/model/list?Encode=1",
      method: "GET",
      authType: "auth",
      headers: { Accept: "application/json", "Accept-Encoding": "identity" },
    });
    const headers = qoderTransportHeaders(credential, signed.headers);
    const url = signed.url.startsWith("http")
      ? signed.url
      : `${QODER_OPENAPI_ORIGIN}${signed.url}`;
    const signal = qoderRequestSignal(undefined, 20_000);
    const response = await fetch(url, { headers, signal });
    const entries = await readQoderModelCatalog(response, signal);
    return ingestModelCatalogEntries(
      "qoder",
      entries.map((entry) =>
        catalogFactsFromQoder(entry, qoderListedModel(entry.key, entry)),
      ),
    );
  } finally {
    signer.free();
  }
}

async function runQoderStream(
  request: CompletionRequest,
  credential: QoderCredential,
  identity: QoderRequestIdentity,
  onToken: (token: string) => void,
  onSemanticOutput: () => void,
): Promise<CompletionResult> {
  const model = request.model ?? defaultModels.qoder;
  const modelKey = qoderWireModelKey(model);
  const { requestId, requestSetId, sessionId } = identity;
  const reasoningControls = buildReasoningPayload(request.thinking, "qoder");
  const reasoningEnabled = reasoningControls.enable_thinking !== false;
  const { tools, ...toolParameters } = openAiToolBodyFields(request);
  const lastUser = [...request.messages]
    .reverse()
    .find((message) => message.role === "user");
  const userText = lastUser ? messageText(lastUser) : "";
  const body = JSON.stringify({
    request_id: requestId,
    request_set_id: requestSetId,
    chat_record_id: requestId,
    session_id: sessionId,
    stream: true,
    chat_task: "FREE_INPUT",
    chat_context: qoderChatView(userText, modelKey, reasoningEnabled),
    is_reply: true,
    is_retry: false,
    source: 1,
    version: "3",
    agent_id: "agent_common",
    task_id: "common",
    session_type: "qodercli",
    aliyun_user_type: "",
    model_config: {
      key: modelKey,
      display_name: modelKey,
      model: "",
      format: "openai",
      is_vl: true,
      is_reasoning: reasoningEnabled,
      api_key: "",
      url: "",
      source: "system",
      max_input_tokens: 180000,
    },
    system: request.messages.filter((message) => message.role === "system")
      .map((message) => ({ type: "text", text: message.content })),
    messages: toOpenAiMessages(request.messages, true, {
      target: createReasoningArtifactReplayTarget({ provider: "qoder", model, endpoint: QODER_INFERENCE_ORIGIN, dialect: "openai-compatible" }),
      observe: request.onReasoningArtifactReplayDecision,
      forceScope: request.forceReasoningReplay,
    }),
    tools: tools ?? [],
    parameters: {
      max_tokens: request.maxTokens ?? 4096,
      ...reasoningControls,
      ...toolParameters,
    },
    business: {
      product: "cli",
      version: QODER_CLI_VERSION,
      type: "agent",
      id: requestSetId,
      name: userText.slice(0, 20) || "chat",
      begin_at: Date.now(),
      stage: "start",
    },
});
  const signer = await QoderSigner.create({
    machineId: credential.machineId,
    cosyVersion: QODER_CLI_VERSION,
    userInfo: credential,
  });
  let signed;
  try {
    signed = signer.prepareInfer({
      baseUrl: QODER_INFERENCE_ORIGIN,
      body,
      modelKey,
      modelSource: "system",
    });
  } finally {
    signer.free();
  }
  const headers = qoderTransportHeaders(credential, signed.headers);
  headers["X-Model-Key"] = modelKey;
  headers["X-Model-Source"] = "system";
  headers["Content-Type"] = "application/json";
  headers["Accept"] = "text/event-stream";
  request.signal?.throwIfAborted();
  const response = await fetchQoderInference(signed.url, {
    method: "POST",
    headers,
    body: signed.body ?? body,
    ...(request.signal ? { signal: request.signal } : {}),
  });
  if (!response.ok) {
    const signal = qoderRequestSignal(request.signal);
    throw qoderResponseError(response.status, await readQoderResponseBody(response, signal));
  }
  if (!response.body) throw new ProviderError("Qoder returned an empty response.", 502);
  let text = "";
  let reasoning = "";
  const toolCallState = new Map<number, OpenAiToolCallAccumulator>();
  let usage: CompletionResult["usage"];
  let finishReason = "stop";
  let progress = 0;
  for await (const chunk of readQoderStreamChunks(response, reasoningEnabled, () => progress, request.signal)) {
    const choice = chunk.choices?.[0];
    const reasoningDelta = openAiReasoningText(choice?.delta);
    if (reasoningDelta) {
      reasoning += reasoningDelta;
      progress++;
      onSemanticOutput();
      emitStreamReasoningDelta(request.onStreamEvent, reasoningDelta);
      if (!request.onStreamEvent) onToken(reasoningDelta);
    }
    if (choice?.delta?.content) {
      text += choice.delta.content;
      progress++;
      onSemanticOutput();
      onToken(choice.delta.content);
    }
    for (const entry of choice?.delta?.tool_calls ?? []) {
      const delta = accumulateOpenAiToolCallDelta(toolCallState, entry);
      progress++;
      onSemanticOutput();
      const largeArgumentTick = !delta.nameBecameKnown && delta.argumentsBytes > 0 &&
        delta.argumentsBytes % 4096 < (typeof entry.function?.arguments === "string" ? entry.function.arguments.length : 0);
      if (delta.nameBecameKnown || largeArgumentTick) {
        request.onToolCallDelta?.({
          index: delta.index,
          ...(delta.id ? { id: delta.id } : {}),
          ...(delta.name ? { name: fromWireName(delta.name) ?? delta.name } : {}),
          argumentsBytes: delta.argumentsBytes,
        });
      }
    }
    usage = parseOpenAiUsage(chunk.usage) ?? usage;
    if (choice?.finish_reason) finishReason = choice.finish_reason;
  }
  const toolCalls = finalizeOpenAiToolCalls(toolCallState);
  const reasoningArtifacts = compatibleReasoningArtifacts({
    providerId: "qoder", model, baseUrl: QODER_INFERENCE_ORIGIN, toolCalls,
    ...(reasoning ? { reasoning: { text: reasoning, sequence: 0 } } : {}),
  });
  emitStreamReasoningArtifacts(request.onStreamEvent, reasoningArtifacts);
  return {
    text,
    model,
    provider: "qoder",
    api: "chat-completions",
    toolCalls,
    finishReason,
    ...(reasoning ? { reasoningBlock: { text: reasoning } } : {}),
    ...(reasoningArtifacts ? { reasoningArtifacts } : {}),
    ...(usage ? { usage: withReasoningObservation(usage, reasoning.length > 0) } : {}),
  };
}

async function executeQoderRequest(
  request: CompletionRequest,
  auth: ProviderAuth,
  onToken: (token: string) => void,
  onStatus?: (message: string) => void,
): Promise<CompletionResult> {
  let emittedOutput = 0;
  try {
    return await withQoderModelQueue({
      auth,
      modelKey: qoderWireModelKey(request.model ?? defaultModels.qoder),
      signal: request.signal,
      onStatus,
      canRetry: () => emittedOutput === 0 && !request.signal?.aborted,
      run: (credential, identity) => runQoderStream(request, credential, identity, onToken, () => { emittedOutput++; }),
    });
  } catch (error) {
    throw markStreamEmittedBytes(error, emittedOutput);
  }
}

export const qoderProvider: LlmProvider = {
  id: "qoder",
  displayName: "Qoder",
  reasoningStyle: "qoder",
  defaultModel: defaultModels.qoder,
  envVar: "QODER_API_KEY",
  validateKey: (key: string) => {
    try {
      parseCredential(key);
      return true;
    } catch {
      return false;
    }
  },
  async listModels(auth: ProviderAuth): Promise<string[]> {
    return withQoderCredential(auth, async (credential) => {
      const now = Date.now();
      if (cachedModels && now - lastFetchTime < CACHE_TTL_MS) return cachedModels;
      const models = await fetchQoderModels(credential);
      if (models.length > 0) {
        cachedModels = models;
        lastFetchTime = now;
      }
      return models;
    });
  },
  async ping(auth: ProviderAuth): Promise<void> {
    await withQoderCredential(auth, async (credential) => {
      await fetchQoderModels(credential);
    });
  },
  async complete(
    request: CompletionRequest,
    auth: ProviderAuth,
    onStatus?: ((message: string) => void) | undefined,
  ): Promise<CompletionResult> {
    return executeQoderRequest(request, auth, () => {}, onStatus);
  },
  async stream(
    request: CompletionRequest,
    auth: ProviderAuth,
    onToken: (token: string) => void,
    onStatus?: ((message: string) => void) | undefined,
  ): Promise<CompletionResult> {
    return executeQoderRequest(request, auth, onToken, onStatus);
  },
};

export { readQoderMachineId, readQoderMachineIdentity };
