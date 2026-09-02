import type { NativeToolCall } from "../../types.js";
import {
  fromWireName,
  MAX_TOOL_ARG_BYTES,
  parseToolArguments,
  syntheticToolCallId,
} from "../tool-protocol.js";
import type {
  AnthropicStreamBlock,
  AnthropicThinkingBlock,
  AnthropicToolStreamState,
} from "./anthropic-tools.js";

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

export function finalizeAnthropicToolStream(state: AnthropicToolStreamState): {
  text: string;
  thinkingText: string;
  thinkingBlocks: AnthropicThinkingBlock[];
  toolCalls: NativeToolCall[];
  thinkingSignature?: string;
} {
  const toolCalls: NativeToolCall[] = [];
  const thinkingBlocks: Array<Omit<AnthropicThinkingBlock, "toolCallIndex">> =
    [];
  const toolCallSequences: Array<{ sequence: number; toolCallIndex: number }> =
    [];
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
