import type {
  ChatMessage,
  CompletionRequestPurpose,
  NativeToolCall,
  ReasoningArtifactReplayObserver,
  ReasoningArtifactReplayTarget,
  ReasoningPreference,
  ToolDefinition,
} from "../types.js";
import { toWireName } from "./tool-protocol.js";
import {
  reasoningArtifactItems,
  reasoningArtifactsForMessage,
  selectReasoningArtifactsForReplay,
} from "./reasoning-artifacts.js";
import { compileRequestPlan } from "./request-plan.js";
import type { RequestPlanV1 } from "./request-plan.js";
import type { ResponsesDialectConfig } from "./responses-config.js";

interface ResponsesReplayOptions {
  readonly target: ReasoningArtifactReplayTarget;
  readonly observe?: ReasoningArtifactReplayObserver | undefined;
}

interface ReplayArtifactEntry {
  items: Array<Record<string, unknown>>;
  toolCallIndex?: number | undefined;
}

export interface BuildResponsesBodyOptions {
  model: string;
  messages: ChatMessage[];
  maxTokens?: number | undefined;
  temperature?: number | undefined;
  stream: boolean;
  reasoning?: ReasoningPreference | undefined;
  tools?: ToolDefinition[] | undefined;
  parallelToolCalls?: boolean | undefined;
  purpose?: CompletionRequestPurpose | undefined;
  reasoningArtifactReplayObserver?: ReasoningArtifactReplayObserver | undefined;
}

function responsesReplayArtifacts(
  message: ChatMessage,
  replay: ResponsesReplayOptions,
): ReplayArtifactEntry[] {
  return selectReasoningArtifactsForReplay({
    artifacts: reasoningArtifactsForMessage(message),
    target: replay.target,
    context: { hasToolCalls: Boolean(message.toolCalls?.length) },
    observe: replay.observe,
  })
    .filter((artifact) => artifact.kind === "encrypted")
    .sort((left, right) => left.position.sequence - right.position.sequence)
    .map((artifact) => {
      const byId = artifact.position.toolCallId
        ? message.toolCalls?.findIndex(
            (toolCall) => toolCall.id === artifact.position.toolCallId,
          )
        : undefined;
      const toolCallIndex =
        artifact.position.toolCallIndex ??
        (byId !== undefined && byId >= 0 ? byId : undefined);
      return {
        items: reasoningArtifactItems(artifact),
        ...(toolCallIndex === undefined ? {} : { toolCallIndex }),
      };
    });
}

function appendReplayItems(
  input: Array<Record<string, unknown>>,
  entries: readonly { items: Array<Record<string, unknown>> }[],
): void {
  for (const entry of entries) input.push(...entry.items);
}

function systemInputItem(message: ChatMessage): Record<string, unknown> {
  return {
    type: "message",
    role: "system",
    content: [{ type: "input_text", text: message.content }],
  };
}

function toolInputItem(message: ChatMessage): Record<string, unknown> {
  return {
    type: "function_call_output",
    call_id: message.toolCallId ?? `call_${Date.now()}`,
    output: message.content,
  };
}

function appendUserImageBlock(
  blocks: Array<Record<string, unknown>>,
  img: NonNullable<ChatMessage["images"]>[number],
): void {
  const mt = (img.mediaType || "").toLowerCase();
  const dataUrl = `data:${img.mediaType};base64,${img.dataBase64}`;
  if (mt === "application/pdf") {
    const filename = img.path
      ? img.path.split("/").pop() || "document.pdf"
      : "document.pdf";
    blocks.push({ type: "input_file", filename, file_data: dataUrl });
    return;
  }
  if (mt.startsWith("video/")) {
    blocks.push({ type: "input_video", video_url: dataUrl });
    return;
  }
  if (mt.startsWith("audio/")) {
    blocks.push({
      type: "input_audio",
      input_audio: {
        data: img.dataBase64,
        format: mt.includes("wav") ? "wav" : "mp3",
      },
    } as unknown as Record<string, unknown>);
    return;
  }
  blocks.push({ type: "input_image", image_url: dataUrl, detail: "high" });
}

function appendUserInput(
  input: Array<Record<string, unknown>>,
  message: ChatMessage,
  supportsVision: boolean,
): void {
  const blocks: Array<Record<string, unknown>> = [];
  if (message.content) blocks.push({ type: "input_text", text: message.content });
  if (supportsVision && message.images && message.images.length > 0) {
    for (const img of message.images) appendUserImageBlock(blocks, img);
  }
  if (blocks.length === 0) blocks.push({ type: "input_text", text: "" });
  input.push({ type: "message", role: "user", content: blocks });
}

function groupArtifactsByTool(
  replayArtifacts: readonly ReplayArtifactEntry[],
): Map<number, ReplayArtifactEntry[]> {
  const artifactsByTool = new Map<number, ReplayArtifactEntry[]>();
  for (const artifact of replayArtifacts) {
    if (artifact.toolCallIndex === undefined) continue;
    const current = artifactsByTool.get(artifact.toolCallIndex) ?? [];
    current.push(artifact);
    artifactsByTool.set(artifact.toolCallIndex, current);
  }
  return artifactsByTool;
}

function appendAssistantToolTurn(
  input: Array<Record<string, unknown>>,
  message: ChatMessage,
  replayArtifacts: readonly ReplayArtifactEntry[],
): void {
  const leadingArtifacts = replayArtifacts.filter(
    (artifact) => artifact.toolCallIndex === undefined,
  );
  const artifactsByTool = groupArtifactsByTool(replayArtifacts);
  appendReplayItems(input, leadingArtifacts);
  if (message.content && message.content.trim()) {
    input.push({
      type: "message",
      role: "assistant",
      phase: "commentary",
      content: [{ type: "output_text", text: message.content }],
    });
  }
  for (const [toolCallIndex, tc] of message.toolCalls!.entries()) {
    appendReplayItems(input, artifactsByTool.get(toolCallIndex) ?? []);
    input.push({
      type: "function_call",
      call_id: tc.id,
      name: toWireName(tc.name),
      arguments: tc.rawArguments ?? JSON.stringify(tc.args ?? {}),
    });
  }
}

function appendAssistantInput(
  input: Array<Record<string, unknown>>,
  message: ChatMessage,
  replay: ResponsesReplayOptions,
): void {
  const replayArtifacts = responsesReplayArtifacts(message, replay);
  if (message.toolCalls && message.toolCalls.length > 0) {
    appendAssistantToolTurn(input, message, replayArtifacts);
    return;
  }
  appendReplayItems(input, replayArtifacts);
  if (message.content !== undefined && message.content !== null) {
    input.push({
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: message.content }],
    });
  }
}

function toResponsesInput(
  messages: ChatMessage[],
  supportsVision: boolean,
  replay: ResponsesReplayOptions,
): Array<Record<string, unknown>> {
  const input: Array<Record<string, unknown>> = [];
  for (const message of messages) {
    if (message.role === "system") {
      input.push(systemInputItem(message));
    } else if (message.role === "user") {
      appendUserInput(input, message, supportsVision);
    } else if (message.role === "assistant") {
      appendAssistantInput(input, message, replay);
    } else if (message.role === "tool") {
      input.push(toolInputItem(message));
    }
  }
  return input;
}

function toResponsesTools(
  tools: ToolDefinition[] | undefined,
): Array<Record<string, unknown>> | undefined {
  if (!tools || tools.length === 0) return undefined;
  return tools.map((t) => ({
    type: "function",
    name: t.wireName,
    description: t.description,
    parameters: t.parameters,
  }));
}

function responsesMaxOutputTokens(plan: RequestPlanV1): number {
  const reasoningOn = Boolean(plan.controls.reasoning?.enabled);
  const defaultMax = reasoningOn ? 8192 : 4096;
  const requestedMax = Math.max(16, plan.controls.requestedMaxTokens ?? defaultMax);
  return plan.policy.limits.outputTokens === undefined
    ? requestedMax
    : Math.min(requestedMax, plan.policy.limits.outputTokens);
}

function applyResponsesTools(
  body: Record<string, unknown>,
  tools: Array<Record<string, unknown>> | undefined,
  parallelToolCalls: boolean | undefined,
): void {
  if (!tools) return;
  body.tools = tools;
  body.tool_choice = "auto";
  body.parallel_tool_calls = parallelToolCalls === false ? false : true;
}

export function buildResponsesBody(
  config: ResponsesDialectConfig,
  options: BuildResponsesBodyOptions,
): string {
  const plan = compileRequestPlan({
    provider: config.providerId,
    model: options.model,
    messages: options.messages,
    stream: options.stream,
    endpoint: config.baseUrl,
    reasoning: options.reasoning,
    tools: options.tools,
    parallelToolCalls: options.parallelToolCalls,
    temperature: options.temperature,
    maxTokens: options.maxTokens,
  });
  const reasoning = config.reasoningPayload(plan.controls.reasoning);
  const input = toResponsesInput([...plan.timeline.messages], plan.images.visionAccepted, {
    target: plan.replay.target,
    observe: options.reasoningArtifactReplayObserver,
  });
  const tools = toResponsesTools(
    plan.tools.definitions.length ? [...plan.tools.definitions] : undefined,
  );
  const body: Record<string, unknown> = { model: options.model, input };
  Object.assign(
    body,
    config.bodyExtras({
      model: options.model,
      messages: options.messages,
      purpose: options.purpose,
      reasoningEnabled: Boolean(plan.controls.reasoning?.enabled),
    }),
  );
  body.max_output_tokens = responsesMaxOutputTokens(plan);
  body.temperature = plan.controls.temperature;
  if (plan.controls.topP !== undefined) body.top_p = plan.controls.topP;
  if (reasoning) body.reasoning = reasoning;
  if (options.stream) body.stream = true;
  applyResponsesTools(body, tools, options.parallelToolCalls);
  return JSON.stringify(body);
}
