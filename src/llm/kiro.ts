import { createHash } from "node:crypto";
import type {
  CompletionRequest,
  CompletionResult,
  ReasoningEffort,
  TokenUsage,
} from "../types.js";
import {
  defaultModels,
  type LlmProvider,
  type ProviderAuth,
} from "./provider.js";
import { ProviderError } from "./http.js";
import {
  decodeKiroKey,
  discoverKiroModelsDetailed,
  encodeKiroKey,
  getKiroUsageLimits,
  isKiroOAuthToken,
  KiroRefreshError,
  kiroCredentialNeedsRefresh,
  maybeRefreshKiroCredential,
  resolveKiroRuntimeRegion,
  type KiroApiGeneration,
  type KiroCredential,
  type KiroModelInfo,
  type KiroUsageLimits,
} from "./kiro-auth.js";
import { currentSessionAffinity } from "./session-affinity.js";
import { nearestAcceptedEffort } from "./reasoning-controls.js";
import {
  completeGenerationAttempt,
  generationFetch,
  withUnrecordedTransport,
} from "./operation-usage.js";
import { learnModelVisionCapability } from "./capability/vision-registry.js";
import { emitStreamReasoningDelta } from "./stream-events.js";
import { createReasoningArtifactProvenance } from "./reasoning-artifacts.js";
import {
  kiroPrivateReasoningNote,
  kiroCatalogEfforts,
  kiroReasoningResult,
  sentKiroReasoningEffort,
} from "./kiro-reasoning.js";
import {
  buildKiroConversationState,
  buildKiroCreateResponseBody,
  formatKiroTools,
  kiroCliUserAgent,
  kiroConversationId,
  kiroCreateResponseHeaders,
  kiroLegacyHeaders,
  normalizeKiroTurns,
  KIRO_AGENT_MODE,
  KIRO_MODE_IDENTIFIER,
} from "./kiro-wire.js";
import { parseKiroCreateResponseSse } from "./kiro-sse.js";
import { createKiroStreamAccumulator } from "./kiro-stream.js";
import {
  registerModelCatalogLimits,
  registerModelReasoningEfforts,
} from "./capabilities.js";
import type { CatalogFacts } from "./catalog-facts.js";
import { modelContextWindow } from "./context-windows.js";
import {
  providerRatioPromptTokens,
  providerRatioUsage,
} from "./provider-context-usage.js";
import { inBandBadRequestStatus } from "./reasoning-errors.js";
import { replaceProviderKey } from "../store/keys.js";
import { fallbackModelList, isModelListFresh, MODEL_LIST_TTL_MS, onModelListInvalidated } from "./model-list-cache.js";

const KIRO_FALLBACK_BASE_MODELS: readonly string[] = [
  "auto",
  "claude-sonnet-4.5",
  "claude-sonnet-4",
  "claude-haiku-4.5",
  "deepseek-3.2",
  "minimax-m2.5",
  "minimax-m2.1",
  "glm-5",
  "qwen3-coder-next",
];

function withKiroVariants(baseIds: readonly string[]): string[] {
  const variants: string[] = [];
  for (const id of baseIds) {
    variants.push(id);
    if (id === "auto") continue;
    variants.push(`${id}-thinking`);
    variants.push(`${id}-agentic`);
    variants.push(`${id}-thinking-agentic`);
  }
  return variants;
}

export const kiroFallbackModels: readonly string[] = withKiroVariants(
  KIRO_FALLBACK_BASE_MODELS,
);

const CRC32_TABLE = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let j = 0; j < 8; j++) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  CRC32_TABLE[i] = c >>> 0;
}

const KIRO_EVENTSTREAM_MAX_MESSAGE_BYTES = 24 * 1024 * 1024;
const KIRO_EVENTSTREAM_MAX_HEADERS_BYTES = 128 * 1024;

function crc32(buf: Buffer | Uint8Array, start = 0, end = buf.length): number {
  let crc = 0xffffffff;
  for (let i = start; i < end; i++) {
    crc = (crc >>> 8) ^ CRC32_TABLE[(crc ^ buf[i]!) & 0xff]!;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function parseHeaders(buf: Buffer): Record<string, unknown> {
  const headers: Record<string, unknown> = {};
  const names = new Set<string>();
  let offset = 0;
  const requireBytes = (count: number): void => {
    if (offset + count > buf.length) {
      throw new ProviderError("Kiro event-stream header exceeds its declared bounds", 502);
    }
  };

  while (offset < buf.length) {
    requireBytes(1);
    const nameLen = buf.readUInt8(offset);
    offset += 1;
    requireBytes(nameLen + 1);
    const name = buf.toString("utf8", offset, offset + nameLen);
    offset += nameLen;
    if (names.has(name)) {
      throw new ProviderError(`Duplicate Kiro event-stream header: ${name}`, 502);
    }
    names.add(name);
    const type = buf.readUInt8(offset);
    offset += 1;

    if (type === 0 || type === 1) {
      headers[name] = type === 0;
      continue;
    }
    if (type === 2) {
      requireBytes(1);
      headers[name] = buf.readInt8(offset);
      offset += 1;
      continue;
    }
    if (type === 3) {
      requireBytes(2);
      headers[name] = buf.readInt16BE(offset);
      offset += 2;
      continue;
    }
    if (type === 4) {
      requireBytes(4);
      headers[name] = buf.readInt32BE(offset);
      offset += 4;
      continue;
    }
    if (type === 5 || type === 8) {
      requireBytes(8);
      const value = buf.readBigInt64BE(offset);
      headers[name] = type === 5 ? value : new Date(Number(value));
      offset += 8;
      continue;
    }
    if (type === 6 || type === 7) {
      requireBytes(2);
      const len = buf.readUInt16BE(offset);
      offset += 2;
      requireBytes(len);
      headers[name] = type === 7
        ? buf.toString("utf8", offset, offset + len)
        : buf.subarray(offset, offset + len);
      offset += len;
      continue;
    }
    if (type === 9) {
      requireBytes(16);
      headers[name] = buf.subarray(offset, offset + 16).toString("hex");
      offset += 16;
      continue;
    }
    throw new ProviderError(`Unknown Kiro event-stream header type ${type}`, 502);
  }
  return headers;
}

interface EventStreamFrame {
  headers: Record<string, unknown>;
  payload: Record<string, unknown>;
}

async function* parseEventStream(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<EventStreamFrame> {
  const reader = stream.getReader();
  let buffer = Buffer.alloc(0);

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        buffer = Buffer.concat([buffer, Buffer.from(value)]);
      }

      while (buffer.length >= 12) {
        const totalLength = buffer.readUInt32BE(0);
        if (totalLength < 16) {
          throw new ProviderError("Invalid Kiro event-stream frame length", 502);
        }
        if (totalLength > KIRO_EVENTSTREAM_MAX_MESSAGE_BYTES) {
          throw new ProviderError(
            `Kiro event-stream frame length exceeds the ${KIRO_EVENTSTREAM_MAX_MESSAGE_BYTES}-byte protocol bound`,
            502,
          );
        }

        const headersLength = buffer.readUInt32BE(4);
        if (
          headersLength > KIRO_EVENTSTREAM_MAX_HEADERS_BYTES ||
          headersLength > totalLength - 16
        ) {
          throw new ProviderError("Invalid Kiro event-stream header length", 502);
        }
        const preludeCrc = buffer.readUInt32BE(8);
        const expectedPreludeCrc = crc32(buffer, 0, 8);

        if (preludeCrc !== expectedPreludeCrc) {
          throw new ProviderError("Kiro event-stream prelude checksum failed", 502);
        }

        if (buffer.length < totalLength) {
          break;
        }

        const messageCrc = buffer.readUInt32BE(totalLength - 4);
        const expectedMessageCrc = crc32(buffer, 0, totalLength - 4);
        if (messageCrc !== expectedMessageCrc) {
          throw new ProviderError("Kiro event-stream message checksum failed", 502);
        }

        const headersBuffer = buffer.subarray(12, 12 + headersLength);
        const payloadBuffer = buffer.subarray(12 + headersLength, totalLength - 4);
        buffer = buffer.subarray(totalLength);

        const headers = parseHeaders(headersBuffer);
        let payload: Record<string, unknown> = {};
        if (payloadBuffer.length > 0) {
          try {
            const decoded: unknown = JSON.parse(payloadBuffer.toString("utf8"));
            if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) {
              throw new Error("payload is not an object");
            }
            payload = decoded as Record<string, unknown>;
          } catch (error) {
            const detail = error instanceof Error ? `: ${error.message}` : "";
            throw new ProviderError(`Invalid Kiro event-stream JSON payload${detail}`, 502);
          }
        }

        yield { headers, payload };
      }
    }
    if (buffer.length > 0) {
      throw new ProviderError("Kiro event stream ended with a partial frame", 502);
    }
  } catch (error) {
    await reader.cancel(error).catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
}

export function isThinkingModel(model: string): boolean {
  return model.endsWith("-thinking") || model.includes("-thinking-");
}

export function isAgenticModel(model: string): boolean {
  return model.endsWith("-agentic");
}

const KIRO_UPSTREAM_MODEL_PATTERN =
  /^(claude|gpt|o\d|amazon|nova|titan|deepseek|meta|mistral|qwen|minimax|glm|kimi|llama)/i;

export function resolveKiroModel(model: string): {
  upstream: string;
  agentic: boolean;
  thinking: boolean;
} {
  let upstream = model.trim();
  let agentic = false;
  let thinking = false;

  if (upstream.endsWith("-agentic")) {
    agentic = true;
    upstream = upstream.slice(0, -"-agentic".length);
  }
  if (upstream.endsWith("-thinking")) {
    thinking = true;
    upstream = upstream.slice(0, -"-thinking".length);
  }

  if (!KIRO_UPSTREAM_MODEL_PATTERN.test(upstream)) {
    upstream = defaultModels.kiro;
  }

  return { upstream, agentic, thinking };
}

function isLegacyThinkingDirectiveModel(model: string): boolean {
  return /^claude-(?:opus-4\.5|sonnet-4(?:\.5)?|haiku-4\.5)$/i.test(model);
}

function kiroEffortString(effort: ReasoningEffort | undefined): string {
  if (!effort || effort === "none") return "";
  if (effort === "minimal") return "low";
  if (effort === "low") return "low";
  if (effort === "medium") return "medium";
  if (effort === "high") return "high";
  if (effort === "xhigh") return "xhigh";
  return "max";
}

function asKiroRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

type KiroStopDisposition =
  | "complete"
  | "tool_calls"
  | "length"
  | "retryable"
  | "blocked"
  | "incomplete"
  | "unknown";

function normalizeKiroStopReason(value: unknown): string {
  const reason = typeof value === "string" ? value.trim() : "";
  const normalized = reason
    .replace(/([a-z])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
  if (["endturn", "end_turn", "stop", "stop_sequence", "completed"].includes(normalized)) {
    return "end_turn";
  }
  if (["tooluse", "tool_use", "tool_calls"].includes(normalized)) return "tool_use";
  if (["maxtokens", "max_tokens", "max_output_tokens", "length"].includes(normalized)) {
    return "max_tokens";
  }
  return normalized;
}

function kiroStopDisposition(reason: string, hasToolCalls: boolean): KiroStopDisposition {
  if (["malformed_model_output", "invalid_model_output"].includes(reason)) return "retryable";
  if (reason === "refusal" || /(?:content.*filter|guardrail|safety|policy|blocked)/u.test(reason)) {
    return "blocked";
  }
  if (["cancelled", "pause_turn"].includes(reason)) return "incomplete";
  if (["max_tokens", "model_context_window_exceeded"].includes(reason)) {
    return hasToolCalls ? "incomplete" : "length";
  }
  if (hasToolCalls || reason === "tool_use") return "tool_calls";
  if (!reason || reason === "end_turn") return "complete";
  return "unknown";
}

function mergeKiroStopReason(current: string, incoming: string): string {
  if (!incoming) return current;
  if (!current) return incoming;
  const severity = (reason: string): number => {
    const disposition = kiroStopDisposition(reason, false);
    if (disposition === "blocked") return 6;
    if (disposition === "incomplete" || disposition === "unknown") return 5;
    if (disposition === "retryable") return 4;
    if (disposition === "length") return 3;
    if (disposition === "tool_calls") return 2;
    return 1;
  };
  return severity(incoming) > severity(current) ? incoming : current;
}

function firstKiroMetric(
  sources: readonly Record<string, unknown>[],
  names: readonly string[],
): number | undefined {
  for (const source of sources) {
    for (const name of names) {
      const value = source[name];
      if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
        return value;
      }
    }
  }
  return undefined;
}

function schemaEnum(schema: Record<string, unknown> | undefined): string[] {
  return Array.isArray(schema?.enum)
    ? schema.enum.filter((value): value is string => typeof value === "string")
    : [];
}

function schemaProperty(
  schema: Record<string, unknown> | undefined,
  name: string,
): Record<string, unknown> | undefined {
  return asKiroRecord(asKiroRecord(schema?.properties)?.[name]);
}

function supportedEffort(
  requested: ReasoningEffort,
  schema: Record<string, unknown> | undefined,
): string | undefined {
  const efforts = schemaEnum(schema);
  if (efforts.length === 0) return undefined;
  const normalized = requested === "minimal" ? "low" : requested;
  return nearestAcceptedEffort(normalized, efforts);
}

function schemaEffortFields(
  schema: Record<string, unknown> | undefined,
): {
  key: "output_config" | "reasoning";
  schema: Record<string, unknown>;
} | undefined {
  const output = schemaProperty(schema, "output_config");
  const outputEffort = schemaProperty(output, "effort");
  if (outputEffort) return { key: "output_config", schema: outputEffort };
  const reasoning = schemaProperty(schema, "reasoning");
  const reasoningEffort = schemaProperty(reasoning, "effort");
  return reasoningEffort
    ? { key: "reasoning", schema: reasoningEffort }
    : undefined;
}

function kiroAdditionalModelFields(
  request: CompletionRequest,
  info: KiroModelInfo | undefined,
  wantsThinking: boolean,
): Record<string, unknown> | undefined {
  const schema = info?.additionalModelRequestFieldsSchema as Record<string, unknown> | undefined;
  const thinkingSchema = schemaProperty(schema, "thinking");
  const effortFields = schemaEffortFields(schema);
  if (!wantsThinking && !request.thinking) return undefined;
  const requestedEffort: ReasoningEffort = wantsThinking
    ? request.thinking?.effort ?? "high"
    : "none";

  if (!thinkingSchema && !effortFields) return undefined;

  const fields: Record<string, unknown> = {};
  if (thinkingSchema) {
    const types = schemaEnum(schemaProperty(thinkingSchema, "type"));
    if (!wantsThinking && types.includes("disabled")) {
      return { thinking: { type: "disabled" } };
    }
    if (types.includes("adaptive")) {
      fields.thinking = { type: "adaptive", display: "summarized" };
    } else if (wantsThinking) {
      return undefined;
    }
  }

  if (effortFields) {
    const effort = supportedEffort(requestedEffort, effortFields.schema);
    if (effort) fields[effortFields.key] = { effort };
  }

  const maxTokensSchema = schemaProperty(schema, "max_tokens");
  if (wantsThinking && request.maxTokens && maxTokensSchema) {
    const minimum =
      typeof maxTokensSchema.minimum === "number" ? maxTokensSchema.minimum : 1;
    const maximum =
      typeof maxTokensSchema.maximum === "number"
        ? maxTokensSchema.maximum
        : info?.maxOutputTokens ?? request.maxTokens;
    fields.max_tokens = Math.min(
      maximum,
      Math.max(minimum, request.maxTokens),
    );
  }

  return Object.keys(fields).length > 0 ? fields : undefined;
}

function legacyThinkingDirective(effort: ReasoningEffort | undefined): string {
  const budget = KIRO_THINKING_BUDGET[kiroEffortString(effort) || "high"] ?? 16000;
  return `<thinking_mode>enabled</thinking_mode><max_thinking_length>${budget}</max_thinking_length>`;
}

const KIRO_THINKING_BUDGET: Record<string, number> = {
  low: 4000,
  medium: 8000,
  high: 16000,
  xhigh: 32000,
  max: 64000,
};

function resolveKiroCredential(auth: ProviderAuth): KiroCredential {
  const raw = auth.apiKey?.trim();
  if (!raw) {
    throw new Error(
      "Kiro AI authentication required. Run `clai auth kiro` to sign in or `clai set kiro <key>`.",
    );
  }

  const decoded = decodeKiroKey(raw);
  if (decoded) return decoded;

  if (raw.startsWith("aorAAAAAG")) {
    return {
      accessToken: "",
      refreshToken: raw,
      authMethod: "imported",
      region: "us-east-1",
    };
  }

  if (raw.startsWith("ey") && raw.includes(".")) {
    return {
      accessToken: raw,
      authMethod: "external_idp",
      region: "us-east-1",
    };
  }

  return {
    accessToken: raw,
    apiKey: raw,
    authMethod: "api_key",
    region: "us-east-1",
  };
}

async function withKiroCredential<T>(
  auth: ProviderAuth,
  run: (credential: KiroCredential) => Promise<T>,
  onStatus?: ((message: string) => void) | undefined,
): Promise<T> {
  let credential = resolveKiroCredential(auth);
  if (credential.refreshToken && kiroCredentialNeedsRefresh(credential)) {
    const refreshed = await refreshStoredKiroKey(auth).catch(() => undefined);
    if (refreshed) credential = refreshed;
  }
  try {
    return await run(credential);
  } catch (error) {
    const status = error instanceof ProviderError ? error.status : undefined;
    if (status !== 401 && status !== 403) throw error;

    onStatus?.("ℹ Kiro authentication expired — attempting token refresh");
    let newCredential: KiroCredential | undefined;
    try {
      newCredential = await refreshStoredKiroKey(auth);
    } catch (refreshError) {
      if (refreshError instanceof KiroRefreshError) {
        throw new ProviderError(refreshError.message, status);
      }
      throw error;
    }
    if (!newCredential) throw error;
    onStatus?.("ℹ Kiro token refreshed — retrying request");
    return run(newCredential);
  }
}

async function refreshStoredKiroKey(
  auth: ProviderAuth,
): Promise<KiroCredential | undefined> {
  const oldKey = auth.apiKey ?? "";
  const refreshedKey = await maybeRefreshKiroCredential(oldKey, auth.refreshToken);
  if (!refreshedKey || refreshedKey === oldKey) return undefined;
  await replaceProviderKey("kiro", oldKey, refreshedKey).catch(() => {});
  auth.apiKey = refreshedKey;
  return resolveKiroCredential({ ...auth, apiKey: refreshedKey });
}

interface KiroEndpoint {
  readonly url: string;
  readonly awsTarget: boolean;
}

function getCandidateEndpoints(
  credential: KiroCredential,
  generation?: KiroApiGeneration,
): KiroEndpoint[] {
  const region = resolveKiroRuntimeRegion(credential);
  const apiRegion = region;
  const modern = { url: `https://runtime.${apiRegion}.kiro.dev/`, awsTarget: true };
  const q = {
    url: `https://q.${region}.amazonaws.com/generateAssistantResponse`,
    awsTarget: false,
  };
  const codewhisperer = {
    url: `https://codewhisperer.${region}.amazonaws.com/generateAssistantResponse`,
    awsTarget: true,
  };
  if (generation === "modern") {
    return credential.authMethod === "api_key"
      ? [modern, q, codewhisperer]
      : [modern, codewhisperer, q];
  }
  return credential.authMethod === "api_key"
    ? [q, modern, codewhisperer]
    : [codewhisperer, modern, q];
}

export function buildKiroRequestBody(
  request: CompletionRequest,
  credential: KiroCredential,
  upstreamModel: string,
  agentic: boolean,
  thinking: boolean,
): Record<string, unknown> {
  const conversation = normalizeKiroTurns(request, upstreamModel, { agentic });
  const modelInfo = kiroModelCatalog().find((info) => info.modelId === upstreamModel);
  const wantsThinking =
    (request.thinking?.enabled ?? thinking) && request.thinking?.effort !== "none";
  const additionalFields = kiroAdditionalModelFields(request, modelInfo, wantsThinking);
  const thinkingDirective =
    !additionalFields &&
    wantsThinking &&
    isLegacyThinkingDirectiveModel(upstreamModel) &&
    !modelInfo?.additionalModelRequestFieldsSchema
      ? legacyThinkingDirective(request.thinking?.effort)
      : "";
  const firstUserContent =
    conversation.turns.find((turn) => turn.role === "user" && turn.content.trim())
      ?.content ?? "";
  const state = buildKiroConversationState({
    conversation,
    modelId: upstreamModel,
    conversationId: kiroConversationId(firstUserContent, currentSessionAffinity()),
    tools: formatKiroTools(request.tools),
    mergeSystemPrompt: true,
    userTurnPrefix: thinkingDirective,
  });

  return {
    conversationState: state,
    ...(credential.profileArn ? { profileArn: credential.profileArn } : {}),
    ...(additionalFields ? { additionalModelRequestFields: additionalFields } : {}),
  };
}

let cachedKiroModels: string[] | null = null;
let cachedKiroModelInfo: readonly KiroModelInfo[] = [];
let cachedKiroApiGeneration: KiroApiGeneration | undefined;
let cachedKiroCredentialId = "";
let lastKiroModelFetch = 0;
const createResponseSupport = new Map<string, boolean>();
const MODEL_CACHE_TTL_MS = 30 * 60 * 1000;

function kiroCredentialId(credential: KiroCredential): string {
  return createHash("sha256")
    .update(credential.apiKey || credential.accessToken || credential.refreshToken || "")
    .digest("hex");
}

onModelListInvalidated("kiro", () => {
  lastKiroModelFetch = 0;
});

function hasFreshKiroCatalog(credentialId: string, maxAgeMs: number = MODEL_CACHE_TTL_MS): boolean {
  return (
    cachedKiroCredentialId === credentialId &&
    cachedKiroModels !== null &&
    isModelListFresh(lastKiroModelFetch, maxAgeMs)
  );
}

function kiroCatalogLimits(modelId: string, info: KiroModelInfo): CatalogFacts[] {
  if (info.maxInputTokens === undefined && info.maxOutputTokens === undefined) return [];
  return [{
    id: modelId,
    ...(info.maxInputTokens !== undefined ? { contextTokens: info.maxInputTokens } : {}),
    ...(info.maxOutputTokens !== undefined ? { maxOutputTokens: info.maxOutputTokens } : {}),
    ...(info.supportsImages !== undefined ? { vision: info.supportsImages } : {}),
  }];
}

async function ensureKiroModelCatalog(
  credential: KiroCredential,
  maxAgeMs: number = MODEL_CACHE_TTL_MS,
): Promise<void> {
  const credentialId = kiroCredentialId(credential);
  if (hasFreshKiroCatalog(credentialId, maxAgeMs)) return;
  const catalog = await discoverKiroModelsDetailed(credential);
  cachedKiroCredentialId = credentialId;
  cachedKiroModelInfo = catalog.models;
  cachedKiroApiGeneration = catalog.generation;
  cachedKiroModels = withKiroVariants(catalog.models.map((info) => info.modelId));
  lastKiroModelFetch = Date.now();
  const limits: CatalogFacts[] = [];
  for (const info of catalog.models) {
    if (info.supportsImages !== undefined) {
      learnModelVisionCapability("kiro", info.modelId, info.supportsImages);
    }
    const efforts = kiroCatalogEfforts(info.additionalModelRequestFieldsSchema);
    for (const variant of withKiroVariants([info.modelId])) {
      registerModelReasoningEfforts("kiro", variant, efforts);
      limits.push(...kiroCatalogLimits(variant, info));
    }
  }
  registerModelCatalogLimits("kiro", limits);
}

export function kiroModelCatalog(): readonly KiroModelInfo[] {
  return cachedKiroModelInfo;
}

export function resetKiroModelCacheForTesting(): void {
  cachedKiroModels = null;
  cachedKiroModelInfo = [];
  cachedKiroApiGeneration = undefined;
  cachedKiroCredentialId = "";
  lastKiroModelFetch = 0;
  createResponseSupport.clear();
}

export async function fetchKiroUsageLimits(
  auth: ProviderAuth,
  onStatus?: ((message: string) => void) | undefined,
): Promise<KiroUsageLimits> {
  return withKiroCredential(auth, getKiroUsageLimits, onStatus);
}

const KIRO_MODEL_RANK = (id: string): number => {
  const base = resolveKiroModel(id).upstream;
  if (base === "auto") return 0;
  if (/^claude-/.test(base)) return 1;
  return 2;
};

interface KiroRequestPlan {
  conversation: ReturnType<typeof normalizeKiroTurns>;
  conversationState: ReturnType<typeof buildKiroConversationState>;
  legacyBody: Record<string, unknown>;
  responsesBody: ReturnType<typeof buildKiroCreateResponseBody>;
  additionalFields: Record<string, unknown> | undefined;
}

function buildKiroRequestPlan(
  request: CompletionRequest,
  credential: KiroCredential,
  upstream: string,
  agentic: boolean,
  thinking: boolean,
): KiroRequestPlan {
  const conversation = normalizeKiroTurns(request, upstream, { agentic });
  const tools = formatKiroTools(request.tools);
  const modelInfo = kiroModelCatalog().find((info) => info.modelId === upstream);
  const wantsThinking =
    (request.thinking?.enabled ?? thinking) && request.thinking?.effort !== "none";
  const additionalFields = kiroAdditionalModelFields(request, modelInfo, wantsThinking);
  const thinkingDirective =
    !additionalFields &&
    wantsThinking &&
    isLegacyThinkingDirectiveModel(upstream) &&
    !modelInfo?.additionalModelRequestFieldsSchema
      ? legacyThinkingDirective(request.thinking?.effort)
      : "";
  const firstUserContent =
    conversation.turns.find((turn) => turn.role === "user" && turn.content.trim())
      ?.content ?? "";
  const conversationId = kiroConversationId(firstUserContent, currentSessionAffinity());
  const conversationState = buildKiroConversationState({
    conversation,
    modelId: upstream,
    conversationId,
    tools,
  });
  const legacyState = buildKiroConversationState({
    conversation,
    modelId: upstream,
    conversationId,
    tools,
    mergeSystemPrompt: true,
    userTurnPrefix: thinkingDirective,
  });

  return {
    conversation,
    conversationState,
    legacyBody: {
      conversationState: legacyState,
      ...(credential.profileArn ? { profileArn: credential.profileArn } : {}),
      ...(additionalFields ? { additionalModelRequestFields: additionalFields } : {}),
    },
    responsesBody: buildKiroCreateResponseBody({
      conversation,
      conversationState,
      modelId: upstream,
      profileArn: credential.profileArn,
      agentMode: KIRO_AGENT_MODE,
      modeIdentifier: KIRO_MODE_IDENTIFIER,
      tools,
      additionalModelRequestFields: additionalFields,
      userTurnPrefix: thinkingDirective,
    }),
    additionalFields,
  };
}

function kiroBearerToken(credential: KiroCredential): string {
  return credential.apiKey || credential.accessToken;
}

function kiroTokenType(credential: KiroCredential): string | undefined {
  if (credential.authMethod === "api_key") return "API_KEY";
  if (credential.authMethod === "external_idp") return "EXTERNAL_IDP";
  return undefined;
}

function kiroHttpError(status: number, body: string): ProviderError {
  if (status === 401 || status === 403) {
    return new ProviderError(`Kiro authentication failed (${status}): ${body}`, status);
  }
  if (status === 400) {
    return new ProviderError(`Kiro request invalid (${status}): ${body}`, status, body);
  }
  return new ProviderError(`Kiro endpoint error (${status}): ${body}`, status);
}

function kiroRuntimeBaseUrl(credential: KiroCredential): string {
  return `https://runtime.${resolveKiroRuntimeRegion(credential)}.kiro.dev`;
}

function isMissingCreateResponseOperation(status: number, body: string): boolean {
  if (status === 404 || status === 405 || status === 501) return true;
  return status === 400 && /unknown operation|not found|unsupported|invalid action/i.test(body);
}

type KiroCreateResponseAttempt = {
  response?: Response | undefined;
  requestId?: string | undefined;
  error?: ProviderError | undefined;
  fallback: boolean;
};

async function tryKiroCreateResponse(
  plan: KiroRequestPlan,
  credential: KiroCredential,
  signal: AbortSignal | undefined,
): Promise<KiroCreateResponseAttempt> {
  const capabilityKey = kiroCredentialId(credential);
  if (createResponseSupport.get(capabilityKey) === false) {
    return { fallback: true };
  }
  const response = await withUnrecordedTransport(() =>
    generationFetch(
      `${kiroRuntimeBaseUrl(credential)}/v1/responses`,
      {
        method: "POST",
        headers: kiroCreateResponseHeaders({
          accessToken: kiroBearerToken(credential),
          profileArn: credential.profileArn,
          tokenType: kiroTokenType(credential),
          userAgent: kiroCliUserAgent(),
        }),
        body: JSON.stringify(plan.responsesBody),
        ...(signal ? { signal } : {}),
      },
    )
  );
  if (response.ok) {
    createResponseSupport.set(capabilityKey, true);
    return {
      response,
      requestId: response.headers.get("x-amzn-requestid") ?? undefined,
      fallback: false,
    };
  }
  const body = await response.text().catch(() => "");
  const fallback = isMissingCreateResponseOperation(response.status, body);
  if (fallback) createResponseSupport.set(capabilityKey, false);
  return { error: kiroHttpError(response.status, body), fallback };
}

function flushKiroDeltas(
  accumulator: ReturnType<typeof createKiroStreamAccumulator>,
  request: CompletionRequest,
  onToken: (token: string) => void,
): void {
  for (const event of accumulator.drain()) {
    if (event.kind === "token") onToken(event.text);
    else if (event.kind === "reasoning") {
      emitStreamReasoningDelta(request.onStreamEvent, event.text);
    } else request.onToolCallDelta?.(event.delta);
  }
}

interface KiroConsumeInput {
  response: Response;
  api: "create-response" | "generate-assistant-response";
  requestId?: string | undefined;
  request: CompletionRequest;
  onToken: (token: string) => void;
  upstream: string;
  requestedModel: string;
  additionalFields: Record<string, unknown> | undefined;
}

async function consumeKiroResponse(input: KiroConsumeInput): Promise<CompletionResult> {
  const { response, request, onToken, upstream, requestedModel } = input;
  if (!response.body) {
    throw new ProviderError("Empty response body from Kiro endpoint", 500);
  }

  const accumulator = createKiroStreamAccumulator();
  if (input.api === "create-response") {
    for await (const event of parseKiroCreateResponseSse(response.body, {
      requestId: input.requestId,
    })) {
      accumulator.applySseEvent(event);
      flushKiroDeltas(accumulator, request, onToken);
    }
  } else {
    for await (const frame of parseEventStream(response.body)) {
      accumulator.applyLegacyFrame(frame);
      flushKiroDeltas(accumulator, request, onToken);
    }
  }

  accumulator.finish();
  flushKiroDeltas(accumulator, request, onToken);

  const toolCalls = accumulator.toolCalls;
  const reasoning = accumulator.reasoning;
  const stopReason = accumulator.stopReason;
  const stopDisposition = kiroStopDisposition(stopReason, toolCalls.length > 0);
  if (stopDisposition === "blocked") {
    throw new ProviderError(
      `Kiro blocked the response under its content safety policy (${stopReason})`,
      400,
    );
  }
  if (
    stopDisposition === "retryable" ||
    stopDisposition === "incomplete" ||
    stopDisposition === "unknown"
  ) {
    throw new ProviderError(`Kiro ended with non-success stop reason: ${stopReason}`, 502);
  }

  const hasReasoningEvidence = Boolean(
    reasoning.text.trim() || reasoning.signature || reasoning.redactedContent,
  );
  if (!accumulator.text.trim() && !hasReasoningEvidence && toolCalls.length === 0) {
    throw new ProviderError("Kiro completed without a visible answer.");
  }
  if (toolCalls.length === 0 && ["...", "\u2026"].includes(accumulator.text.trim())) {
    throw new ProviderError("Kiro completed without a visible answer.");
  }
  if (reasoning.opaque && (accumulator.text.trim() || toolCalls.length > 0)) {
    emitStreamReasoningDelta(
      request.onStreamEvent,
      kiroPrivateReasoningNote({
        model: upstream,
        effort: sentKiroReasoningEffort(input.additionalFields),
        signatureChars: reasoning.signature.length,
      }),
    );
  }

  let finishReason = accumulator.finishReason;
  if (stopDisposition === "length") finishReason = "length";
  else if (toolCalls.length > 0) finishReason = "tool_calls";

  const advertisedWindow = kiroModelCatalog().find(
    (info) => info.modelId === upstream,
  )?.maxInputTokens;
  const catalogWindow =
    advertisedWindow !== undefined && Number.isFinite(advertisedWindow) && advertisedWindow > 0
      ? Math.floor(advertisedWindow)
      : undefined;
  const contextUsagePercentage = accumulator.contextUsagePercentage;
  const estimatedPromptTokens = providerRatioPromptTokens(
    contextUsagePercentage,
    catalogWindow ?? modelContextWindow(upstream, "kiro"),
  );

  const { promptTokens, completionTokens, cachedTokens, cacheCreationTokens, charges } =
    accumulator.usage;
  const tokenUsage: TokenUsage | undefined =
    promptTokens > 0 || completionTokens > 0
      ? {
          promptTokens,
          completionTokens,
          totalTokens: promptTokens + completionTokens,
          exact: true,
          cachedPromptTokens: cachedTokens > 0 ? cachedTokens : undefined,
          cacheCreationTokens: cacheCreationTokens > 0 ? cacheCreationTokens : undefined,
          uncachedPromptTokens:
            cachedTokens > 0 ? Math.max(0, promptTokens - cachedTokens) : promptTokens,
        }
      : catalogWindow !== undefined
        ? providerRatioUsage({
            percentUsed: contextUsagePercentage,
            windowTokens: catalogWindow,
          })
        : estimatedPromptTokens !== undefined
          ? {
              promptTokens: estimatedPromptTokens,
              completionTokens: 0,
              totalTokens: estimatedPromptTokens,
              exact: false,
            }
          : undefined;
  const usage: TokenUsage | undefined = tokenUsage
    ? { ...tokenUsage, ...(charges.length > 0 ? { charges } : {}) }
    : charges.length > 0
      ? {
          promptTokens: 0,
          promptTokensKnown: false,
          completionTokens: 0,
          totalTokens: 0,
          exact: false,
          charges,
        }
      : undefined;

  const reasoningResult = kiroReasoningResult({
    reasoning,
    provenance: createReasoningArtifactProvenance({
      provider: "kiro",
      model: upstream,
      dialect: "kiro-eventstream",
    }),
    hasToolCalls: toolCalls.length > 0,
  });

  return {
    text: accumulator.text,
    provider: "kiro",
    model: requestedModel,
    api: input.api,
    finishReason,
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    usage,
    reasoningArtifacts:
      reasoningResult.artifacts.length > 0 ? reasoningResult.artifacts : undefined,
    reasoningBlock: reasoningResult.block,
  };
}

export const kiroProvider: LlmProvider = {
  id: "kiro",
  displayName: "Kiro AI",
  defaultModel: defaultModels.kiro,
  envVar: "KIRO_API_KEY",

  sortModels(models: string[]): string[] {
    return [...models].sort(
      (a, b) =>
        KIRO_MODEL_RANK(a) - KIRO_MODEL_RANK(b) || a.localeCompare(b),
    );
  },

  validateKey(key: string): boolean {
    const trimmed = key.trim();
    if (!trimmed) return false;
    if (isKiroOAuthToken(trimmed)) return decodeKiroKey(trimmed) !== undefined;
    if (trimmed.startsWith("aorAAAAAG")) return true;
    if (trimmed.startsWith("ey") && trimmed.includes(".")) return true;
    return trimmed.length >= 8;
  },

  async listModels(auth: ProviderAuth): Promise<string[]> {
    const credential = resolveKiroCredential(auth);
    const credentialId = kiroCredentialId(credential);
    if (hasFreshKiroCatalog(credentialId, MODEL_LIST_TTL_MS)) return cachedKiroModels!;

    try {
      const refreshedId = await withKiroCredential(auth, async (current) => {
        await ensureKiroModelCatalog(current, MODEL_LIST_TTL_MS);
        return kiroCredentialId(current);
      });
      if (
        (cachedKiroCredentialId === credentialId ||
          cachedKiroCredentialId === refreshedId) &&
        cachedKiroModels
      ) {
        return cachedKiroModels;
      }
    } catch {}

    return fallbackModelList(kiroFallbackModels);
  },

  async ping(auth: ProviderAuth): Promise<void> {
    const credential = resolveKiroCredential(auth);
    try {
      await discoverKiroModelsDetailed(credential);
    } catch (error) {
      const detail = error instanceof Error ? `: ${error.message}` : "";
      throw new ProviderError(
        `Kiro AI ping failed${detail}. Run \`clai auth kiro\` to sign in.`,
      );
    }
  },

  async complete(
    request: CompletionRequest,
    auth: ProviderAuth,
    onStatus?: ((message: string) => void) | undefined,
  ): Promise<CompletionResult> {
    return this.stream!(request, auth, () => {}, onStatus);
  },

  async stream(
    request: CompletionRequest,
    auth: ProviderAuth,
    onToken: (token: string) => void,
    onStatus?: ((message: string) => void) | undefined,
  ): Promise<CompletionResult> {
    const requestedModel = request.model ?? defaultModels.kiro;
    const { upstream, agentic, thinking } = resolveKiroModel(requestedModel);

    return withKiroCredential(
      auth,
      async (credential) => {
        await ensureKiroModelCatalog(credential).catch(() => {});
        const plan = buildKiroRequestPlan(request, credential, upstream, agentic, thinking);

        let lastError: Error | undefined;
        const createResponse = await tryKiroCreateResponse(plan, credential, request.signal)
          .catch((error: unknown) => {
            lastError = error instanceof Error ? error : new Error(String(error));
            return undefined;
          });

        if (createResponse?.response) {
          try {
            return await consumeKiroResponse({
              response: createResponse.response,
              api: "create-response",
              requestId: createResponse.requestId,
              request,
              onToken,
              upstream,
              requestedModel,
              additionalFields: plan.additionalFields,
            });
          } catch (error) {
            if (request.signal?.aborted) {
              completeGenerationAttempt("cancelled");
              throw error;
            }
            const status = error instanceof ProviderError ? error.status : undefined;
            completeGenerationAttempt("failure", undefined, status);
            throw error;
          }
        }
        if (createResponse?.error) {
          if (!createResponse.fallback) throw createResponse.error;
          lastError = createResponse.error;
        }

        const catalogIsFresh = hasFreshKiroCatalog(kiroCredentialId(credential));
        const endpoints = getCandidateEndpoints(
          credential,
          catalogIsFresh ? cachedKiroApiGeneration : undefined,
        );

        for (const endpoint of endpoints) {
          try {
            const response = await generationFetch(endpoint.url, {
              method: "POST",
              headers: kiroLegacyHeaders({
                accessToken: kiroBearerToken(credential),
                profileArn: credential.profileArn,
                tokenType: kiroTokenType(credential),
                userAgent: kiroCliUserAgent(),
                awsTarget: endpoint.awsTarget,
              }),
              body: JSON.stringify(plan.legacyBody),
              ...(request.signal ? { signal: request.signal } : {}),
            });

            if (!response.ok) {
              const errorText = await response.text().catch(() => "");
              const error = kiroHttpError(response.status, errorText);
              if (response.status === 401 || response.status === 403) {
                if (response.status === 401 && credential.refreshToken) throw error;
                lastError = error;
                continue;
              }
              if (response.status === 400) throw error;
              lastError = error;
              continue;
            }
            if (!response.body) {
              throw new ProviderError("Empty response body from Kiro endpoint", 500);
            }

            return await consumeKiroResponse({
              response,
              api: "generate-assistant-response",
              request,
              onToken,
              upstream,
              requestedModel,
              additionalFields: plan.additionalFields,
            });
          } catch (error) {
            if (request.signal?.aborted) {
              completeGenerationAttempt("cancelled");
              throw error;
            }
            const status = error instanceof ProviderError ? error.status : undefined;
            completeGenerationAttempt("failure", undefined, status);
            if (
              error instanceof ProviderError &&
              (status === 400 ||
                status === undefined ||
                (status === 401 && Boolean(credential.refreshToken)))
            ) {
              throw error;
            }
            lastError = error instanceof Error ? error : new Error(String(error));
          }
        }

        throw lastError ?? new Error("All Kiro endpoints failed");
      },
      onStatus,
    );
  },
};
