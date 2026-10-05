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
import { parseQoderCredential as parseCredential, type QoderCredential } from "./qoder-credential.js";
import { withQoderCredential } from "./qoder-refresh.js";
import { currentSessionAffinity } from "../session-affinity.js";
import { sessionCacheAffinityKey } from "../cache-affinity.js";
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

interface QoderCatalogEntry {
  key: string;
  display_name?: string;
  is_reasoning?: boolean;
  is_vl?: boolean;
  is_free?: boolean;
  price_factor?: number;
  max_input_tokens?: number;
  thinking_config?: {
    enabled?: { efforts?: Record<string, unknown> };
  };
}

export const QODER_FREE_SUFFIX = ":free";

export function isQoderFreeEntry(entry: {
  is_free?: boolean;
  price_factor?: number;
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
  entry: { is_free?: boolean; price_factor?: number },
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

function injectedMachineHeaders(
  credential: QoderCredential,
): Record<string, string> {
  return {
    "Cosy-MachineToken": credential.machineToken,
    ...(credential.machineType
      ? { "Cosy-MachineType": credential.machineType }
      : {}),
    "Cosy-MachineHostname": "kali",
  };
}

function stripTransportHeaders(headers: Record<string, string>): void {
  delete headers["Connection"];
  delete headers["Cache-Control"];
  delete headers["Accept-Encoding"];
  delete headers["Content-Length"];
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
    const headers = {
      ...signed.headers,
      ...injectedMachineHeaders(credential),
    };
    stripTransportHeaders(headers);
    const url = signed.url.startsWith("http")
      ? signed.url
      : `${QODER_OPENAPI_ORIGIN}${signed.url}`;
    const response = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) {
      throw new ProviderError(
        `Qoder model list failed (HTTP ${response.status}).`,
        response.status,
      );
    }
    const payload = (await response.json()) as { chat?: QoderCatalogEntry[] };
    const entries = Array.isArray(payload.chat) ? payload.chat : [];
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

interface QoderStreamDelta {
  content?: string;
  reasoning_content?: string;
  reasoning?: string;
  thinking?: string;
  tool_calls?: Array<{
    index?: number;
    id?: string;
    function?: { name?: string; arguments?: string | Record<string, unknown> };
  }>;
}

/** Qoder keeps the SSE connection open after the last token; bound the wait. */
const STREAM_IDLE_MS = 120_000;

interface IdleGuard {
  race<T>(value: Promise<T>): Promise<T>;
  reset(): void;
  dispose(): void;
}

function createIdleGuard(): IdleGuard {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let rejectExpired: (reason: Error) => void = () => {};
  const expired = new Promise<never>((_, reject) => {
    rejectExpired = reject;
  });
  const arm = () => {
    timer = setTimeout(() => rejectExpired(new Error("qoder stream idle")), STREAM_IDLE_MS);
  };
  arm();
  return {
    race: <T>(value: Promise<T>) => Promise.race([value, expired]),
    reset: () => {
      if (timer) clearTimeout(timer);
      arm();
    },
    dispose: () => {
      if (timer) clearTimeout(timer);
    },
  };
}

function extractWrapperBody(frame: string): string | undefined {
  const line = frame
    .split("\n")
    .map((part) => part.trim())
    .find((part) => part.startsWith("data:"));
  if (!line) return undefined;
  const payload = line.slice(5).trim();
  if (!payload || payload === "[DONE]") return undefined;
  let wrapper: Record<string, unknown>;
  try {
    wrapper = JSON.parse(payload) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  const body = typeof wrapper.body === "string" ? wrapper.body : undefined;
  const status = typeof wrapper.statusCodeValue === "number" ? wrapper.statusCodeValue : 200;
  if (status !== 200) {
    let detail = body ?? payload;
    try {
      const error = JSON.parse(detail) as Record<string, unknown>;
      const message = error.message ?? error.errorMessage ?? error.error;
      if (typeof message === "string") detail = message;
    } catch {
      detail = detail.slice(0, 300);
    }
    throw new ProviderError(`Qoder inference failed (HTTP ${status}): ${detail}`, status, body);
  }
  if (body !== undefined) return body;
  if (wrapper.choices !== undefined) return payload;
  return undefined;
}

async function runQoderStream(
  request: CompletionRequest,
  credential: QoderCredential,
  onToken: (token: string) => void,
  onSemanticOutput: () => void = () => {},
): Promise<CompletionResult> {
  const model = request.model ?? defaultModels.qoder;
  const modelKey = qoderWireModelKey(model);
  const requestId = crypto.randomUUID();
  const requestSetId = crypto.randomUUID();
  const affinity = currentSessionAffinity();
  const sessionKey = affinity ? sessionCacheAffinityKey(affinity).slice(5, 37) : undefined;
  const sessionId = sessionKey
    ? `${sessionKey.slice(0, 8)}-${sessionKey.slice(8, 12)}-5${sessionKey.slice(13, 16)}-8${sessionKey.slice(17, 20)}-${sessionKey.slice(20)}`
    : crypto.randomUUID();
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
  const headers: Record<string, string> = { ...signed.headers, ...injectedMachineHeaders(credential) };
  headers["X-Model-Key"] = modelKey;
  headers["X-Model-Source"] = "system";
  headers["Content-Type"] = "application/json";
  headers["Accept"] = "text/event-stream";
  stripTransportHeaders(headers);
  const response = await fetch(signed.url, {
    method: "POST",
    headers,
    body: signed.body ?? body,
    ...(request.signal ? { signal: request.signal } : {}),
  });
  if (!response.ok || !response.body) {
    throw new ProviderError(
      `Qoder inference failed (HTTP ${response.status}).`,
      response.status,
    );
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let text = "";
  let reasoning = "";
  const toolCallState = new Map<number, OpenAiToolCallAccumulator>();
  let usage: CompletionResult["usage"];
  let finishReason = "stop";
  let finished = false;
  const idle = createIdleGuard();
  try {
    for (;;) {
      let result: ReadableStreamReadResult<Uint8Array>;
      try {
        result = await idle.race(reader.read());
      } catch (error) {
        request.signal?.throwIfAborted();
        throw error;
      }
      if (result.done) break;
      idle.reset();
      buffer += decoder.decode(result.value, { stream: true });
      let boundary = /\r?\n\r?\n/.exec(buffer);
      while (boundary) {
        const frame = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary[0].length);
        if (/^data:\s*\[DONE\]\s*$/m.test(frame)) finished = true;
        const raw = extractWrapperBody(frame);
        if (raw) {
          let chunk: {
            choices?: Array<{ delta?: QoderStreamDelta; finish_reason?: string }>;
            usage?: unknown;
          } | undefined;
          try {
            chunk = JSON.parse(raw);
          } catch {}
          if (chunk) {
            const choice = chunk.choices?.[0];
            const reasoningDelta = openAiReasoningText(choice?.delta);
            if (reasoningDelta) {
              reasoning += reasoningDelta;
              onSemanticOutput();
              emitStreamReasoningDelta(request.onStreamEvent, reasoningDelta);
              if (!request.onStreamEvent) onToken(reasoningDelta);
            }
            if (choice?.delta?.content) {
              text += choice.delta.content;
              onSemanticOutput();
              onToken(choice.delta.content);
            }
            for (const entry of choice?.delta?.tool_calls ?? []) {
              const delta = accumulateOpenAiToolCallDelta(toolCallState, entry);
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
            if (choice?.finish_reason) {
              finishReason = choice.finish_reason;
              finished = true;
            }
            usage = parseOpenAiUsage(chunk.usage) ?? usage;
          }
        }
        boundary = /\r?\n\r?\n/.exec(buffer);
      }
      if (finished) break;
    }
  } finally {
    idle.dispose();
    try {
      await reader.cancel();
    } catch {
      // Stream already released.
    }
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
    return withQoderCredential(
      auth,
      (credential) => runQoderStream(request, credential, () => {}),
      onStatus,
      () => !request.signal?.aborted,
    );
  },
  async stream(
    request: CompletionRequest,
    auth: ProviderAuth,
    onToken: (token: string) => void,
    onStatus?: ((message: string) => void) | undefined,
  ): Promise<CompletionResult> {
    let emittedOutput = false;
    return withQoderCredential(
      auth,
      (credential) => runQoderStream(request, credential, onToken, () => { emittedOutput = true; }),
      onStatus,
      () => !emittedOutput && !request.signal?.aborted,
    );
  },
};

export { readQoderMachineId, readQoderMachineIdentity };
