import {
  isInternalChatMessage,
  type ChatMessage,
  type NativeToolCall,
  type ReasoningArtifact,
  type ReasoningArtifactReplayObserver,
  type ReasoningArtifactReplayTarget,
  type ToolDefinition,
} from "../../types.js";
import {
  reasoningArtifactSignature,
  reasoningArtifactText,
  reasoningArtifactsForMessage,
  selectReasoningArtifactsForReplay,
} from "../reasoning-artifacts.js";
import {
  fromWireName,
  mapToolChoiceToAnthropic,
  parseToolArguments,
  syntheticToolCallId,
  toWireName,
  type ToolChoice,
  MAX_TOOL_ARG_BYTES,
} from "../tool-protocol.js";
// Side-effect: register wire name map before fromWireName use.
import "../../tools/definitions.js";
import { normalizeSystemMessages } from "../system-messages.js";

export function toAnthropicTools(defs: ToolDefinition[]): Array<{
  name: string;
  description: string;
  input_schema: ToolDefinition["parameters"];
}> {
  return defs.map((d) => ({
    name: d.wireName,
    description: d.description,
    input_schema: d.parameters,
  }));
}

type AnthropicContentBlock =
  | { type: "text"; text: string }
  | ({ type: "thinking"; thinking: string; signature: string } & Record<string, unknown>)
  | {
      type: "image";
      source: { type: "base64"; media_type: string; data: string };
    }
  | {
      type: "tool_use";
      id: string;
      name: string;
      input: Record<string, unknown>;
    }
  | {
      type: "tool_result";
      tool_use_id: string;
      content: string;
      is_error?: boolean;
    };

function thinkingBlockFromArtifact(
  artifact: ReasoningArtifact,
): AnthropicContentBlock | undefined {
  if (artifact.kind !== "signed") return undefined;
  const thinking = reasoningArtifactText(artifact);
  const signature = reasoningArtifactSignature(artifact);
  if (!thinking || !signature) return undefined;
  if (
    artifact.raw &&
    typeof artifact.raw === "object" &&
    !Array.isArray(artifact.raw)
  ) {
    return {
      ...(artifact.raw as Record<string, unknown>),
      type: "thinking",
      thinking,
      signature,
    } as AnthropicContentBlock;
  }
  return { type: "thinking", thinking, signature };
}

interface AnthropicReasoningReplayOptions {
  readonly target: ReasoningArtifactReplayTarget;
  readonly observe?: ReasoningArtifactReplayObserver | undefined;
  readonly cacheConversation?: boolean | undefined;
}

function conversationCacheTarget(
  messages: readonly ChatMessage[],
): ChatMessage | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (message.role !== "system" && !isInternalChatMessage(message)) {
      return message;
    }
  }
  return undefined;
}

function withConversationCacheBreakpoint(
  content: string | AnthropicContentBlock[],
): string | AnthropicContentBlock[] {
  if (typeof content === "string") {
    if (!content.trim()) return content;
    return [
      {
        type: "text",
        text: content,
        cache_control: { type: "ephemeral" },
      } as AnthropicContentBlock,
    ];
  }
  let target = content.length - 1;
  while (
    target >= 0 &&
    (content[target]!.type === "thinking" ||
      (content[target]!.type === "text" &&
        !(content[target] as { text: string }).text.trim()))
  ) {
    target -= 1;
  }
  if (target < 0) return content;
  const blocks = [...content];
  blocks[target] = {
    ...blocks[target]!,
    cache_control: { type: "ephemeral" },
  } as AnthropicContentBlock;
  return blocks;
}

function assistantThinkingArtifacts(
  message: ChatMessage,
  replay?: AnthropicReasoningReplayOptions,
): Array<{
  block: AnthropicContentBlock;
  toolCallIndex?: number | undefined;
}> {
  if (!replay) return [];
  return [
    ...selectReasoningArtifactsForReplay({
      artifacts: reasoningArtifactsForMessage(message),
      target: replay.target,
      context: { hasToolCalls: Boolean(message.toolCalls?.length) },
      observe: replay.observe,
    }),
  ]
    .sort((left, right) => left.position.sequence - right.position.sequence)
    .flatMap((artifact) => {
      const block = thinkingBlockFromArtifact(artifact);
      if (!block) return [];
      const byId = artifact.position.toolCallId
        ? message.toolCalls?.findIndex(
            (toolCall) => toolCall.id === artifact.position.toolCallId,
          )
        : undefined;
      const toolCallIndex =
        artifact.position.toolCallIndex ??
        (byId !== undefined && byId >= 0 ? byId : undefined);
      return [{ block, ...(toolCallIndex === undefined ? {} : { toolCallIndex }) }];
    });
}

/**
 * Convert dialect-neutral history to Anthropic Messages API messages.
 * The first system message is owned by the top-level `system` field; later
 * System messages become marked user turns in place. Consecutive
 * tool results collapse into one user turn.
 */
export function toAnthropicToolMessages(
  messages: ChatMessage[],
  replay?: AnthropicReasoningReplayOptions,
): Array<{ role: "user" | "assistant"; content: string | AnthropicContentBlock[] }> {
  const out: Array<{
    role: "user" | "assistant";
    content: string | AnthropicContentBlock[];
  }> = [];
  const cacheTarget = replay?.cacheConversation
    ? conversationCacheTarget(messages)
    : undefined;
  const push = (
    source: ChatMessage,
    role: "user" | "assistant",
    content: string | AnthropicContentBlock[],
  ): void => {
    out.push({
      role,
      content:
        source === cacheTarget
          ? withConversationCacheBreakpoint(content)
          : content,
    });
  };

  let i = 0;
  const nonSystem = normalizeSystemMessages(messages).rest;

  while (i < nonSystem.length) {
    const message = nonSystem[i]!;

    if (message.role === "tool") {
      const blocks: AnthropicContentBlock[] = [];
      let source = message;
      while (i < nonSystem.length && nonSystem[i]!.role === "tool") {
        const tr = nonSystem[i]!;
        source = tr;
        blocks.push({
          type: "tool_result",
          tool_use_id: tr.toolCallId ?? "",
          content: tr.content,
          is_error:
            tr.ok === false ||
            (tr.ok !== true && /\bok=false\b/i.test(tr.content)),
        });
        i += 1;
      }
      push(source, "user", blocks);
      continue;
    }

    if (message.role === "assistant" && message.toolCalls?.length) {
      const blocks: AnthropicContentBlock[] = [];
      const thinkingArtifacts = assistantThinkingArtifacts(message, replay);
      const leadingArtifacts = thinkingArtifacts.filter(
        (artifact) => artifact.toolCallIndex === undefined,
      );
      const artifactsByTool = new Map<number, AnthropicContentBlock[]>();
      for (const artifact of thinkingArtifacts) {
        if (artifact.toolCallIndex === undefined) continue;
        const current = artifactsByTool.get(artifact.toolCallIndex) ?? [];
        current.push(artifact.block);
        artifactsByTool.set(artifact.toolCallIndex, current);
      }
      blocks.push(...leadingArtifacts.map((artifact) => artifact.block));
      blocks.push(...(artifactsByTool.get(0) ?? []));
      if (message.content.trim()) {
        blocks.push({ type: "text", text: message.content });
      }
      for (const [toolCallIndex, tc] of message.toolCalls.entries()) {
        if (toolCallIndex > 0) {
          blocks.push(...(artifactsByTool.get(toolCallIndex) ?? []));
        }
        blocks.push({
          type: "tool_use",
          id: tc.id,
          name: toWireName(tc.name),
          input: tc.args ?? {},
        });
      }
      push(message, "assistant", blocks);
      i += 1;
      continue;
    }

    if (message.role === "user" && message.images?.length) {
      const blocks: AnthropicContentBlock[] = [];
      if (message.content) {
        blocks.push({ type: "text", text: message.content });
      }
      for (const img of message.images) {
        blocks.push({
          type: "image",
          source: {
            type: "base64",
            media_type: img.mediaType,
            data: img.dataBase64,
          },
        });
      }
      push(message, "user", blocks);
      i += 1;
      continue;
    }

    const role = message.role === "assistant" ? "assistant" : "user";
    push(message, role, message.content);
    i += 1;
  }

  return out;
}

export function anthropicToolBodyFields(options: {
  tools?: ToolDefinition[] | undefined;
  toolChoice?: ToolChoice | undefined;
}): Record<string, unknown> {
  if (!options.tools?.length) return {};
  return {
    tools: toAnthropicTools(options.tools),
    tool_choice: mapToolChoiceToAnthropic(options.toolChoice),
  };
}

export interface AnthropicThinkingBlock {
  readonly sequence: number;
  readonly thinking: string;
  readonly signature?: string | undefined;
  readonly raw: Record<string, unknown>;
  readonly toolCallIndex?: number | undefined;
}

type AnthropicWireContentBlock = {
  type: string;
  text?: string;
  thinking?: string;
  signature?: string;
  id?: string;
  name?: string;
  input?: unknown;
  [key: string]: unknown;
};

export function parseAnthropicToolUseBlocks(
  content: AnthropicWireContentBlock[] | undefined,
): {
  text: string;
  thinkingText: string;
  thinkingBlocks: AnthropicThinkingBlock[];
  toolCalls: NativeToolCall[];
  thinkingSignature?: string;
} {
  let text = "";
  let thinkingText = "";
  let thinkingSignature: string | undefined;
  const toolCalls: NativeToolCall[] = [];
  const thinkingBlocks: Array<Omit<AnthropicThinkingBlock, "toolCallIndex">> = [];
  const toolCallSequences: Array<{ sequence: number; toolCallIndex: number }> = [];
  if (!content) return { text, thinkingText, thinkingBlocks, toolCalls };

  for (const [sequence, part] of content.entries()) {
    if (part.type === "text" && part.text) text += part.text;
    if (part.type === "thinking") {
      const thinking = typeof part.thinking === "string" ? part.thinking : "";
      if (thinking) thinkingText += thinking;
      if (typeof part.signature === "string" && part.signature) {
        thinkingSignature = part.signature;
      }
      thinkingBlocks.push({
        sequence,
        thinking,
        ...(typeof part.signature === "string" && part.signature
          ? { signature: part.signature }
          : {}),
        raw: { ...part },
      });
    }
    if (part.type === "tool_use") {
      const wire = part.name ?? "";
      const input = part.input;
      const args =
        input && typeof input === "object" && !Array.isArray(input)
          ? (input as Record<string, unknown>)
          : parseToolArguments(
              typeof input === "string" ? input : JSON.stringify(input ?? {}),
            );
      const toolCallIndex = toolCalls.length;
      toolCalls.push({
        id: part.id ?? syntheticToolCallId(toolCallIndex),
        name: fromWireName(wire) ?? wire,
        args,
      });
      toolCallSequences.push({ sequence, toolCallIndex });
    }
  }
  const positionedThinkingBlocks = thinkingBlocks.map((block) => {
    const followingTool = toolCallSequences.find(
      (toolCall) => toolCall.sequence > block.sequence,
    );
    return followingTool
      ? { ...block, toolCallIndex: followingTool.toolCallIndex }
      : block;
  });
  return {
    text: text.trim(),
    thinkingText: thinkingText.trim(),
    thinkingBlocks: positionedThinkingBlocks,
    toolCalls,
    ...(thinkingSignature ? { thinkingSignature } : {}),
  };
}

interface AnthropicStreamBlock {
  kind: "text" | "thinking" | "tool_use";
  id?: string;
  name?: string;
  json: string;
  text: string;
  signature: string;
}

export interface AnthropicToolStreamState {
  text: string;
  thinking: string;
  /** Anthropic `signature_delta` for the thinking block. */
  thinkingSignature: string;
  /** block index → partial content block */
  blocks: Map<number, AnthropicStreamBlock>;
}

export function createAnthropicToolStreamState(): AnthropicToolStreamState {
  return { text: "", thinking: "", thinkingSignature: "", blocks: new Map() };
}

export function handleAnthropicStreamEvent(
  state: AnthropicToolStreamState,
  event: {
    type?: string;
    index?: number;
    content_block?: {
      type?: string;
      id?: string;
      name?: string;
      text?: string;
      thinking?: string;
      signature?: string;
    };
    delta?: {
      type?: string;
      text?: string;
      thinking?: string;
      partial_json?: string;
      signature?: string;
    };
  },
): {
  textDelta?: string;
  thinkingDelta?: string;
  toolCallDelta?: {
    index: number;
    id?: string;
    name?: string;
    argumentsBytes?: number;
    nameBecameKnown?: boolean;
  };
} {
  const result: {
    textDelta?: string;
    thinkingDelta?: string;
    toolCallDelta?: {
      index: number;
      id?: string;
      name?: string;
      argumentsBytes?: number;
      nameBecameKnown?: boolean;
    };
  } = {};

  if (event.type === "content_block_start" && event.content_block) {
    const index = event.index ?? 0;
    const cb = event.content_block;
    if (cb.type === "tool_use") {
      const block: AnthropicStreamBlock = {
        kind: "tool_use",
        json: "",
        text: "",
        signature: "",
      };
      if (cb.id !== undefined) block.id = cb.id;
      if (cb.name !== undefined) block.name = cb.name;
      state.blocks.set(index, block);
      if (cb.name) {
        result.toolCallDelta = {
          index,
          ...(cb.id !== undefined ? { id: cb.id } : {}),
          name: fromWireName(cb.name) ?? cb.name,
          argumentsBytes: 0,
          nameBecameKnown: true,
        };
      }
    } else if (cb.type === "text") {
      state.blocks.set(index, {
        kind: "text",
        json: "",
        text: cb.text ?? "",
        signature: "",
      });
      if (cb.text) state.text += cb.text;
    } else if (cb.type === "thinking") {
      const thinking = cb.thinking ?? "";
      const signature = cb.signature ?? "";
      state.blocks.set(index, {
        kind: "thinking",
        json: "",
        text: thinking,
        signature,
      });
      state.thinking += thinking;
      state.thinkingSignature += signature;
    }
  }

  if (event.type === "content_block_delta" && event.delta) {
    const index = event.index ?? 0;
    let block = state.blocks.get(index);
    if (!block) {
      block = { kind: "text", json: "", text: "", signature: "" };
      state.blocks.set(index, block);
    }
    if (event.delta.type === "text_delta" && event.delta.text) {
      block.text += event.delta.text;
      state.text += event.delta.text;
      result.textDelta = event.delta.text;
    }
    if (event.delta.type === "thinking_delta" && event.delta.thinking) {
      block.text += event.delta.thinking;
      state.thinking += event.delta.thinking;
      result.thinkingDelta = event.delta.thinking;
    }
    if (event.delta.type === "signature_delta" && event.delta.signature) {
      block.signature += event.delta.signature;
      state.thinkingSignature += event.delta.signature;
    }
    if (
      event.delta.type === "input_json_delta" &&
      typeof event.delta.partial_json === "string"
    ) {
      block.json += event.delta.partial_json;
      if (block.json.length > MAX_TOOL_ARG_BYTES) {
        throw new Error(
          `Tool call arguments exceeded ${MAX_TOOL_ARG_BYTES} bytes — split the file or reduce content size.`,
        );
      }
      if (
        block.kind === "tool_use" &&
        block.json.length > 0 &&
        block.json.length % 4096 < event.delta.partial_json.length
      ) {
        result.toolCallDelta = {
          index,
          ...(block.id !== undefined ? { id: block.id } : {}),
          ...(block.name
            ? { name: fromWireName(block.name) ?? block.name }
            : {}),
          argumentsBytes: block.json.length,
        };
      }
    }
  }

  return result;
}

export function finalizeAnthropicToolStream(
  state: AnthropicToolStreamState,
): {
  text: string;
  thinkingText: string;
  thinkingBlocks: AnthropicThinkingBlock[];
  toolCalls: NativeToolCall[];
  thinkingSignature?: string;
} {
  const toolCalls: NativeToolCall[] = [];
  const thinkingBlocks: Array<Omit<AnthropicThinkingBlock, "toolCallIndex">> = [];
  const toolCallSequences: Array<{ sequence: number; toolCallIndex: number }> = [];
  const indices = [...state.blocks.keys()].sort((a, b) => a - b);
  for (const index of indices) {
    const block = state.blocks.get(index)!;
    if (block.kind === "thinking") {
      thinkingBlocks.push({
        sequence: index,
        thinking: block.text,
        ...(block.signature ? { signature: block.signature } : {}),
        raw: {
          type: "thinking",
          thinking: block.text,
          ...(block.signature ? { signature: block.signature } : {}),
        },
      });
      continue;
    }
    if (block.kind !== "tool_use") continue;
    const wire = block.name ?? "";
    const args = parseToolArguments(block.json);
    const toolCallIndex = toolCalls.length;
    toolCalls.push({
      id: block.id ?? syntheticToolCallId(index),
      name: fromWireName(wire) ?? wire,
      args,
      ...(block.json ? { rawArguments: block.json } : {}),
    });
    toolCallSequences.push({ sequence: index, toolCallIndex });
  }
  const positionedThinkingBlocks = thinkingBlocks.map((block) => {
    const followingTool = toolCallSequences.find(
      (toolCall) => toolCall.sequence > block.sequence,
    );
    return followingTool
      ? { ...block, toolCallIndex: followingTool.toolCallIndex }
      : block;
  });
  return {
    text: state.text.trim(),
    thinkingText: state.thinking.trim(),
    thinkingBlocks: positionedThinkingBlocks,
    toolCalls,
    ...(state.thinkingSignature
      ? { thinkingSignature: state.thinkingSignature }
      : {}),
  };
}
