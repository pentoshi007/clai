import { createHash, randomUUID } from "node:crypto";
import type {
  ChatMessage,
  CompletionRequest,
  NativeToolCall,
  ToolDefinition,
} from "../types.js";
import {
  createReasoningArtifactReplayTarget,
  reasoningArtifactSignature,
  reasoningArtifactText,
  reasoningArtifactsForMessage,
  selectReasoningArtifactsForReplay,
} from "./reasoning-artifacts.js";

/**
 * Wire identity of kiro-cli 3.5.0. The Kiro backend gates behaviour on the
 * client identity, so these values are copied verbatim from the shipped client
 * instead of being derived.
 */
export const KIRO_CLI_VERSION = "3.5.0";
export const KIRO_KAS_VERSION = "0.66.119";
export const KIRO_CLI_ORIGIN = "KIRO_CLI";
export const KIRO_CLI_APP_TAG = "app/AmazonQ-For-CLI";
export const KIRO_AGENT_MODE = "vibe";
export const KIRO_MODE_IDENTIFIER = "default-v2";

export type KiroClientSurface = "kiro-cli" | "kiro-cli-non-interactive";

export function kiroCliUserAgent(
  surface: KiroClientSurface = "kiro-cli",
  platform: string = process.platform,
): string {
  return [
    `KiroCLI/${KIRO_CLI_VERSION}`,
    `KAS/${KIRO_KAS_VERSION}`,
    `os/${platform}`,
    `md/appVersion-${KIRO_CLI_VERSION}`,
    KIRO_CLI_APP_TAG,
    `acp-client/${surface}`,
  ].join(" ");
}

function uuidFromHex(hex: string): string {
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

export function kiroConversationId(seedContent: string, affinity?: string): string {
  const seed = affinity ? `kiro-${affinity}` : seedContent.trim();
  if (!seed) return randomUUID();
  return uuidFromHex(
    createHash("md5").update(seed.slice(0, 4000)).digest("hex"),
  );
}

export function kiroAgentContinuationId(conversationId: string): string {
  return uuidFromHex(
    createHash("md5").update(`continuation-${conversationId}`).digest("hex"),
  );
}

export function sanitizeKiroToolName(name: string): string {
  return name.slice(0, 64).replace(/[^a-zA-Z0-9_-]/g, "_") || "tool";
}

export interface KiroToolSpecification {
  toolSpecification: {
    name: string;
    description: string;
    inputSchema: { json: Record<string, unknown> };
  };
}

export function formatKiroTools(tools?: ToolDefinition[]): KiroToolSpecification[] {
  if (!tools || tools.length === 0) return [];
  return tools.map((tool) => ({
    toolSpecification: {
      name: sanitizeKiroToolName(tool.wireName || tool.name),
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

export interface KiroToolResult {
  toolUseId: string;
  content: Array<{ text: string }>;
  status: "success" | "error";
}

export interface KiroToolUse {
  toolUseId: string;
  name: string;
  input: Record<string, unknown>;
}

export interface KiroImage {
  format: string;
  source: { bytes: string };
}

export interface KiroTurn {
  role: "user" | "assistant";
  content: string;
  reasoningContent?:
    | { reasoningText: { text: string; signature: string } }
    | { redactedContent: string }
    | undefined;
  toolCalls?: NativeToolCall[] | undefined;
  toolResults?: KiroToolResult[] | undefined;
  toolUses?: KiroToolUse[] | undefined;
  images?: KiroImage[] | undefined;
}

export interface KiroNormalizedConversation {
  systemPrompt: string;
  turns: KiroTurn[];
}

const KIRO_AGENTIC_INSTRUCTION =
  "When modifying or creating files, keep writes concise:\n- Maximum 350 lines per file write/tool call (recommended 300 lines or fewer).\n- Prefer targeted, incremental edits instead of rewriting entire files.\n- For large files, write or append in chunks across multiple tool calls.";

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function replayReasoningContent(
  message: ChatMessage,
  request: CompletionRequest,
  upstreamModel: string,
): KiroTurn["reasoningContent"] {
  const replayTarget = createReasoningArtifactReplayTarget({
    provider: "kiro",
    model: upstreamModel,
    dialect: "kiro-eventstream",
  });
  const replayed = request.forceReasoningReplay === false
    ? []
    : selectReasoningArtifactsForReplay({
        artifacts: reasoningArtifactsForMessage(message),
        target: replayTarget,
        context: {
          hasToolCalls: Boolean(message.toolCalls?.length),
          forceScope: request.forceReasoningReplay === true,
        },
        observe: request.onReasoningArtifactReplayDecision,
      });
  const signed = replayed.find((artifact) =>
    reasoningArtifactText(artifact) && reasoningArtifactSignature(artifact)
  );
  if (signed) {
    return {
      reasoningText: {
        text: reasoningArtifactText(signed)!,
        signature: reasoningArtifactSignature(signed)!,
      },
    };
  }
  const redacted = replayed.find((artifact) => {
    const raw = asRecord(artifact.raw);
    return artifact.kind === "encrypted" && typeof raw?.redactedContent === "string";
  });
  const redactedRaw = redacted ? asRecord(redacted.raw) : undefined;
  return typeof redactedRaw?.redactedContent === "string"
    ? { redactedContent: redactedRaw.redactedContent }
    : undefined;
}

function appendUserTurn(turns: KiroTurn[], message: ChatMessage): void {
  const images = (message.images ?? []).map((image) => ({
    format: imageFormatFromMediaType(image.mediaType),
    source: { bytes: image.dataBase64 },
  }));
  const last = turns[turns.length - 1];
  if (last?.role === "user") {
    if (message.content) {
      last.content = last.content ? `${last.content}\n\n${message.content}` : message.content;
    }
    if (images.length > 0) last.images = [...(last.images ?? []), ...images];
    return;
  }
  turns.push({
    role: "user",
    content: message.content || "",
    images: images.length > 0 ? images : undefined,
  });
}

function appendAssistantTurn(
  turns: KiroTurn[],
  message: ChatMessage,
  request: CompletionRequest,
  upstreamModel: string,
): void {
  const reasoningContent = replayReasoningContent(message, request, upstreamModel);
  const toolUses = (message.toolCalls ?? [])
    .filter((call) => call.id)
    .map((call) => ({
      toolUseId: call.id,
      name: sanitizeKiroToolName(call.name),
      input: call.args ?? {},
    }));
  const last = turns[turns.length - 1];
  if (last?.role === "assistant") {
    if (message.content) {
      last.content = last.content ? `${last.content}\n\n${message.content}` : message.content;
    }
    if (reasoningContent && !last.reasoningContent) last.reasoningContent = reasoningContent;
    if (toolUses.length > 0) last.toolUses = [...(last.toolUses ?? []), ...toolUses];
    return;
  }
  turns.push({
    role: "assistant",
    content: message.content || "",
    reasoningContent,
    toolUses: toolUses.length > 0 ? toolUses : undefined,
  });
}

function appendToolTurn(turns: KiroTurn[], message: ChatMessage): void {
  const toolResult: KiroToolResult = {
    toolUseId: message.toolCallId || "tool_result",
    content: [{ text: message.content || "" }],
    status: message.ok === false ? "error" : "success",
  };
  const last = turns[turns.length - 1];
  if (last?.role === "user") {
    last.toolResults = [...(last.toolResults ?? []), toolResult];
    return;
  }
  turns.push({ role: "user", content: "", toolResults: [toolResult] });
}

/**
 * Normalizes clai's chat history into the turn list kiro-cli sends. The leading
 * system message becomes the request-level system prompt; later system messages
 * are demoted into user turns so the model still sees them in order.
 */
export function normalizeKiroTurns(
  request: CompletionRequest,
  upstreamModel: string,
  options: { agentic?: boolean | undefined } = {},
): KiroNormalizedConversation {
  const systemParts: string[] = [];
  if (options.agentic) systemParts.push(KIRO_AGENTIC_INSTRUCTION);

  let sawLeadingSystem = false;
  const turns: KiroTurn[] = [];

  for (const message of request.messages) {
    if (message.role === "system") {
      if (!sawLeadingSystem) {
        sawLeadingSystem = true;
        if (message.content.trim()) systemParts.push(message.content.trim());
        continue;
      }
      if (!message.content.trim()) continue;
      appendUserTurn(turns, {
        ...message,
        role: "user",
        content: message.content.startsWith("[SYSTEM]")
          ? message.content
          : `[SYSTEM]\n${message.content}`,
      });
      continue;
    }
    if (message.role === "user") appendUserTurn(turns, message);
    else if (message.role === "assistant") {
      appendAssistantTurn(turns, message, request, upstreamModel);
    } else appendToolTurn(turns, message);
  }

  if (turns.length === 0) turns.push({ role: "user", content: "continue" });
  if (turns[turns.length - 1]?.role !== "user") {
    turns.push({ role: "user", content: "continue" });
  }
  for (const turn of turns) {
    if (turn.role !== "user" || turn.content.trim()) continue;
    turn.content = turn.toolResults?.length ? "Tool results provided." : "continue";
  }

  return { systemPrompt: systemParts.join("\n\n").trim(), turns };
}

export interface KiroConversationState {
  conversationId: string;
  rootConversationId: string;
  agentContinuationId: string;
  agentTaskType: string;
  chatTriggerType: "MANUAL";
  history: Array<Record<string, unknown>>;
  currentMessage: Record<string, unknown>;
}

export function buildKiroConversationState(input: {
  conversation: KiroNormalizedConversation;
  modelId: string;
  origin?: string | undefined;
  conversationId: string;
  agentTaskType?: string | undefined;
  tools?: KiroToolSpecification[] | undefined;
  /** Legacy endpoint carries the system prompt inline; `/v1/responses` uses `instructions`. */
  mergeSystemPrompt?: boolean | undefined;
  userTurnPrefix?: string | undefined;
}): KiroConversationState {
  const { conversation, modelId, conversationId } = input;
  const origin = input.origin ?? KIRO_CLI_ORIGIN;
  const turns = input.mergeSystemPrompt || input.userTurnPrefix
    ? conversation.turns.map((turn) => {
        if (turn.role !== "user") return turn;
        const prefix = [input.userTurnPrefix, input.mergeSystemPrompt ? conversation.systemPrompt : ""]
          .filter((part): part is string => Boolean(part))
          .join("\n\n");
        if (!prefix) return turn;
        return { ...turn, content: turn.content ? `${prefix}\n\n${turn.content}` : prefix };
      })
    : conversation.turns;

  const history: Array<Record<string, unknown>> = [];
  for (let index = 0; index < turns.length - 1; index += 1) {
    const turn = turns[index]!;
    if (turn.role === "user") {
      const context: Record<string, unknown> = {};
      if (turn.toolResults?.length) context.toolResults = turn.toolResults;
      history.push({
        userInputMessage: {
          content: turn.content,
          modelId,
          origin,
          userInputMessageContext: context,
          ...(turn.images?.length ? { images: turn.images } : {}),
        },
      });
      continue;
    }
    history.push({
      assistantResponseMessage: {
        content: turn.content,
        ...(turn.reasoningContent ? { reasoningContent: turn.reasoningContent } : {}),
        ...(turn.toolUses?.length ? { toolUses: turn.toolUses } : {}),
      },
    });
  }

  const lastTurn = turns[turns.length - 1]!;
  const currentContext: Record<string, unknown> = {};
  if (input.tools?.length) currentContext.tools = input.tools;
  if (lastTurn.toolResults?.length) currentContext.toolResults = lastTurn.toolResults;

  return {
    conversationId,
    rootConversationId: conversationId,
    agentContinuationId: kiroAgentContinuationId(conversationId),
    agentTaskType: input.agentTaskType ?? KIRO_AGENT_MODE,
    chatTriggerType: "MANUAL",
    history,
    currentMessage: {
      userInputMessage: {
        content: lastTurn.content,
        modelId,
        origin,
        userInputMessageContext: currentContext,
        ...(lastTurn.images?.length ? { images: lastTurn.images } : {}),
      },
    },
  };
}

export type KiroResponsesInputItem =
  | { role: "user"; content: string | Array<Record<string, unknown>> }
  | { role: "assistant"; content: string }
  | { type: "function_call"; call_id: string; name: string; arguments: string }
  | { type: "function_call_output"; call_id: string; output: string }
  | { type: "reasoning"; summary: []; encrypted_content: string };

function reasoningEnvelope(content: NonNullable<KiroTurn["reasoningContent"]>): string {
  if ("redactedContent" in content && content.redactedContent) {
    return JSON.stringify({ redactedContent: content.redactedContent });
  }
  if ("reasoningText" in content && content.reasoningText) {
    return JSON.stringify({
      reasoningText: {
        text: content.reasoningText.text,
        ...(content.reasoningText.signature
          ? { signature: content.reasoningText.signature }
          : {}),
      },
    });
  }
  return "";
}

function turnToResponsesInput(
  turn: KiroTurn,
  userTurnPrefix?: string | undefined,
): KiroResponsesInputItem[] {
  const items: KiroResponsesInputItem[] = [];
  if (turn.role === "user") {
    for (const result of turn.toolResults ?? []) {
      items.push({
        type: "function_call_output",
        call_id: result.toolUseId,
        output: result.content.map((part) => part.text ?? "").join("\n"),
      });
    }
    const content = userTurnPrefix
      ? turn.content
        ? `${userTurnPrefix}\n\n${turn.content}`
        : userTurnPrefix
      : turn.content;
    const parts: Array<Record<string, unknown>> = [];
    if (content) parts.push({ type: "input_text", text: content });
    for (const image of turn.images ?? []) {
      if (!image.source.bytes) continue;
      parts.push({
        type: "input_image",
        image_url: `data:image/${image.format.toLowerCase()};base64,${image.source.bytes}`,
      });
    }
    if (parts.length > 0) {
      const textOnly = parts.length === 1 && parts[0]?.type === "input_text";
      items.push({ role: "user", content: textOnly ? content : parts });
    }
    return items;
  }

  if (turn.reasoningContent) {
    const encrypted = reasoningEnvelope(turn.reasoningContent);
    if (encrypted) {
      items.push({ type: "reasoning", summary: [], encrypted_content: encrypted });
    }
  }
  if (turn.content) items.push({ role: "assistant", content: turn.content });
  for (const call of turn.toolUses ?? []) {
    items.push({
      type: "function_call",
      call_id: call.toolUseId,
      name: call.name,
      arguments: JSON.stringify(call.input ?? {}),
    });
  }
  return items;
}

export interface KiroCreateResponseBody {
  model: string;
  input: KiroResponsesInputItem[];
  tools?: Array<Record<string, unknown>>;
  stream: true;
  origin: string;
  profileArn?: string;
  metadata: Record<string, string>;
  reasoning?: Record<string, string>;
}

function responsesTools(
  tools: KiroToolSpecification[] | undefined,
): Array<Record<string, unknown>> | undefined {
  if (!tools?.length) return undefined;
  return tools.map((tool) => ({
    type: "function",
    name: tool.toolSpecification.name,
    description: tool.toolSpecification.description,
    parameters: tool.toolSpecification.inputSchema.json,
  }));
}

function reasoningField(
  fields: Record<string, unknown> | undefined,
): Record<string, string> | undefined {
  const thinking = asRecord(fields?.thinking);
  const type = typeof thinking?.type === "string" && thinking.type ? thinking.type : undefined;
  const display =
    typeof thinking?.display === "string" && thinking.display ? thinking.display : undefined;
  let effort: string | undefined;
  for (const key of ["output_config", "reasoning"]) {
    const holder = asRecord(fields?.[key]);
    if (typeof holder?.effort === "string" && holder.effort) {
      effort = holder.effort;
      break;
    }
  }
  if (!type && !effort && !display) return undefined;
  return {
    ...(type ? { type } : {}),
    ...(effort ? { effort } : {}),
    ...(display ? { summary: display } : {}),
  };
}

/**
 * The `instructions` field is gated per account (`unsupported_parameter` for
 * most users), so the system prompt rides at the head of the first user turn —
 * the same place kiro-cli puts its own system prompt in the conversation.
 */
function withSystemPrompt(
  items: KiroResponsesInputItem[],
  systemPrompt: string,
): KiroResponsesInputItem[] {
  if (!systemPrompt) return items;
  const index = items.findIndex((item) => "role" in item && item.role === "user");
  if (index === -1) return [{ role: "user", content: systemPrompt }, ...items];
  const target = items[index]!;
  if (!("role" in target) || target.role !== "user") return items;
  const content = typeof target.content === "string"
    ? `${systemPrompt}\n\n${target.content}`
    : [{ type: "input_text", text: systemPrompt }, ...target.content];
  return [
    ...items.slice(0, index),
    { role: "user", content },
    ...items.slice(index + 1),
  ];
}

/**
 * Builds the `POST /v1/responses` body used by the kiro-cli 3.5.0 v3 engine.
 * The conversation state is the same normalized turn list the legacy endpoint
 * takes; this is a pure re-projection of it, exactly as the shipped client does.
 */
export function buildKiroCreateResponseBody(input: {
  conversation: KiroNormalizedConversation;
  conversationState: KiroConversationState;
  modelId: string;
  origin?: string | undefined;
  profileArn?: string | undefined;
  agentMode?: string | undefined;
  modeIdentifier?: string | undefined;
  tools?: KiroToolSpecification[] | undefined;
  additionalModelRequestFields?: Record<string, unknown> | undefined;
  userTurnPrefix?: string | undefined;
}): KiroCreateResponseBody {
  const state = input.conversationState;
  const metadata: Record<string, string> = {};
  if (input.agentMode) metadata["kiro:agent_mode"] = input.agentMode;
  if (input.modeIdentifier) metadata["kiro:mode_identifier"] = input.modeIdentifier;
  if (state.agentTaskType === "spec") metadata["kiro:agent_task_type"] = "spec";
  metadata["kiro:conversation_id"] = state.conversationId;
  metadata["kiro:root_conversation_id"] = state.rootConversationId;
  metadata["kiro:agent_continuation_id"] = state.agentContinuationId;

  const responsesInput: KiroResponsesInputItem[] = [];
  for (const turn of input.conversation.turns) {
    responsesInput.push(...turnToResponsesInput(turn, input.userTurnPrefix));
  }

  const tools = responsesTools(input.tools);
  const reasoning = reasoningField(input.additionalModelRequestFields);
  return {
    model: input.modelId,
    input: withSystemPrompt(responsesInput, input.conversation.systemPrompt),
    ...(tools ? { tools } : {}),
    stream: true,
    origin: input.origin ?? KIRO_CLI_ORIGIN,
    ...(input.profileArn ? { profileArn: input.profileArn } : {}),
    metadata,
    ...(reasoning ? { reasoning } : {}),
  };
}

export interface KiroRuntimeHeaderInput {
  accessToken: string;
  profileArn?: string | undefined;
  origin?: string | undefined;
  tokenType?: string | undefined;
  userAgent?: string | undefined;
  contentCollectionEnabled?: boolean | undefined;
  /** `false` for the non-SigV4 `q.*` host, which takes a plain JSON content type. */
  awsTarget?: boolean | undefined;
}

export function kiroCreateResponseHeaders(
  input: KiroRuntimeHeaderInput,
): Record<string, string> {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${input.accessToken}`,
    "x-amzn-kiro-origin": input.origin ?? KIRO_CLI_ORIGIN,
    "x-amzn-codewhisperer-optout": input.contentCollectionEnabled ? "false" : "true",
    ...(input.profileArn ? { "x-amzn-kiro-profile": input.profileArn } : {}),
    ...(input.tokenType ? { TokenType: input.tokenType } : {}),
    ...(input.userAgent ? { "User-Agent": input.userAgent } : {}),
  };
}

export function kiroLegacyHeaders(input: KiroRuntimeHeaderInput): Record<string, string> {
  const userAgent = input.userAgent ?? kiroCliUserAgent();
  return {
    "Content-Type": input.awsTarget === false
      ? "application/json"
      : "application/x-amz-json-1.0",
    Accept: "application/vnd.amazon.eventstream",
    "Amz-Sdk-Request": "attempt=1; max=3",
    "Amz-Sdk-Invocation-Id": randomUUID(),
    "User-Agent": userAgent,
    "X-Amz-User-Agent": userAgent,
    "x-amzn-kiro-origin": input.origin ?? KIRO_CLI_ORIGIN,
    "x-amzn-codewhisperer-optout": input.contentCollectionEnabled ? "false" : "true",
    ...(input.awsTarget === false
      ? {}
      : { "X-Amz-Target": "AmazonCodeWhispererStreamingService.GenerateAssistantResponse" }),
    ...(input.profileArn ? { "x-amzn-kiro-profile": input.profileArn } : {}),
    ...(input.tokenType ? { TokenType: input.tokenType } : {}),
    Authorization: `Bearer ${input.accessToken}`,
  };
}
