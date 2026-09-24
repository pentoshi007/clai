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
  assertValidAwsRegion,
  decodeKiroKey,
  encodeKiroKey,
  getKiroUsageLimits,
  isKiroOAuthToken,
  listKiroModelsDetailed,
  maybeRefreshKiroCredential,
  type KiroCredential,
  type KiroModelInfo,
  type KiroUsageLimits,
} from "./kiro-auth.js";
import { currentSessionAffinity } from "./session-affinity.js";
import { generationFetch } from "./operation-usage.js";
import { learnModelVisionCapability } from "./capability/vision-registry.js";
import { emitStreamReasoningDelta } from "./stream-events.js";
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

function crc32(buf: Buffer | Uint8Array, start = 0, end = buf.length): number {
  let crc = 0xffffffff;
  for (let i = start; i < end; i++) {
    crc = (crc >>> 8) ^ CRC32_TABLE[(crc ^ buf[i]!) & 0xff]!;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function parseHeaders(buf: Buffer): Record<string, unknown> {
  const headers: Record<string, unknown> = {};
  let offset = 0;
  while (offset < buf.length) {
    const nameLen = buf.readUInt8(offset);
    offset += 1;
    const name = buf.toString("utf8", offset, offset + nameLen);
    offset += nameLen;
    const type = buf.readUInt8(offset);
    offset += 1;
    if (type === 0) {
      headers[name] = true;
    } else if (type === 1) {
      headers[name] = false;
    } else if (type === 2) {
      headers[name] = buf.readInt8(offset);
      offset += 1;
    } else if (type === 3) {
      headers[name] = buf.readInt16BE(offset);
      offset += 2;
    } else if (type === 4) {
      headers[name] = buf.readInt32BE(offset);
      offset += 4;
    } else if (type === 5) {
      headers[name] = buf.readBigInt64BE(offset);
      offset += 8;
    } else if (type === 6) {
      const len = buf.readUInt16BE(offset);
      offset += 2;
      headers[name] = buf.subarray(offset, offset + len);
      offset += len;
    } else if (type === 7) {
      const len = buf.readUInt16BE(offset);
      offset += 2;
      headers[name] = buf.toString("utf8", offset, offset + len);
      offset += len;
    } else if (type === 8) {
      headers[name] = new Date(Number(buf.readBigInt64BE(offset)));
      offset += 8;
    } else if (type === 9) {
      headers[name] = buf.subarray(offset, offset + 16).toString("hex");
      offset += 16;
    } else {
      break;
    }
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
          buffer = buffer.subarray(1);
          continue;
        }

        const headersLength = buffer.readUInt32BE(4);
        const preludeCrc = buffer.readUInt32BE(8);
        const expectedPreludeCrc = crc32(buffer, 0, 8);

        if (preludeCrc !== expectedPreludeCrc) {
          buffer = buffer.subarray(1);
          continue;
        }

        if (buffer.length < totalLength) {
          break;
        }

        const messageCrc = buffer.readUInt32BE(totalLength - 4);
        const expectedMessageCrc = crc32(buffer, 0, totalLength - 4);
        if (messageCrc !== expectedMessageCrc) {
          buffer = buffer.subarray(totalLength);
          continue;
        }

        const headersBuffer = buffer.subarray(12, 12 + headersLength);
        const payloadBuffer = buffer.subarray(12 + headersLength, totalLength - 4);
        buffer = buffer.subarray(totalLength);

        const headers = parseHeaders(headersBuffer);
        let payload: Record<string, unknown> = {};
        if (payloadBuffer.length > 0) {
          try {
            const raw = payloadBuffer.toString("utf8");
            payload = JSON.parse(raw);
          } catch {
            payload = { raw: payloadBuffer.toString("utf8") };
          }
        }

        yield { headers, payload };
      }
    }
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

function isAdaptiveThinkingModel(model: string): boolean {
  return /^claude/i.test(model);
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
  const credential = resolveKiroCredential(auth);
  try {
    return await run(credential);
  } catch (error) {
    const status = error instanceof ProviderError ? error.status : undefined;
    if (status !== 401 && status !== 403) throw error;

    onStatus?.("ℹ Kiro authentication expired — attempting token refresh");
    const oldKey = auth.apiKey ?? "";
    const refreshedKey = await maybeRefreshKiroCredential(
      oldKey,
      auth.refreshToken,
    );
    if (!refreshedKey || refreshedKey === oldKey) {
      throw error;
    }

    await replaceProviderKey("kiro", oldKey, refreshedKey).catch(() => {});
    auth.apiKey = refreshedKey;
    const newCredential = resolveKiroCredential({ ...auth, apiKey: refreshedKey });
    onStatus?.("ℹ Kiro token refreshed — retrying request");
    return run(newCredential);
  }
}

function getCandidateEndpoints(
  credential: KiroCredential,
): string[] {
  const region = assertValidAwsRegion(credential.region);
  const qUrl = `https://q.${region}.amazonaws.com/generateAssistantResponse`;
  const cwUrl = `https://codewhisperer.${region}.amazonaws.com/generateAssistantResponse`;
  const rtUrl = `https://runtime.${region}.kiro.dev/generateAssistantResponse`;

  if (credential.authMethod === "api_key") {
    return [qUrl, cwUrl, rtUrl];
  }
  return [cwUrl, rtUrl, qUrl];
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
  return tools.map((t) => ({
    toolSpecification: {
      name: sanitizeToolName(t.wireName || t.name),
      description: (t.description || "").slice(0, 10237),
      inputSchema: {
        json: t.parameters as unknown as Record<string, unknown>,
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

function buildKiroRequestBody(
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

  const nonSystemMessages: ChatMessage[] = [];
  for (const msg of request.messages) {
    if (msg.role === "system") {
      if (msg.content.trim()) systemParts.push(msg.content.trim());
    } else {
      nonSystemMessages.push(msg);
    }
  }

  const systemPrompt = systemParts.join("\n\n").trim();

  interface NormalizedTurn {
    role: "user" | "assistant";
    content: string;
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
        if (toolUses.length > 0) {
          last.toolUses = [...(last.toolUses ?? []), ...toolUses];
        }
      } else {
        turns.push({
          role: "assistant",
          content: msg.content || "",
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

  const kiroTools = formatKiroTools(request.tools);

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

  const wantsThinking = thinking || request.thinking?.enabled === true;
  const effort = kiroEffortString(request.thinking?.effort) || "high";
  if (wantsThinking && isAdaptiveThinkingModel(upstreamModel)) {
    const budget = KIRO_THINKING_BUDGET[effort] ?? 16000;
    const directive = `<thinking_mode>enabled</thinking_mode><max_thinking_length>${budget}</max_thinking_length>`;
    const uim = (payload.conversationState as Record<string, unknown>)
      .currentMessage as Record<string, unknown>;
    const msg = uim.userInputMessage as Record<string, unknown>;
    msg.content = `${directive}\n\n${String(msg.content ?? "")}`;
  }

  return payload;
}

let cachedKiroModels: string[] | null = null;
let cachedKiroModelInfo: readonly KiroModelInfo[] = [];
let lastKiroModelFetch = 0;
const MODEL_CACHE_TTL_MS = 30 * 60 * 1000;

export function kiroModelCatalog(): readonly KiroModelInfo[] {
  return cachedKiroModelInfo;
}

export function resetKiroModelCacheForTesting(): void {
  cachedKiroModels = null;
  cachedKiroModelInfo = [];
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
    const now = Date.now();
    if (cachedKiroModels && now - lastKiroModelFetch < MODEL_CACHE_TTL_MS) {
      return cachedKiroModels;
    }

    try {
      const credential = resolveKiroCredential(auth);
      const infos = await listKiroModelsDetailed(credential);
      if (infos.length > 0) {
        cachedKiroModelInfo = infos;
        for (const info of infos) {
          if (info.supportsImages !== undefined) {
            learnModelVisionCapability("kiro", info.modelId, info.supportsImages);
          }
        }
        const variants = withKiroVariants(infos.map((info) => info.modelId));
        cachedKiroModels = variants;
        lastKiroModelFetch = now;
        return variants;
      }
    } catch {}

    return cachedKiroModels ?? [...kiroFallbackModels];
  },

  async ping(auth: ProviderAuth): Promise<void> {
    const credential = resolveKiroCredential(auth);
    const region = assertValidAwsRegion(credential.region);
    const params = new URLSearchParams({ origin: "AI_EDITOR" });
    const endpoint = `https://q.${region}.amazonaws.com/ListAvailableModels?${params.toString()}`;

    const headers: Record<string, string> = {
      Accept: "application/json",
      "User-Agent": "AWS-SDK-JS/3.0.0 kiro-ide/1.0.0",
      "X-Amz-User-Agent": "aws-sdk-js/3.0.0 kiro-ide/1.0.0",
    };

    if (credential.authMethod === "api_key" && credential.apiKey) {
      headers["Authorization"] = `Bearer ${credential.apiKey}`;
      headers["TokenType"] = "API_KEY";
    } else if (credential.accessToken) {
      headers["Authorization"] = `Bearer ${credential.accessToken}`;
      if (credential.authMethod === "external_idp") {
        headers["TokenType"] = "EXTERNAL_IDP";
      }
    }

    const response = await fetch(endpoint, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(15_000),
    });

    if (!response.ok) {
      throw new ProviderError(
        `Kiro AI ping failed (HTTP ${response.status}). Run \`clai auth kiro\` to sign in.`,
        response.status,
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
        const body = buildKiroRequestBody(
          request,
          credential,
          upstream,
          agentic,
          thinking,
        );
        const endpoints = getCandidateEndpoints(credential);

        let lastError: Error | undefined;

        for (const endpoint of endpoints) {
          try {
            const headers: Record<string, string> = {
              "Content-Type": "application/json",
              Accept: "application/vnd.amazon.eventstream",
              "Amz-Sdk-Request": "attempt=1; max=3",
              "Amz-Sdk-Invocation-Id": randomUUID(),
              "User-Agent": "aws-sdk-js/3.0.0 kiro-ide/1.0.0",
              "X-Amz-User-Agent": "aws-sdk-js/3.0.0 kiro-ide/1.0.0",
              "x-amzn-kiro-agent-mode": "vibe",
              "x-amzn-codewhisperer-optout": "true",
              "x-amzn-codewhisperer-machine-id": "kiro-desktop",
            };

            if (endpoint.includes("codewhisperer")) {
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

            const response = await generationFetch(endpoint, {
              method: "POST",
              headers,
              body: JSON.stringify(body),
              ...(request.signal ? { signal: request.signal } : {}),
            });

            if (!response.ok) {
              const errorText = await response.text().catch(() => "");
              if (response.status === 401 || response.status === 403) {
                throw new ProviderError(
                  `Kiro authentication failed (${response.status}): ${errorText}`,
                  response.status,
                );
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
            let reasoningText = "";
            let insideThinkingTag = false;
            let finishReason: string = "stop";

            interface PartialToolCall {
              id: string;
              name: string;
              rawArgs: string;
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
              const eventType =
                (typeof frame.headers[":event-type"] === "string"
                  ? frame.headers[":event-type"]
                  : undefined) ||
                Object.keys(frame.payload).find((k) => k.endsWith("Event")) ||
                "";

              const eventPayload =
                (frame.payload[eventType] as Record<string, unknown> | undefined) ||
                frame.payload;

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

                  if (reasoningChunk) {
                    reasoningText += reasoningChunk;
                    emitStreamReasoningDelta(request.onStreamEvent, reasoningChunk);
                  }
                  if (visibleChunk) {
                    fullText += visibleChunk;
                    onToken(visibleChunk);
                  }
                }
              } else if (
                eventType === "reasoningContentEvent" ||
                eventType.includes("Reasoning")
              ) {
                const chunk =
                  typeof eventPayload.content === "string"
                    ? eventPayload.content
                    : "";
                if (chunk) {
                  reasoningText += chunk;
                  emitStreamReasoningDelta(request.onStreamEvent, chunk);
                }
              } else if (eventType === "codeEvent") {
                const chunk =
                  typeof eventPayload.content === "string"
                    ? eventPayload.content
                    : "";
                if (chunk) {
                  fullText += chunk;
                  onToken(chunk);
                }
              } else if (eventType === "toolUseEvent") {
                const toolId =
                  typeof eventPayload.toolUseId === "string"
                    ? eventPayload.toolUseId
                    : `tool_${accumulatedTools.length + 1}`;
                const name =
                  typeof eventPayload.name === "string" ? eventPayload.name : "";
                const input = eventPayload.input;

                let existing = accumulatedTools.find((t) => t.id === toolId);
                if (!existing) {
                  existing = { id: toolId, name, rawArgs: "" };
                  accumulatedTools.push(existing);
                  currentToolIndex = accumulatedTools.length - 1;
                }

                let chunkBytes = 0;
                if (typeof input === "string") {
                  existing.rawArgs += input;
                  chunkBytes = Buffer.byteLength(input, "utf8");
                } else if (input && typeof input === "object") {
                  existing.rawArgs = JSON.stringify(input);
                  chunkBytes = Buffer.byteLength(existing.rawArgs, "utf8");
                }

                if (name && !existing.name) {
                  existing.name = name;
                }

                const delta: ToolCallStreamDelta = {
                  index: currentToolIndex,
                  id: existing.id,
                  name: existing.name,
                  argumentsBytes: chunkBytes,
                };
                request.onToolCallDelta?.(delta);
                finishReason = "tool_calls";
              } else if (eventType === "messageStopEvent") {
                const stop =
                  typeof eventPayload.stopReason === "string"
                    ? eventPayload.stopReason
                    : "";
                if (stop) {
                  finishReason =
                    stop === "tool_use" || stop === "tool_calls"
                      ? "tool_calls"
                      : stop === "max_tokens" || stop === "length"
                        ? "length"
                        : "stop";
                }
              } else if (eventType === "contextUsageEvent") {
                if (typeof eventPayload.contextUsagePercentage === "number") {
                  contextUsagePercentage = eventPayload.contextUsagePercentage;
                }
              } else if (
                eventType === "metricsEvent" ||
                eventType === "meteringEvent"
              ) {
                if (typeof eventPayload.inputTokens === "number") {
                  promptTokens = eventPayload.inputTokens;
                }
                if (typeof eventPayload.outputTokens === "number") {
                  completionTokens = eventPayload.outputTokens;
                }
                if (typeof eventPayload.cachedTokens === "number") {
                  cachedTokens = eventPayload.cachedTokens;
                }
                if (typeof eventPayload.cacheReadInputTokens === "number") {
                  cachedTokens = Math.max(cachedTokens, eventPayload.cacheReadInputTokens);
                }
                if (typeof eventPayload.cacheWriteInputTokens === "number") {
                  cacheCreationTokens = eventPayload.cacheWriteInputTokens;
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

            if (toolCalls.length > 0) {
              finishReason = "tool_calls";
            }

            const catalogWindow =
              kiroModelCatalog().find((info) => info.modelId === upstream)
                ?.maxInputTokens ?? 200_000;

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
                : contextUsagePercentage !== undefined
                  ? {
                      promptTokens: Math.round(
                        (contextUsagePercentage / 100) * catalogWindow,
                      ),
                      completionTokens: 0,
                      totalTokens: Math.round(
                        (contextUsagePercentage / 100) * catalogWindow,
                      ),
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

            return {
              text: fullText,
              provider: "kiro",
              model: requestedModel,
              api: "kiro-eventstream",
              finishReason,
              toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
              usage,
              reasoningBlock: reasoningText.trim()
                ? { text: reasoningText.trim() }
                : undefined,
            };
          } catch (err) {
            if (err instanceof ProviderError && (err.status === 401 || err.status === 403 || err.status === 400)) {
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
