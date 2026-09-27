import { createHash, randomUUID } from "node:crypto";
import type {
  ChatMessage,
  CompletionRequest,
  CompletionResult,
  NativeToolCall,
  ReasoningEffort,
  TokenUsage,
  ToolCallStreamDelta,
  ToolDefinition,
  UsageCharge,
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
} from "./operation-usage.js";
import { learnModelVisionCapability } from "./capability/vision-registry.js";
import { emitStreamReasoningDelta } from "./stream-events.js";
import {
  createReasoningArtifactProvenance,
  createReasoningArtifactReplayTarget,
  reasoningArtifactSignature,
  reasoningArtifactText,
  reasoningArtifactsForMessage,
  selectReasoningArtifactsForReplay,
} from "./reasoning-artifacts.js";
import {
  createKiroReasoningAccumulator,
  kiroPrivateReasoningNote,
  kiroCatalogEfforts,
  kiroReasoningResult,
  sentKiroReasoningEffort,
} from "./kiro-reasoning.js";
import {
  registerModelCatalogFacts,
  registerModelReasoningEfforts,
} from "./capabilities.js";
import { modelContextWindow } from "./context-windows.js";
import {
  providerRatioPromptTokens,
  providerRatioUsage,
} from "./provider-context-usage.js";
import { inBandBadRequestStatus } from "./reasoning-errors.js";
import { replaceProviderKey } from "../store/keys.js";

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

function uuidFromHex(hex: string): string {
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function kiroConversationId(seedContent: string): string {
  const affinity = currentSessionAffinity();
  if (affinity) {
    return uuidFromHex(createHash("md5").update(`kiro-${affinity}`).digest("hex"));
  }
  const seed = seedContent.trim();
  if (seed) {
    return uuidFromHex(
      createHash("md5").update(`kiro-${seed.slice(0, 4000)}`).digest("hex"),
    );
  }
  return randomUUID();
}

function sanitizeToolName(name: string): string {
  return name.slice(0, 64).replace(/[^a-zA-Z0-9_-]/g, "_") || "tool";
}

function formatKiroTools(tools?: ToolDefinition[]): Array<{
  toolSpecification: {
    name: string;
    description: string;
    inputSchema: { json: Record<string, unknown> };
  };
}> {
  if (!tools || tools.length === 0) return [];
  return tools.map((tool) => ({
    toolSpecification: {
      name: sanitizeToolName(tool.wireName || tool.name),
      description: (tool.description || `Tool: ${tool.name}`).slice(0, 10237),
      inputSchema: {
        json: tool.parameters as unknown as Record<string, unknown>,
      },
    },
  }));
}

function imageFormatFromMediaType(mediaType: string): string {
  const lower = mediaType.toLowerCase();
  if (lower.includes("jpeg") || lower.includes("jpg")) return "jpeg";
  if (lower.includes("png")) return "png";
  if (lower.includes("gif")) return "gif";
  if (lower.includes("webp")) return "webp";
  return "png";
}

export function buildKiroRequestBody(
  request: CompletionRequest,
  credential: KiroCredential,
  upstreamModel: string,
  agentic: boolean,
  thinking: boolean,
): Record<string, unknown> {
  const agenticInstruction = agentic
    ? "When modifying or creating files, keep writes concise:\n- Maximum 350 lines per file write/tool call (recommended 300 lines or fewer).\n- Prefer targeted, incremental edits instead of rewriting entire files.\n- For large files, write or append in chunks across multiple tool calls."
    : "";

  const systemParts: string[] = [];
  if (agenticInstruction) systemParts.push(agenticInstruction);

  let sawLeadingSystem = false;
  const nonSystemMessages: ChatMessage[] = [];
  for (const msg of request.messages) {
    if (msg.role !== "system") {
      nonSystemMessages.push(msg);
      continue;
    }
    if (!sawLeadingSystem) {
      sawLeadingSystem = true;
      if (msg.content.trim()) systemParts.push(msg.content.trim());
      continue;
    }
    if (msg.content.trim()) {
      nonSystemMessages.push({
        ...msg,
        role: "user",
        content: msg.content.startsWith("[SYSTEM]")
          ? msg.content
          : `[SYSTEM]\n${msg.content}`,
      });
    }
  }

  const systemPrompt = systemParts.join("\n\n").trim();

  interface NormalizedTurn {
    role: "user" | "assistant";
    content: string;
    reasoningContent?:
      | { reasoningText: { text: string; signature: string } }
      | { redactedContent: string }
      | undefined;
    toolCalls?: NativeToolCall[] | undefined;
    toolResults?: Array<{
      toolUseId: string;
      content: Array<{ text: string }>;
      status: "success" | "error";
    }> | undefined;
    toolUses?: Array<{
      toolUseId: string;
      name: string;
      input: Record<string, unknown>;
    }> | undefined;
    images?: Array<{
      format: string;
      source: { bytes: string };
    }> | undefined;
  }

  const turns: NormalizedTurn[] = [];

  for (const msg of nonSystemMessages) {
    if (msg.role === "user") {
      const images = (msg.images ?? []).map((img) => ({
        format: imageFormatFromMediaType(img.mediaType),
        source: { bytes: img.dataBase64 },
      }));

      const last = turns[turns.length - 1];
      if (last && last.role === "user") {
        if (msg.content) {
          last.content = last.content
            ? `${last.content}\n\n${msg.content}`
            : msg.content;
        }
        if (images.length > 0) {
          last.images = [...(last.images ?? []), ...images];
        }
      } else {
        turns.push({
          role: "user",
          content: msg.content || "",
          images: images.length > 0 ? images : undefined,
        });
      }
    } else if (msg.role === "assistant") {
      const replayTarget = createReasoningArtifactReplayTarget({
        provider: "kiro",
        model: upstreamModel,
        dialect: "kiro-eventstream",
      });
      const replayedReasoning = request.forceReasoningReplay === false
        ? []
        : selectReasoningArtifactsForReplay({
            artifacts: reasoningArtifactsForMessage(msg),
            target: replayTarget,
            context: {
              hasToolCalls: Boolean(msg.toolCalls?.length),
              forceScope: request.forceReasoningReplay === true,
            },
            observe: request.onReasoningArtifactReplayDecision,
          });
      const signedReasoning = replayedReasoning.find((artifact) =>
        reasoningArtifactText(artifact) && reasoningArtifactSignature(artifact)
      );
      const redactedReasoning = replayedReasoning.find((artifact) => {
        const raw = asKiroRecord(artifact.raw);
        return artifact.kind === "encrypted" && typeof raw?.redactedContent === "string";
      });
      const redactedRaw = redactedReasoning
        ? asKiroRecord(redactedReasoning.raw)
        : undefined;
      const reasoningContent = signedReasoning
        ? {
            reasoningText: {
              text: reasoningArtifactText(signedReasoning)!,
              signature: reasoningArtifactSignature(signedReasoning)!,
            },
          }
        : typeof redactedRaw?.redactedContent === "string"
          ? { redactedContent: redactedRaw.redactedContent }
          : undefined;
      const toolUses = (msg.toolCalls ?? [])
        .filter((tc) => tc.id)
        .map((tc) => ({
          toolUseId: tc.id,
          name: sanitizeToolName(tc.name),
          input: tc.args ?? {},
        }));

      const last = turns[turns.length - 1];
      if (last && last.role === "assistant") {
        if (msg.content) {
          last.content = last.content
            ? `${last.content}\n\n${msg.content}`
            : msg.content;
        }
        if (reasoningContent && !last.reasoningContent) {
          last.reasoningContent = reasoningContent;
        }
        if (toolUses.length > 0) {
          last.toolUses = [...(last.toolUses ?? []), ...toolUses];
        }
      } else {
        turns.push({
          role: "assistant",
          content: msg.content || "",
          reasoningContent,
          toolUses: toolUses.length > 0 ? toolUses : undefined,
        });
      }
    } else if (msg.role === "tool") {
      const toolResult = {
        toolUseId: msg.toolCallId || "tool_result",
        content: [{ text: msg.content || "" }],
        status: msg.ok === false ? ("error" as const) : ("success" as const),
      };

      const last = turns[turns.length - 1];
      if (last && last.role === "user") {
        last.toolResults = [...(last.toolResults ?? []), toolResult];
      } else {
        turns.push({
          role: "user",
          content: "",
          toolResults: [toolResult],
        });
      }
    }
  }

  if (turns.length === 0) {
    turns.push({ role: "user", content: "continue" });
  }

  if (systemPrompt && turns[0] && turns[0].role === "user") {
    turns[0].content = turns[0].content
      ? `${systemPrompt}\n\n${turns[0].content}`
      : systemPrompt;
  }

  if (turns[turns.length - 1]?.role !== "user") {
    turns.push({ role: "user", content: "continue" });
  }

  for (const turn of turns) {
    if (turn.role === "user" && !turn.content.trim()) {
      turn.content =
        turn.toolResults && turn.toolResults.length > 0
          ? "Tool results provided."
          : "continue";
    }
  }

  const modelInfo = kiroModelCatalog().find((info) => info.modelId === upstreamModel);
  const kiroTools = formatKiroTools(request.tools);
  const wantsThinking =
    (request.thinking?.enabled ?? thinking) &&
    request.thinking?.effort !== "none";
  const additionalFields = kiroAdditionalModelFields(
    request,
    modelInfo,
    wantsThinking,
  );
  const thinkingDirective =
    !additionalFields &&
    wantsThinking &&
    isLegacyThinkingDirectiveModel(upstreamModel) &&
    !modelInfo?.additionalModelRequestFieldsSchema
      ? legacyThinkingDirective(request.thinking?.effort)
      : "";
  if (thinkingDirective) {
    for (const turn of turns) {
      if (turn.role === "user") {
        turn.content = `${thinkingDirective}\n\n${turn.content}`;
      }
    }
  }

  const history: Array<Record<string, unknown>> = [];
  for (let i = 0; i < turns.length - 1; i++) {
    const turn = turns[i]!;
    if (turn.role === "user") {
      const userContext: Record<string, unknown> = {};
      if (turn.toolResults && turn.toolResults.length > 0) {
        userContext.toolResults = turn.toolResults;
      }
      history.push({
        userInputMessage: {
          content: turn.content,
          modelId: upstreamModel,
          origin: "AI_EDITOR",
          userInputMessageContext: userContext,
          ...(turn.images && turn.images.length > 0
            ? { images: turn.images }
            : {}),
        },
      });
    } else {
      history.push({
        assistantResponseMessage: {
          content: turn.content,
          ...(turn.reasoningContent
            ? { reasoningContent: turn.reasoningContent }
            : {}),
          ...(turn.toolUses && turn.toolUses.length > 0
            ? { toolUses: turn.toolUses }
            : {}),
        },
      });
    }
  }

  const lastTurn = turns[turns.length - 1]!;
  const currentContext: Record<string, unknown> = {};
  if (kiroTools.length > 0) {
    currentContext.tools = kiroTools;
  }
  if (lastTurn.toolResults && lastTurn.toolResults.length > 0) {
    currentContext.toolResults = lastTurn.toolResults;
  }

  const currentMessage = {
    userInputMessage: {
      content: lastTurn.content,
      modelId: upstreamModel,
      origin: "AI_EDITOR",
      userInputMessageContext: currentContext,
      ...(lastTurn.images && lastTurn.images.length > 0
        ? { images: lastTurn.images }
        : {}),
    },
  };

  const firstUserContent =
    turns.find((t) => t.role === "user" && t.content.trim())?.content ?? "";
  const conversationId = kiroConversationId(firstUserContent);

  const payload: Record<string, unknown> = {
    conversationState: {
      conversationId,
      chatTriggerType: "MANUAL",
      history,
      currentMessage,
    },
  };

  if (credential.profileArn) {
    payload.profileArn = credential.profileArn;
  }

  if (additionalFields) {
    payload.additionalModelRequestFields = additionalFields;
  }

  return payload;
}

let cachedKiroModels: string[] | null = null;
let cachedKiroModelInfo: readonly KiroModelInfo[] = [];
let cachedKiroApiGeneration: KiroApiGeneration | undefined;
let cachedKiroCredentialId = "";
let lastKiroModelFetch = 0;
const MODEL_CACHE_TTL_MS = 30 * 60 * 1000;

function kiroCredentialId(credential: KiroCredential): string {
  return createHash("sha256")
    .update(credential.apiKey || credential.accessToken || credential.refreshToken || "")
    .digest("hex");
}

function hasFreshKiroCatalog(credentialId: string): boolean {
  return (
    cachedKiroCredentialId === credentialId &&
    cachedKiroModels !== null &&
    Date.now() - lastKiroModelFetch < MODEL_CACHE_TTL_MS
  );
}

function registerKiroCatalogLimits(modelId: string, info: KiroModelInfo): void {
  if (info.maxInputTokens === undefined && info.maxOutputTokens === undefined) return;
  registerModelCatalogFacts("kiro", {
    id: modelId,
    ...(info.maxInputTokens !== undefined ? { contextTokens: info.maxInputTokens } : {}),
    ...(info.maxOutputTokens !== undefined ? { maxOutputTokens: info.maxOutputTokens } : {}),
    ...(info.supportsImages !== undefined ? { vision: info.supportsImages } : {}),
  });
}

async function ensureKiroModelCatalog(credential: KiroCredential): Promise<void> {
  const credentialId = kiroCredentialId(credential);
  if (hasFreshKiroCatalog(credentialId)) return;
  const catalog = await discoverKiroModelsDetailed(credential);
  cachedKiroCredentialId = credentialId;
  cachedKiroModelInfo = catalog.models;
  cachedKiroApiGeneration = catalog.generation;
  cachedKiroModels = withKiroVariants(catalog.models.map((info) => info.modelId));
  lastKiroModelFetch = Date.now();
  for (const info of catalog.models) {
    if (info.supportsImages !== undefined) {
      learnModelVisionCapability("kiro", info.modelId, info.supportsImages);
    }
    const efforts = kiroCatalogEfforts(info.additionalModelRequestFieldsSchema);
    for (const variant of withKiroVariants([info.modelId])) {
      registerModelReasoningEfforts("kiro", variant, efforts);
      registerKiroCatalogLimits(variant, info);
    }
  }
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
    const cacheIsFresh =
      cachedKiroCredentialId === credentialId &&
      cachedKiroModels !== null &&
      Date.now() - lastKiroModelFetch < MODEL_CACHE_TTL_MS;
    if (cacheIsFresh) return cachedKiroModels!;

    try {
      const refreshedId = await withKiroCredential(auth, async (current) => {
        await ensureKiroModelCatalog(current);
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

    return [...kiroFallbackModels];
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
        const body = buildKiroRequestBody(
          request,
          credential,
          upstream,
          agentic,
          thinking,
        );
        const catalogIsFresh = hasFreshKiroCatalog(kiroCredentialId(credential));
        const endpoints = getCandidateEndpoints(
          credential,
          catalogIsFresh ? cachedKiroApiGeneration : undefined,
        );

        let lastError: Error | undefined;

        for (const endpoint of endpoints) {
          try {
            const headers: Record<string, string> = {
              "Content-Type": endpoint.awsTarget
                ? "application/x-amz-json-1.0"
                : "application/json",
              Accept: "application/vnd.amazon.eventstream",
              "Amz-Sdk-Request": "attempt=1; max=3",
              "Amz-Sdk-Invocation-Id": randomUUID(),
              "User-Agent": "aws-sdk-js/3.0.0 kiro-ide/1.0.0",
              "X-Amz-User-Agent": "aws-sdk-js/3.0.0 kiro-ide/1.0.0",
              "x-amzn-kiro-agent-mode": "vibe",
              "x-amzn-codewhisperer-optout": "true",
              "x-amzn-codewhisperer-machine-id": "kiro-desktop",
            };

            if (endpoint.awsTarget) {
              headers["X-Amz-Target"] =
                "AmazonCodeWhispererStreamingService.GenerateAssistantResponse";
            }

            if (credential.authMethod === "api_key" && credential.apiKey) {
              headers["Authorization"] = `Bearer ${credential.apiKey}`;
              headers["TokenType"] = "API_KEY";
            } else if (credential.accessToken) {
              headers["Authorization"] = `Bearer ${credential.accessToken}`;
              headers["x-amz-sso-bearer"] = credential.accessToken;
              if (credential.authMethod === "external_idp") {
                headers["TokenType"] = "EXTERNAL_IDP";
              }
              if (credential.profileArn) {
                headers["x-amzn-codewhisperer-profile-arn"] = credential.profileArn;
              }
            }

            const response = await generationFetch(endpoint.url, {
              method: "POST",
              headers,
              body: JSON.stringify(body),
              ...(request.signal ? { signal: request.signal } : {}),
            });

            if (!response.ok) {
              const errorText = await response.text().catch(() => "");
              if (response.status === 401 || response.status === 403) {
                const authError = new ProviderError(
                  `Kiro authentication failed (${response.status}): ${errorText}`,
                  response.status,
                );
                if (response.status === 401 && credential.refreshToken) {
                  throw authError;
                }
                lastError = authError;
                continue;
              }
              if (response.status === 400) {
                throw new ProviderError(
                  `Kiro request invalid (${response.status}): ${errorText}`,
                  response.status,
                  errorText,
                );
              }
              lastError = new ProviderError(
                `Kiro endpoint error (${response.status}): ${errorText}`,
                response.status,
              );
              continue;
            }

            if (!response.body) {
              throw new ProviderError("Empty response body from Kiro endpoint", 500);
            }

            let fullText = "";
            type PendingKiroStreamEvent =
              | { kind: "token"; text: string }
              | { kind: "reasoning"; text: string }
              | { kind: "tool"; delta: ToolCallStreamDelta };
            const pendingStreamEvents: PendingKiroStreamEvent[] = [];
            const reasoning = createKiroReasoningAccumulator((text) =>
              pendingStreamEvents.push({ kind: "reasoning", text })
            );
            let insideThinkingTag = false;
            let finishReason: string = "stop";
            let stopReason = "";

            interface PartialToolCall {
              id: string;
              name: string;
              rawArgs: string;
              syntheticId: boolean;
            }
            const accumulatedTools: PartialToolCall[] = [];
            let currentToolIndex = -1;

            let promptTokens = 0;
            let completionTokens = 0;
            let cachedTokens = 0;
            let cacheCreationTokens = 0;
            const usageCharges: UsageCharge[] = [];
            let contextUsagePercentage: number | undefined;

            for await (const frame of parseEventStream(response.body)) {
              const messageType =
                typeof frame.headers[":message-type"] === "string"
                  ? frame.headers[":message-type"]
                  : "event";
              const headerExceptionType =
                typeof frame.headers[":exception-type"] === "string"
                  ? frame.headers[":exception-type"]
                  : "";
              const eventType =
                (typeof frame.headers[":event-type"] === "string"
                  ? frame.headers[":event-type"]
                  : undefined) ||
                headerExceptionType ||
                Object.keys(frame.payload).find((key) =>
                  key.endsWith("Event") || key.endsWith("Exception")
                ) ||
                "";

              const nestedPayload = asKiroRecord(frame.payload[eventType]);
              const eventPayload = nestedPayload ?? frame.payload;
              if (messageType === "exception" || headerExceptionType || eventType.endsWith("Exception")) {
                const message =
                  typeof eventPayload.message === "string"
                    ? eventPayload.message
                    : typeof eventPayload.reason === "string"
                      ? eventPayload.reason
                      : "Kiro stream exception";
                throw new ProviderError(
                  `${headerExceptionType || eventType || "Kiro stream exception"}: ${message}`,
                  inBandBadRequestStatus({
                    type: headerExceptionType || eventType,
                    code: eventPayload.code,
                    message,
                  }) ??
                    (/THINKING_SIGNATURE_INVALID|THINKING_SIGNATURE_MISMATCH/i.test(
                      `${headerExceptionType} ${eventType} ${message}`,
                    )
                      ? 400
                      : 502),
                  JSON.stringify(eventPayload),
                );
              }

              if (
                typeof eventPayload.usage === "number" &&
                Number.isFinite(eventPayload.usage) &&
                eventPayload.usage >= 0 &&
                typeof eventPayload.unit === "string" &&
                eventPayload.unit.trim()
              ) {
                usageCharges.push({
                  amount: eventPayload.usage,
                  unit:
                    typeof eventPayload.unitPlural === "string" &&
                    eventPayload.unitPlural.trim()
                      ? eventPayload.unitPlural.trim()
                      : eventPayload.unit.trim(),
                  ...(typeof eventPayload.currency === "string"
                    ? { currency: eventPayload.currency }
                    : {}),
                });
              }

              if (
                eventType === "assistantResponseEvent" ||
                eventType.includes("Response")
              ) {
                if (typeof eventPayload.contextUsagePercentage === "number") {
                  contextUsagePercentage = eventPayload.contextUsagePercentage;
                }
                const chunk =
                  typeof eventPayload.content === "string"
                    ? eventPayload.content
                    : "";
                if (chunk) {
                  let visibleChunk = "";
                  let reasoningChunk = "";
                  let i = 0;
                  while (i < chunk.length) {
                    if (!insideThinkingTag) {
                      const tagStart = chunk.indexOf("<thinking>", i);
                      if (tagStart !== -1) {
                        visibleChunk += chunk.slice(i, tagStart);
                        insideThinkingTag = true;
                        i = tagStart + 10;
                      } else {
                        visibleChunk += chunk.slice(i);
                        break;
                      }
                    } else {
                      const tagEnd = chunk.indexOf("</thinking>", i);
                      if (tagEnd !== -1) {
                        reasoningChunk += chunk.slice(i, tagEnd);
                        insideThinkingTag = false;
                        i = tagEnd + 11;
                      } else {
                        reasoningChunk += chunk.slice(i);
                        break;
                      }
                    }
                  }

                  reasoning.push(reasoningChunk);
                  if (visibleChunk) {
                    fullText += visibleChunk;
                    pendingStreamEvents.push({ kind: "token", text: visibleChunk });
                  }
                }
              } else if (
                eventType === "reasoningContentEvent" ||
                /reasoning/i.test(eventType) ||
                eventPayload.reasoningText !== undefined
              ) {
                const reasoningPayload = asKiroRecord(eventPayload.reasoningText);
                const chunk =
                  typeof eventPayload.text === "string"
                    ? eventPayload.text
                    : typeof eventPayload.content === "string"
                      ? eventPayload.content
                      : typeof eventPayload.reasoningText === "string"
                        ? eventPayload.reasoningText
                        : typeof reasoningPayload?.text === "string"
                          ? reasoningPayload.text
                          : typeof reasoningPayload?.Text === "string"
                            ? reasoningPayload.Text
                            : "";
                reasoning.sign(
                  typeof eventPayload.signature === "string"
                    ? eventPayload.signature
                    : typeof eventPayload.Signature === "string"
                      ? eventPayload.Signature
                      : typeof reasoningPayload?.signature === "string"
                        ? reasoningPayload.signature
                        : typeof reasoningPayload?.Signature === "string"
                          ? reasoningPayload.Signature
                          : "",
                );
                reasoning.redact(
                  typeof eventPayload.redactedContent === "string"
                    ? eventPayload.redactedContent
                    : "",
                );
                reasoning.push(chunk);
              } else if (eventType === "codeEvent") {
                const chunk =
                  typeof eventPayload.content === "string"
                    ? eventPayload.content
                    : "";
                if (chunk) {
                  fullText += chunk;
                  pendingStreamEvents.push({ kind: "token", text: chunk });
                }
              } else if (eventType === "toolUseEvent") {
                const explicitToolId =
                  typeof eventPayload.toolUseId === "string"
                    ? eventPayload.toolUseId
                    : typeof eventPayload.tool_use_id === "string"
                      ? eventPayload.tool_use_id
                      : undefined;
                const name =
                  typeof eventPayload.name === "string" ? eventPayload.name : "";
                const input = eventPayload.input;
                const stopped = eventPayload.stop === true;
                let existing = explicitToolId
                  ? accumulatedTools.find((tool) => tool.id === explicitToolId)
                  : accumulatedTools[currentToolIndex];

                if (
                  explicitToolId &&
                  !existing &&
                  currentToolIndex >= 0 &&
                  accumulatedTools[currentToolIndex]?.syntheticId
                ) {
                  const activeTool = accumulatedTools[currentToolIndex]!;
                  activeTool.id = explicitToolId;
                  activeTool.syntheticId = false;
                  existing = activeTool;
                }
                if (!existing && (explicitToolId || name || input !== undefined)) {
                  existing = {
                    id: explicitToolId ?? `tool_${accumulatedTools.length + 1}`,
                    name,
                    rawArgs: "",
                    syntheticId: explicitToolId === undefined,
                  };
                  accumulatedTools.push(existing);
                }
                if (!existing) {
                  if (stopped) currentToolIndex = -1;
                  continue;
                }

                if (typeof input === "string") {
                  existing.rawArgs += input;
                } else if (input && typeof input === "object") {
                  existing.rawArgs = JSON.stringify(input);
                }
                if (name && !existing.name) existing.name = name;
                currentToolIndex = accumulatedTools.indexOf(existing);
                const argumentsBytes = Buffer.byteLength(existing.rawArgs, "utf8");
                const delta: ToolCallStreamDelta = {
                  index: currentToolIndex,
                  id: existing.id,
                  name: existing.name,
                  argumentsBytes,
                };
                pendingStreamEvents.push({ kind: "tool", delta });
                finishReason = "tool_calls";
                if (stopped) currentToolIndex = -1;
              } else if (eventType === "messageStopEvent") {
                stopReason = mergeKiroStopReason(
                  stopReason,
                  normalizeKiroStopReason(
                    eventPayload.stopReason ?? eventPayload.stop_reason,
                  ),
                );
              } else if (eventType === "contextUsageEvent") {
                if (typeof eventPayload.contextUsagePercentage === "number") {
                  contextUsagePercentage = eventPayload.contextUsagePercentage;
                }
              } else if (
                eventType === "metricsEvent" ||
                eventType === "meteringEvent" ||
                eventType === "metadataEvent" ||
                eventType === "MetadataEvent"
              ) {
                const usagePayload = asKiroRecord(eventPayload.usage);
                const tokenUsagePayload = asKiroRecord(eventPayload.tokenUsage);
                const usageSources = [
                  eventPayload,
                  ...(usagePayload ? [usagePayload] : []),
                  ...(tokenUsagePayload ? [tokenUsagePayload] : []),
                ];
                const inputTokens = firstKiroMetric(usageSources, [
                  "inputTokens",
                  "input_tokens",
                  "promptTokens",
                  "prompt_tokens",
                ]);
                const outputTokens = firstKiroMetric(usageSources, [
                  "outputTokens",
                  "output_tokens",
                  "completionTokens",
                  "completion_tokens",
                ]);
                const cacheReadTokens = firstKiroMetric(usageSources, [
                  "cacheReadTokens",
                  "cache_read_tokens",
                  "cacheReadInputTokens",
                  "cache_read_input_tokens",
                  "cachedTokens",
                ]);
                const cacheWriteTokens = firstKiroMetric(usageSources, [
                  "cacheCreationTokens",
                  "cache_creation_tokens",
                  "cacheWriteTokens",
                  "cache_write_tokens",
                  "cacheWriteInputTokens",
                  "cacheCreationInputTokens",
                  "cache_creation_input_tokens",
                ]);
                if (inputTokens !== undefined) promptTokens = inputTokens;
                if (outputTokens !== undefined) completionTokens = outputTokens;
                if (cacheReadTokens !== undefined) {
                  cachedTokens = Math.max(cachedTokens, cacheReadTokens);
                }
                if (cacheWriteTokens !== undefined) {
                  cacheCreationTokens = Math.max(
                    cacheCreationTokens,
                    cacheWriteTokens,
                  );
                }
                if (/^metadataevent$/i.test(eventType)) {
                  stopReason = mergeKiroStopReason(
                    stopReason,
                    normalizeKiroStopReason(
                      eventPayload.stopReason ?? eventPayload.stop_reason,
                    ),
                  );
                }
              }
            }

            const toolCalls: NativeToolCall[] = accumulatedTools.map((t) => {
              let parsedArgs: Record<string, unknown> = {};
              try {
                parsedArgs = JSON.parse(t.rawArgs || "{}");
              } catch {
                parsedArgs = { raw: t.rawArgs };
              }
              return {
                id: t.id,
                name: t.name,
                args: parsedArgs,
                rawArguments: t.rawArgs,
              };
            });

            reasoning.finish();
            const hasReasoningEvidence = Boolean(
              reasoning.text.trim() || reasoning.signature || reasoning.redactedContent,
            );
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
            if (
              !fullText.trim() &&
              !hasReasoningEvidence &&
              toolCalls.length === 0
            ) {
              throw new ProviderError("Kiro completed without a visible answer.");
            }
            if (toolCalls.length === 0 && ["...", "…"].includes(fullText.trim())) {
              throw new ProviderError("Kiro completed without a visible answer.");
            }
            if (reasoning.opaque && (fullText.trim() || toolCalls.length > 0)) {
              pendingStreamEvents.push({
                kind: "reasoning",
                text: kiroPrivateReasoningNote({
                  model: upstream,
                  effort: sentKiroReasoningEffort(
                    asKiroRecord(body.additionalModelRequestFields),
                  ),
                  signatureChars: reasoning.signature.length,
                }),
              });
            }

            if (stopDisposition === "length") {
              finishReason = "length";
            } else if (toolCalls.length > 0) {
              finishReason = "tool_calls";
            }

            const advertisedWindow =
              kiroModelCatalog().find((info) => info.modelId === upstream)
                ?.maxInputTokens;
            const catalogWindow =
              advertisedWindow !== undefined &&
              Number.isFinite(advertisedWindow) &&
              advertisedWindow > 0
                ? Math.floor(advertisedWindow)
                : undefined;
            const estimatedPromptTokens = providerRatioPromptTokens(
              contextUsagePercentage,
              catalogWindow ?? modelContextWindow(upstream, "kiro"),
            );

            const tokenUsage: TokenUsage | undefined =
              promptTokens > 0 || completionTokens > 0
                ? {
                    promptTokens,
                    completionTokens,
                    totalTokens: promptTokens + completionTokens,
                    exact: true,
                    cachedPromptTokens: cachedTokens > 0 ? cachedTokens : undefined,
                    cacheCreationTokens:
                      cacheCreationTokens > 0 ? cacheCreationTokens : undefined,
                    uncachedPromptTokens:
                      cachedTokens > 0
                        ? Math.max(0, promptTokens - cachedTokens)
                        : promptTokens,
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
              ? {
                  ...tokenUsage,
                  ...(usageCharges.length > 0 ? { charges: usageCharges } : {}),
                }
              : usageCharges.length > 0
                ? {
                    promptTokens: 0,
                    promptTokensKnown: false,
                    completionTokens: 0,
                    totalTokens: 0,
                    exact: false,
                    charges: usageCharges,
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

            for (const event of pendingStreamEvents) {
              if (event.kind === "token") {
                onToken(event.text);
              } else if (event.kind === "reasoning") {
                emitStreamReasoningDelta(request.onStreamEvent, event.text);
              } else {
                request.onToolCallDelta?.(event.delta);
              }
            }

            return {
              text: fullText,
              provider: "kiro",
              model: requestedModel,
              api: "kiro-eventstream",
              finishReason,
              toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
              usage,
              reasoningArtifacts: reasoningResult.artifacts.length > 0
                ? reasoningResult.artifacts
                : undefined,
              reasoningBlock: reasoningResult.block,
            };
          } catch (err) {
            if (request.signal?.aborted) {
              completeGenerationAttempt("cancelled");
              throw err;
            }
            const status = err instanceof ProviderError ? err.status : undefined;
            completeGenerationAttempt("failure", undefined, status);
            if (
              err instanceof ProviderError &&
              (
                status === 400 ||
                status === undefined ||
                (status === 401 && Boolean(credential.refreshToken))
              )
            ) {
              throw err;
            }
            lastError = err instanceof Error ? err : new Error(String(err));
          }
        }

        throw lastError ?? new Error("All Kiro endpoints failed");
      },
      onStatus,
    );
  },
};
